-- A Payment Link event for an order that is already cancelled must not mark
-- it Paid. Stock has already gone back. The webhook tells Tim once so he can
-- sort the payment out by hand. A payment that commits first still wins: the
-- order is Paid and the auto-cancel leaves it alone.

create or replace function public.cancelled_payment_needs_alert(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public."Orders" o
    where o.id = p_order_id
      and (
        pg_catalog.lower(coalesce(o.status, '')) = 'cancelled'
        or coalesce(o.details #>> '{meta,restocked_at}', '') <> ''
      )
      and coalesce(o.details #>> '{meta,stripe_paid_after_cancel_alerted_at}', '') = ''
  );
$function$;

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
  v_note_order boolean := false;
  v_alert_admin boolean := false;
  v_meta jsonb;
  v_existing_outcome text;
  v_existing_order_id uuid;
  v_restocked boolean;
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

  select outcome, order_id
  into v_existing_outcome, v_existing_order_id
  from public.stripe_webhook_events
  where event_id = p_event_id;

  if found then
    if v_existing_outcome = 'cancelled_paid' then
      v_alert_admin := public.cancelled_payment_needs_alert(v_existing_order_id);
      select reference into v_reference
      from public."Orders"
      where id = v_existing_order_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'already_processed',
      'outcome', v_existing_outcome,
      'order_id', v_existing_order_id,
      'reference', v_reference,
      'alert_admin', v_alert_admin,
      'marked_paid', false
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
      v_restocked := coalesce(v_order.details #>> '{meta,restocked_at}', '') <> '';
      v_expected_pence := pg_catalog.round(coalesce(v_order.total_amount, 0) * 100)::integer;

      if pg_catalog.lower(coalesce(p_payment_status, '')) is distinct from 'paid' then
        v_outcome := 'unpaid';
      elsif v_status = 'cancelled' or v_restocked then
        v_outcome := 'cancelled_paid';
        v_note_order := true;
        v_alert_admin := coalesce(v_order.details #>> '{meta,stripe_paid_after_cancel_alerted_at}', '') = '';
      elsif v_status is distinct from 'pending' then
        v_outcome := 'not_pending';
      elsif pg_catalog.lower(coalesce(p_currency, '')) is distinct from 'gbp'
            or p_amount_pence is distinct from v_expected_pence then
        v_outcome := 'amount_mismatch';
        v_note_order := true;
      else
        v_outcome := 'paid';
        v_mark_paid := true;
      end if;
    end if;
  end if;

  if v_mark_paid or v_note_order then
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
        'stripe_recorded_at', pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
        'stripe_paid_after_cancel', case when v_outcome = 'cancelled_paid' then true else null end
      )),
      true
    );

    update public."Orders"
    set status = case when v_mark_paid then 'Paid' else status end,
        details = v_meta
    where id = v_order.id
      and (
        v_mark_paid = false
        or (
          pg_catalog.lower(coalesce(status, '')) = 'pending'
          and coalesce(details #>> '{meta,restocked_at}', '') = ''
        )
      );

    if v_mark_paid and not found then
      select * into v_order
      from public."Orders"
      where id = v_order_id;
      v_mark_paid := false;
      v_alert_admin := false;
      if pg_catalog.lower(coalesce(v_order.status, '')) = 'cancelled'
         or coalesce(v_order.details #>> '{meta,restocked_at}', '') <> '' then
        v_outcome := 'cancelled_paid';
        v_alert_admin := public.cancelled_payment_needs_alert(v_order_id);
      else
        v_outcome := 'not_pending';
      end if;
    end if;
  end if;

  insert into public.stripe_webhook_events (event_id, event_type, order_id, outcome)
  values (p_event_id, p_event_type, v_order_id, v_outcome);

  return pg_catalog.jsonb_build_object(
    'status', case when v_mark_paid then 'paid' else 'recorded' end,
    'outcome', v_outcome,
    'order_id', v_order_id,
    'reference', case when v_order_id is null then null else v_reference end,
    'marked_paid', v_mark_paid,
    'alert_admin', v_alert_admin and v_outcome = 'cancelled_paid'
  );
exception
  when unique_violation then
    select outcome, order_id
    into v_existing_outcome, v_existing_order_id
    from public.stripe_webhook_events
    where event_id = p_event_id;
    v_alert_admin := false;
    v_reference := null;
    if v_existing_outcome = 'cancelled_paid' then
      v_alert_admin := public.cancelled_payment_needs_alert(v_existing_order_id);
      select reference into v_reference
      from public."Orders"
      where id = v_existing_order_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'already_processed',
      'outcome', v_existing_outcome,
      'order_id', v_existing_order_id,
      'reference', v_reference,
      'alert_admin', v_alert_admin,
      'marked_paid', false
    );
end;
$function$;

create or replace function public.claim_cancelled_payment_alert(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_meta jsonb;
  v_claimed text;
  v_claimed_at timestamp with time zone;
  v_cancelled boolean;
begin
  select *
  into v_order
  from public."Orders"
  where id = p_order_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('claimed', false);
  end if;

  v_meta := coalesce(v_order.details->'meta', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
    v_meta := '{}'::jsonb;
  end if;

  v_cancelled := pg_catalog.lower(coalesce(v_order.status, '')) = 'cancelled'
    or coalesce(v_meta->>'restocked_at', '') <> '';
  if not v_cancelled
     or coalesce(v_meta->>'stripe_paid_after_cancel_alerted_at', '') <> '' then
    return pg_catalog.jsonb_build_object('claimed', false, 'reference', v_order.reference);
  end if;

  v_claimed := v_meta->>'stripe_paid_after_cancel_alert_claimed_at';
  if coalesce(v_claimed, '') <> '' then
    begin
      v_claimed_at := v_claimed::timestamp with time zone;
    exception
      when others then
        v_claimed_at := null;
    end;
    if v_claimed_at is not null
       and v_claimed_at > pg_catalog.clock_timestamp() - interval '10 minutes' then
      return pg_catalog.jsonb_build_object('claimed', false, 'reference', v_order.reference);
    end if;
  end if;

  v_meta := pg_catalog.jsonb_set(
    v_meta,
    '{stripe_paid_after_cancel_alert_claimed_at}',
    pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
    true
  );
  update public."Orders"
  set details = pg_catalog.jsonb_set(coalesce(details, '{}'::jsonb), '{meta}', v_meta, true)
  where id = v_order.id;

  return pg_catalog.jsonb_build_object('claimed', true, 'reference', v_order.reference);
end;
$function$;

create or replace function public.finish_cancelled_payment_alert(
  p_order_id uuid,
  p_result text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_meta jsonb;
begin
  if p_result not in ('sent', 'failed') then
    raise exception 'Unknown cancelled payment alert result.';
  end if;

  select coalesce(details->'meta', '{}'::jsonb)
  into v_meta
  from public."Orders"
  where id = p_order_id
  for update;

  if v_meta is null then
    return;
  end if;
  if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
    v_meta := '{}'::jsonb;
  end if;

  if p_result = 'sent' then
    v_meta := (v_meta - 'stripe_paid_after_cancel_alert_claimed_at') || pg_catalog.jsonb_build_object(
      'stripe_paid_after_cancel_alerted_at', pg_catalog.clock_timestamp()
    );
  else
    v_meta := v_meta - 'stripe_paid_after_cancel_alert_claimed_at';
  end if;

  update public."Orders"
  set details = pg_catalog.jsonb_set(coalesce(details, '{}'::jsonb), '{meta}', v_meta, true),
      status = status
  where id = p_order_id;
end;
$function$;

revoke all on function public.cancelled_payment_needs_alert(uuid) from public, anon, authenticated;
grant execute on function public.cancelled_payment_needs_alert(uuid) to service_role;

revoke execute on function public.apply_payment_link_event(text, text, text, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_payment_link_event(text, text, text, integer, text, text, text)
  to service_role;

revoke all on function public.claim_cancelled_payment_alert(uuid) from public, anon, authenticated;
grant execute on function public.claim_cancelled_payment_alert(uuid) to service_role;

revoke all on function public.finish_cancelled_payment_alert(uuid, text) from public, anon, authenticated;
grant execute on function public.finish_cancelled_payment_alert(uuid, text) to service_role;
