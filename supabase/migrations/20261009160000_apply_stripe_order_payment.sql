-- Mark an order Paid only when a verified Stripe webhook asks for it.
-- The Worker checks the Stripe signature first. This function is the database
-- guard: amount, currency, cancellation, and duplicate event ids.
-- Run it in the Supabase SQL editor for the Lumina project before relying on
-- the live webhook. It is not applied automatically by this repository.

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  order_id uuid,
  outcome text not null,
  received_at timestamp with time zone not null default pg_catalog.clock_timestamp()
);

alter table public.stripe_webhook_events enable row level security;
revoke all on table public.stripe_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_webhook_events to service_role;

create or replace function public.apply_stripe_order_payment(
  p_event_id text,
  p_event_type text,
  p_requested_outcome text,
  p_order_id uuid,
  p_order_reference text,
  p_amount_pence integer,
  p_currency text,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_note text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_reference text;
  v_status text;
  v_expected_pence integer;
  v_outcome text;
  v_mark_paid boolean := false;
  v_update_details boolean := true;
  v_meta jsonb;
begin
  if p_event_id is null
     or pg_catalog.btrim(p_event_id) = ''
     or pg_catalog.length(p_event_id) > 255 then
    raise exception 'A Stripe event id is required.';
  end if;

  if p_requested_outcome not in ('paid', 'failed', 'expired', 'unpaid') then
    raise exception 'Unsupported Stripe payment outcome.';
  end if;

  if exists (
    select 1
    from public.stripe_webhook_events
    where event_id = p_event_id
  ) then
    return pg_catalog.jsonb_build_object(
      'status', 'already_processed',
      'order_id', (
        select order_id
        from public.stripe_webhook_events
        where event_id = p_event_id
      )
    );
  end if;

  v_reference := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_order_reference, ''))), '');

  if p_order_id is not null then
    select * into v_order
    from public."Orders"
    where id = p_order_id
    for update;
  elsif v_reference is not null then
    select * into v_order
    from public."Orders"
    where pg_catalog.upper(reference) = v_reference
    for update;
  else
    raise exception 'Order not found for Stripe payment.'
      using errcode = 'P0002';
  end if;

  if not found then
    raise exception 'Order not found for Stripe payment.'
      using errcode = 'P0002';
  end if;

  v_status := pg_catalog.lower(coalesce(v_order.status, ''));
  v_expected_pence := pg_catalog.round(coalesce(v_order.total_amount, 0) * 100)::integer;
  v_outcome := p_requested_outcome;

  if v_reference is not null
     and pg_catalog.upper(coalesce(v_order.reference, '')) is distinct from v_reference then
    v_outcome := 'reference_mismatch';
  elsif p_requested_outcome = 'paid' and v_status = 'cancelled' then
    v_outcome := 'cancelled';
  elsif p_requested_outcome = 'paid' and v_status in ('paid', 'packed', 'shipped') then
    v_outcome := 'already_paid';
    v_update_details := false;
  elsif p_requested_outcome = 'paid'
        and (
          pg_catalog.lower(coalesce(p_currency, '')) is distinct from 'gbp'
          or p_amount_pence is distinct from v_expected_pence
        ) then
    v_outcome := 'amount_mismatch';
  elsif p_requested_outcome = 'paid' then
    v_outcome := 'paid';
    v_mark_paid := true;
  elsif v_status in ('paid', 'packed', 'shipped', 'cancelled') then
    v_outcome := 'ignored_' || v_status;
    v_update_details := false;
  end if;

  if v_update_details then
    v_meta := coalesce(v_order.details, '{}'::jsonb);
    v_meta := pg_catalog.jsonb_set(
      v_meta,
      '{meta}',
      coalesce(v_meta->'meta', '{}'::jsonb) || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'stripe_payment_state', v_outcome,
        'stripe_event_id', p_event_id,
        'stripe_event_type', nullif(p_event_type, ''),
        'stripe_checkout_session_id', nullif(p_checkout_session_id, ''),
        'stripe_payment_intent_id', nullif(p_payment_intent_id, ''),
        'stripe_amount_pence', p_amount_pence,
        'stripe_currency', nullif(pg_catalog.lower(coalesce(p_currency, '')), ''),
        'stripe_recorded_at', pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
        'stripe_note', nullif(p_note, '')
      )),
      true
    );

    if v_mark_paid then
      update public."Orders"
      set status = 'Paid',
          details = v_meta
      where id = v_order.id;
    else
      update public."Orders"
      set details = v_meta
      where id = v_order.id;
    end if;
  end if;

  insert into public.stripe_webhook_events (event_id, event_type, order_id, outcome)
  values (p_event_id, coalesce(p_event_type, ''), v_order.id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status', case when v_mark_paid then 'paid' else 'recorded' end,
    'outcome', v_outcome,
    'order_id', v_order.id,
    'order_status', case when v_mark_paid then 'Paid' else v_order.status end,
    'marked_paid', v_mark_paid
  );
exception
  when unique_violation then
    return pg_catalog.jsonb_build_object(
      'status', 'already_processed',
      'order_id', v_order.id
    );
end;
$function$;

revoke execute on function public.apply_stripe_order_payment(
  text, text, text, uuid, text, integer, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.apply_stripe_order_payment(
  text, text, text, uuid, text, integer, text, text, text, text
) to service_role;

create or replace function public.attach_stripe_checkout_session(
  p_order_id uuid,
  p_order_reference text,
  p_session_id text,
  p_session_url text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_meta jsonb;
begin
  if p_order_id is null
     or p_session_id is null
     or p_session_url is null
     or pg_catalog.btrim(p_session_id) = ''
     or pg_catalog.btrim(p_session_url) = '' then
    raise exception 'A pending order and Stripe Checkout session are required.';
  end if;

  select * into v_order
  from public."Orders"
  where id = p_order_id
    and pg_catalog.upper(reference) = pg_catalog.upper(pg_catalog.btrim(p_order_reference))
  for update;

  if not found then
    raise exception 'Order not found for Stripe Checkout.'
      using errcode = 'P0002';
  end if;

  if pg_catalog.lower(coalesce(v_order.status, '')) <> 'pending' then
    return pg_catalog.jsonb_build_object(
      'attached', false,
      'status', v_order.status
    );
  end if;

  v_meta := coalesce(v_order.details, '{}'::jsonb);
  v_meta := pg_catalog.jsonb_set(
    v_meta,
    '{meta}',
    coalesce(v_meta->'meta', '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'stripe_checkout_session_id', p_session_id,
      'stripe_checkout_url', p_session_url
    ),
    true
  );

  update public."Orders"
  set details = v_meta
  where id = v_order.id;

  return pg_catalog.jsonb_build_object(
    'attached', true,
    'status', v_order.status
  );
end;
$function$;

revoke execute on function public.attach_stripe_checkout_session(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.attach_stripe_checkout_session(uuid, text, text, text)
  to service_role;
