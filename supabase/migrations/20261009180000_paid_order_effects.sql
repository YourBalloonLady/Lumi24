-- Run the paid-order side effects once. The admin page and the Payment Link
-- webhook both call these functions. They are not applied by the pull request.

create or replace function public.prepare_paid_order_effects(
  p_order_id uuid,
  p_order_reference text,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_ref text;
  v_actor text;
  v_meta jsonb;
  v_details jsonb;
  v_history jsonb;
  v_buyer text;
  v_buyer_email text;
  v_buyer_name text;
  v_code text;
  v_referrer text;
  v_credit text;
  v_email_state text;
  v_telegram_state text;
  v_changed boolean := false;
begin
  v_actor := pg_catalog.left(pg_catalog.btrim(coalesce(p_actor, 'system')), 200);
  if v_actor = '' then
    v_actor := 'system';
  end if;

  if p_order_id is not null then
    select * into v_order
    from public."Orders"
    where id = p_order_id
    for update;
  else
    v_ref := pg_catalog.upper(pg_catalog.btrim(coalesce(p_order_reference, '')));
    if v_ref !~ '^LW[0-9A-F]{8}$' then
      return pg_catalog.jsonb_build_object('status', 'not_found');
    end if;

    begin
      select * into strict v_order
      from public."Orders"
      where pg_catalog.upper(reference) = v_ref
      for update;
    exception
      when no_data_found or too_many_rows then
        return pg_catalog.jsonb_build_object('status', 'not_found');
    end;
  end if;

  if v_order.id is null then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  v_details := coalesce(v_order.details, '{}'::jsonb);
  v_meta := coalesce(v_details->'meta', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
    v_meta := '{}'::jsonb;
  end if;

  if pg_catalog.lower(coalesce(v_order.status, '')) is distinct from 'paid' then
    return pg_catalog.jsonb_build_object(
      'status', 'not_paid',
      'order_id', v_order.id,
      'credit', 'not_paid',
      'email', 'skipped',
      'telegram', 'skipped'
    );
  end if;

  v_buyer_email := pg_catalog.btrim(coalesce(v_details #>> '{customer,email}', ''));
  v_buyer := pg_catalog.lower(v_buyer_email);
  v_buyer_name := pg_catalog.btrim(coalesce(v_details #>> '{customer,name}', ''));
  v_code := pg_catalog.upper(pg_catalog.btrim(coalesce(
    v_order.referral_code,
    v_details #>> '{meta,referral_code}',
    ''
  )));

  if coalesce(v_meta->>'referral_awarded_at', '') <> '' then
    v_credit := 'already_awarded';
  elsif v_buyer = '' or v_code = '' then
    v_credit := 'not_eligible';
  elsif exists (
    select 1
    from public."Orders" earlier
    where earlier.id is distinct from v_order.id
      and pg_catalog.lower(coalesce(earlier.status, '')) in ('paid', 'packed', 'shipped')
      and pg_catalog.lower(pg_catalog.btrim(coalesce(earlier.details #>> '{customer,email}', ''))) = v_buyer
  ) then
    v_credit := 'not_eligible';
  else
    select pg_catalog.lower(pg_catalog.btrim(owner_email))
      into v_referrer
    from public."ReferralCodes"
    where pg_catalog.upper(code) = v_code
      and is_active is true
    limit 1;

    if v_referrer is null or v_referrer = '' or v_referrer = v_buyer then
      v_credit := 'not_eligible';
    else
      insert into public.customers (email, name, credit_balance)
      values (v_buyer, nullif(v_buyer_name, ''), 10)
      on conflict (email) do update
      set credit_balance = coalesce(customers.credit_balance, 0) + 10,
          name = case
            when excluded.name is not null and pg_catalog.btrim(excluded.name) <> '' then excluded.name
            else customers.name
          end;

      insert into public.customers (email, credit_balance)
      values (v_referrer, 10)
      on conflict (email) do update
      set credit_balance = coalesce(customers.credit_balance, 0) + 10;

      v_history := coalesce(v_meta->'history', '[]'::jsonb);
      if pg_catalog.jsonb_typeof(v_history) is distinct from 'array' then
        v_history := '[]'::jsonb;
      end if;
      v_history := v_history || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'at', pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
        'by', v_actor,
        'action', 'referral_credit_awarded',
        'note', 'buyer £10.00 + referrer £10.00 • code ' || v_code
      ));
      if pg_catalog.jsonb_array_length(v_history) > 60 then
        v_history := (
          select pg_catalog.jsonb_agg(item order by ord)
          from (
            select item, ord
            from pg_catalog.jsonb_array_elements(v_history) with ordinality as history_row(item, ord)
            order by ord desc
            limit 60
          ) kept
        );
      end if;

      v_meta := v_meta || pg_catalog.jsonb_build_object(
        'history', v_history,
        'referral_code', v_code,
        'referral_awarded_at', pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
        'referral_awarded_by', v_actor,
        'referral_buyer_email', v_buyer,
        'referral_referrer_email', v_referrer,
        'referral_buyer_amount', 10,
        'referral_referrer_amount', 10
      );
      v_credit := 'awarded';
      v_changed := true;
    end if;
  end if;

  if coalesce(v_meta->>'paid_email_sent_at', '') <> '' then
    v_email_state := 'sent';
  elsif v_buyer = '' then
    v_meta := v_meta || pg_catalog.jsonb_build_object(
      'paid_email_sent_at', pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
      'paid_email_result', 'skipped'
    );
    v_meta := v_meta - 'paid_email_claimed_at';
    v_email_state := 'skipped';
    v_changed := true;
  else
    v_email_state := 'pending';
  end if;

  if coalesce(v_meta->>'paid_telegram_sent_at', '') <> '' then
    v_telegram_state := 'sent';
  elsif pg_catalog.btrim(coalesce(v_order.reference, '')) = '' then
    v_meta := v_meta || pg_catalog.jsonb_build_object(
      'paid_telegram_sent_at', pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
      'paid_telegram_result', 'skipped'
    );
    v_meta := v_meta - 'paid_telegram_claimed_at';
    v_telegram_state := 'skipped';
    v_changed := true;
  else
    v_telegram_state := 'pending';
  end if;

  if v_changed then
    v_details := pg_catalog.jsonb_set(v_details, '{meta}', v_meta, true);
    update public."Orders"
    set details = v_details
    where id = v_order.id;
  end if;

  return pg_catalog.jsonb_build_object(
    'status', 'ready',
    'order_id', v_order.id,
    'reference', v_order.reference,
    'total_amount', v_order.total_amount,
    'customer_email', nullif(v_buyer_email, ''),
    'customer_name', nullif(v_buyer_name, ''),
    'credit', v_credit,
    'email', v_email_state,
    'telegram', v_telegram_state
  );
end;
$function$;

create or replace function public.claim_paid_order_effect(
  p_order_id uuid,
  p_effect text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_meta jsonb;
  v_sent_key text;
  v_claim_key text;
  v_claimed text;
  v_claimed_at timestamp with time zone;
begin
  if p_effect = 'email' then
    v_sent_key := 'paid_email_sent_at';
    v_claim_key := 'paid_email_claimed_at';
  elsif p_effect = 'telegram' then
    v_sent_key := 'paid_telegram_sent_at';
    v_claim_key := 'paid_telegram_claimed_at';
  else
    raise exception 'Unknown paid order effect.';
  end if;

  select * into v_order
  from public."Orders"
  where id = p_order_id
  for update;

  if v_order.id is null
     or pg_catalog.lower(coalesce(v_order.status, '')) is distinct from 'paid' then
    return false;
  end if;

  v_meta := coalesce(v_order.details->'meta', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
    v_meta := '{}'::jsonb;
  end if;

  if coalesce(v_meta->>v_sent_key, '') <> '' then
    return false;
  end if;

  v_claimed := v_meta->>v_claim_key;
  if coalesce(v_claimed, '') <> '' then
    begin
      v_claimed_at := v_claimed::timestamp with time zone;
    exception
      when others then
        v_claimed_at := null;
    end;
    if v_claimed_at is not null
       and v_claimed_at > pg_catalog.clock_timestamp() - interval '2 minutes' then
      return false;
    end if;
  end if;

  v_meta := pg_catalog.jsonb_set(
    v_meta,
    array[v_claim_key],
    pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
    true
  );

  update public."Orders"
  set details = pg_catalog.jsonb_set(coalesce(details, '{}'::jsonb), '{meta}', v_meta, true)
  where id = v_order.id;

  return true;
end;
$function$;

create or replace function public.finish_paid_order_effect(
  p_order_id uuid,
  p_effect text,
  p_result text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_meta jsonb;
  v_details jsonb;
  v_sent_key text;
  v_claim_key text;
  v_result_key text;
begin
  if p_effect = 'email' then
    v_sent_key := 'paid_email_sent_at';
    v_claim_key := 'paid_email_claimed_at';
    v_result_key := 'paid_email_result';
  elsif p_effect = 'telegram' then
    v_sent_key := 'paid_telegram_sent_at';
    v_claim_key := 'paid_telegram_claimed_at';
    v_result_key := 'paid_telegram_result';
  else
    raise exception 'Unknown paid order effect.';
  end if;

  if p_result not in ('sent', 'skipped', 'failed') then
    raise exception 'Unknown paid order effect result.';
  end if;

  select * into v_order
  from public."Orders"
  where id = p_order_id
  for update;

  if v_order.id is null then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  v_details := coalesce(v_order.details, '{}'::jsonb);
  v_meta := coalesce(v_details->'meta', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
    v_meta := '{}'::jsonb;
  end if;

  if p_result = 'failed' then
    v_meta := v_meta - v_claim_key;
  else
    v_meta := v_meta || pg_catalog.jsonb_build_object(
      v_sent_key, pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
      v_result_key, p_result
    );
    v_meta := v_meta - v_claim_key;
  end if;

  update public."Orders"
  set details = pg_catalog.jsonb_set(v_details, '{meta}', v_meta, true)
  where id = v_order.id;

  return pg_catalog.jsonb_build_object('status', p_result);
end;
$function$;

revoke execute on function public.prepare_paid_order_effects(uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.claim_paid_order_effect(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.finish_paid_order_effect(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.prepare_paid_order_effects(uuid, text, text) to service_role;
grant execute on function public.claim_paid_order_effect(uuid, text) to service_role;
grant execute on function public.finish_paid_order_effect(uuid, text, text) to service_role;
