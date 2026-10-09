-- Mark a pending order Paid when a verified Payment Link webhook names that
-- order and the amount matches. Run this in the live Supabase SQL editor
-- before relying on the webhook. It is not applied by this pull request.

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

create or replace function public.apply_payment_link_event(
  p_event_id text,
  p_event_type text,
  p_order_reference text,
  p_amount_pence integer,
  p_currency text,
  p_payment_status text,
  p_checkout_session_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_order_id uuid;
  v_reference text;
  v_count integer;
  v_status text;
  v_expected_pence integer;
  v_outcome text;
  v_mark_paid boolean := false;
  v_note_mismatch boolean := false;
  v_meta jsonb;
begin
  if p_event_id is null
     or pg_catalog.btrim(p_event_id) = ''
     or pg_catalog.length(p_event_id) > 255
     or p_event_type not in (
       'checkout.session.completed',
       'checkout.session.async_payment_succeeded'
     ) then
    raise exception 'A Payment Link event is required.';
  end if;

  if exists (
    select 1 from public.stripe_webhook_events where event_id = p_event_id
  ) then
    return pg_catalog.jsonb_build_object(
      'status', 'already_processed',
      'outcome', (
        select outcome from public.stripe_webhook_events where event_id = p_event_id
      )
    );
  end if;

  v_reference := pg_catalog.upper(pg_catalog.btrim(coalesce(p_order_reference, '')));
  v_outcome := 'unmatched';

  if v_reference ~ '^LW[0-9A-F]{8}$' then
    select count(*) into v_count
    from public."Orders"
    where pg_catalog.upper(reference) = v_reference;

    if v_count = 1 then
      select * into v_order
      from public."Orders"
      where pg_catalog.upper(reference) = v_reference
      for update;
      v_order_id := v_order.id;

      v_status := pg_catalog.lower(coalesce(v_order.status, ''));
      v_expected_pence := pg_catalog.round(coalesce(v_order.total_amount, 0) * 100)::integer;

      if pg_catalog.lower(coalesce(p_payment_status, '')) is distinct from 'paid' then
        v_outcome := 'unpaid';
      elsif v_status is distinct from 'pending' then
        v_outcome := 'not_pending';
      elsif pg_catalog.lower(coalesce(p_currency, '')) is distinct from 'gbp'
            or p_amount_pence is distinct from v_expected_pence then
        v_outcome := 'amount_mismatch';
        v_note_mismatch := true;
      else
        v_outcome := 'paid';
        v_mark_paid := true;
      end if;
    end if;
  end if;

  if v_mark_paid or v_note_mismatch then
    v_meta := coalesce(v_order.details, '{}'::jsonb);
    v_meta := pg_catalog.jsonb_set(
      v_meta,
      '{meta}',
      coalesce(v_meta->'meta', '{}'::jsonb) || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'stripe_payment_state', v_outcome,
        'stripe_event_id', p_event_id,
        'stripe_event_type', p_event_type,
        'stripe_checkout_session_id', nullif(p_checkout_session_id, ''),
        'stripe_amount_pence', p_amount_pence,
        'stripe_currency', nullif(pg_catalog.lower(coalesce(p_currency, '')), ''),
        'stripe_recorded_at', pg_catalog.to_jsonb(pg_catalog.clock_timestamp())
      )),
      true
    );

    update public."Orders"
    set status = case when v_mark_paid then 'Paid' else status end,
        details = v_meta
    where id = v_order.id;
  end if;

  insert into public.stripe_webhook_events (event_id, event_type, order_id, outcome)
  values (p_event_id, p_event_type, v_order_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status', case when v_mark_paid then 'paid' else 'recorded' end,
    'outcome', v_outcome,
    'order_id', v_order_id,
    'marked_paid', v_mark_paid
  );
exception
  when unique_violation then
    return pg_catalog.jsonb_build_object(
      'status', 'already_processed',
      'order_id', v_order_id
    );
end;
$function$;

revoke execute on function public.apply_payment_link_event(text, text, text, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_payment_link_event(text, text, text, integer, text, text, text)
  to service_role;
