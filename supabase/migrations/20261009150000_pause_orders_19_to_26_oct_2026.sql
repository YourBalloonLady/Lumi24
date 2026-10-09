-- Ordering pause. Keep these instants in sync with public/order-pause.js.
-- Active from 08:00 Europe/London on 19 October 2026
-- until 00:00 Europe/London on 26 October 2026.

create or replace function public.orders_are_paused(
  p_at timestamp with time zone default pg_catalog.now()
)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select p_at >= pg_catalog.timezone(
      'Europe/London',
      cast('2026-10-19 08:00:00' as timestamp without time zone)
    )
    and p_at < pg_catalog.timezone(
      'Europe/London',
      cast('2026-10-26 00:00:00' as timestamp without time zone)
    );
$function$;

create or replace function public.reject_order_insert_during_pause()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if public.orders_are_paused(pg_catalog.now()) then
    raise exception using
      errcode = 'P0001',
      message = 'Orders are paused until Monday 26th October';
  end if;
  return new;
end;
$function$;

drop trigger if exists orders_reject_during_pause on public."Orders";
create trigger orders_reject_during_pause
before insert on public."Orders"
for each row
execute function public.reject_order_insert_during_pause();

do $guard$
begin
  if to_regprocedure('public.place_order_before_pause_guard(jsonb,jsonb,text,text,text)') is null then
    alter function public.place_order(jsonb, jsonb, text, text, text)
      rename to place_order_before_pause_guard;
  end if;
end
$guard$;

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
begin
  if public.orders_are_paused(pg_catalog.now()) then
    raise exception using
      errcode = 'P0001',
      message = 'Orders are paused until Monday 26th October';
  end if;

  return public.place_order_before_pause_guard(
    p_customer,
    p_items,
    p_delivery_method,
    p_referral_code,
    p_telegram_token
  );
end;
$function$;

revoke all on function public.place_order_before_pause_guard(jsonb, jsonb, text, text, text)
  from public, anon, authenticated;
revoke all on function public.orders_are_paused(timestamp with time zone)
  from public, anon, authenticated;
grant execute on function public.place_order(jsonb, jsonb, text, text, text)
  to anon, authenticated;
