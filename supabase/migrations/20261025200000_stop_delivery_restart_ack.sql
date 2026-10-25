-- Idempotent. Safe if the acknowledgement functions were never created,
-- and safe if the 16 October or 25 October pause scripts were already applied.
-- place_order keeps its blocklist wrapper. While delivery_restart_ack_required()
-- is false, that wrapper no longer asks for the dispatch acknowledgement.
-- orders_are_paused() stays false. The column is left in place.

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
  select false;
$function$;

revoke all on function public.delivery_restart_ack_required(timestamp with time zone)
  from public, anon, authenticated;
