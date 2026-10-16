-- Ordering pause. Keep these instants in sync with public/order-pause.js.
-- Active from 16:00 Europe/London on Friday 16 October 2026
-- until 00:00 Europe/London on Monday 26 October 2026.
-- 16:00 BST is 15:00 UTC. 00:00 on 26 October is GMT, which is 00:00 UTC.
-- place_order, the Orders insert trigger, and the 3pm reminder already call
-- orders_are_paused, so replacing this function moves the window for all of them.

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
      cast('2026-10-16 16:00:00' as timestamp without time zone)
    )
    and p_at < pg_catalog.timezone(
      'Europe/London',
      cast('2026-10-26 00:00:00' as timestamp without time zone)
    );
$function$;
