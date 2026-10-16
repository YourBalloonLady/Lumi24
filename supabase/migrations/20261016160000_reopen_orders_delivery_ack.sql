-- One script. Run the whole file together on project qketnqhfjfxbqiuqevnh.
-- Ordering and payment stay open. Until 00:00 UK on Monday 26 October 2026,
-- place_order rejects a checkout that has not acknowledged the later dispatch.
-- 00:00 on 26 October is GMT, which is 00:00 UTC.
-- orders_are_paused() is false for every instant, so the old pause guard,
-- the insert trigger, and any leftover 3pm pause skip all stay open.
-- The 3pm preview and claim functions no longer consult that flag.

create or replace function public.orders_are_paused(
  p_at timestamp with time zone default pg_catalog.now()
)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select false;
$function$;

create or replace function public.delivery_restart_ack_required(
  p_at timestamp with time zone default pg_catalog.now()
)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select p_at < pg_catalog.timezone(
    'Europe/London',
    cast('2026-10-26 00:00:00' as timestamp without time zone)
  );
$function$;

revoke all on function public.delivery_restart_ack_required(timestamp with time zone)
  from public, anon, authenticated;

alter table public."Orders"
  add column if not exists delivery_restart_acknowledged boolean not null default false;

comment on column public."Orders".delivery_restart_acknowledged is
  'True when the customer confirmed, before 00:00 UK on 26 October 2026, that dispatch waits until deliveries restart.';

create or replace function public.place_order(
  p_customer jsonb,
  p_items jsonb,
  p_delivery_method text default 'tracked24'::text,
  p_referral_code text default null::text,
  p_telegram_token text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_result jsonb;
  v_ack boolean := false;
begin
  perform public.enforce_customer_block(p_customer);

  if pg_catalog.jsonb_typeof(p_customer) = 'object'
     and p_customer->>'delivery_restart_acknowledged' = 'true' then
    v_ack := true;
  end if;

  if public.delivery_restart_ack_required(pg_catalog.now()) and not v_ack then
    raise exception using
      errcode = 'P0001',
      message = 'Please confirm that orders placed now will be dispatched when deliveries restart on Monday 26th October.';
  end if;

  if to_regprocedure('public.place_order_before_blocklist(jsonb,jsonb,text,text,text)') is null then
    raise exception using
      errcode = 'P0001',
      message = 'Checkout is not available.';
  end if;

  v_result := public.place_order_before_blocklist(
    p_customer,
    p_items,
    p_delivery_method,
    p_referral_code,
    p_telegram_token
  );

  if v_ack then
    update public."Orders"
    set delivery_restart_acknowledged = true
    where id = (v_result->>'order_id')::uuid;
  end if;

  return v_result;
end;
$function$;

grant execute on function public.place_order(jsonb, jsonb, text, text, text)
  to anon, authenticated, service_role;

create or replace function public.preview_pay_before_3pm_reminders(p_cutoff timestamp with time zone)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'order_id', picked.id,
      'reference', picked.reference
    ) order by picked.created_at, picked.reference)
    from (
      select o.id, o.reference, o.created_at
      from public."Orders" o
      where pg_catalog.lower(coalesce(o.status, '')) = 'pending'
        and o.created_at at time zone 'UTC' < p_cutoff
        and coalesce(o.details #>> '{meta,pay_before_3pm_sent_at}', '') = ''
        and nullif(pg_catalog.btrim(coalesce(o.details #>> '{customer,email}', '')), '') is not null
      order by o.created_at, o.reference
    ) picked
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.claim_pay_before_3pm_reminders(
  p_cutoff timestamp with time zone,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
  v_row public."Orders"%rowtype;
  v_meta jsonb;
  v_claimed text;
  v_claimed_at timestamp with time zone;
  v_email text;
  v_rows jsonb := '[]'::jsonb;
begin
  for v_row in
    select o.*
    from public."Orders" o
    where pg_catalog.lower(coalesce(o.status, '')) = 'pending'
      and o.created_at at time zone 'UTC' < p_cutoff
      and coalesce(o.details #>> '{meta,pay_before_3pm_sent_at}', '') = ''
      and nullif(pg_catalog.btrim(coalesce(o.details #>> '{customer,email}', '')), '') is not null
    order by o.created_at, o.reference
    limit v_limit
    for update skip locked
  loop
    v_meta := coalesce(v_row.details->'meta', '{}'::jsonb);
    if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
      v_meta := '{}'::jsonb;
    end if;

    v_claimed := v_meta->>'pay_before_3pm_claimed_at';
    v_claimed_at := null;
    if coalesce(v_claimed, '') <> '' then
      begin
        v_claimed_at := v_claimed::timestamp with time zone;
      exception
        when others then
          v_claimed_at := null;
      end;
      if v_claimed_at is not null
         and v_claimed_at > pg_catalog.clock_timestamp() - interval '10 minutes' then
        continue;
      end if;
    end if;

    v_email := pg_catalog.btrim(v_row.details #>> '{customer,email}');
    v_meta := pg_catalog.jsonb_set(
      v_meta,
      '{pay_before_3pm_claimed_at}',
      pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
      true
    );
    update public."Orders"
    set details = pg_catalog.jsonb_set(coalesce(details, '{}'::jsonb), '{meta}', v_meta, true)
    where id = v_row.id;

    v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'order_id', v_row.id,
      'reference', v_row.reference,
      'email', v_email,
      'customer_name', coalesce(nullif(pg_catalog.btrim(v_row.details #>> '{customer,name}'), ''), 'Customer'),
      'total_amount', v_row.total_amount
    ));
  end loop;

  return v_rows;
end;
$function$;
