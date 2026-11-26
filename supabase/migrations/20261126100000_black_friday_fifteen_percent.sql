-- Black Friday mix-and-match: 15% off two or more catalogue products
-- until 23:59:59 UK on Friday 27 November 2026 (2026-11-27 23:59:59+00).
-- After that instant this same function goes back to 10% off three or more.
-- Bundle lines stay at their own price. Stripe is unchanged.

create or replace function public.place_order_before_pause_guard(
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
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_quantity integer;
  v_total_quantity integer := 0;
  v_eligible_quantity integer := 0;
  v_eligible_subtotal numeric(12, 2) := 0;
  v_product_subtotal numeric(12, 2) := 0;
  v_unit_price numeric(12, 2);
  v_regular_line_total numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_discount numeric(12, 2) := 0;
  v_discount_rate numeric := 0.10;
  v_discount_min_qty integer := 3;
  v_discount_label text := '10% multi-product discount';
  v_total numeric(12, 2);
  v_order_id uuid;
  v_reference text;
  v_shared record;
  v_plain record;
  v_is_bundle boolean;
  v_includes text;
  v_stock_targets jsonb := '{}'::jsonb;
  v_loose_targets jsonb := '{}'::jsonb;
  v_previous_mirror text := pg_catalog.current_setting('lumina.stock_mirror', true);
begin
  perform pg_catalog.pg_advisory_xact_lock(2026082401::bigint);

  if pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = '22023', message = 'The cart is invalid.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) item(value)
    join public."Products" bundle
      on bundle.id = (item.value->>'id')::uuid
    where pg_catalog.jsonb_typeof(bundle.bundle_contents) = 'array'
      and pg_catalog.jsonb_array_length(bundle.bundle_contents) > 0
      and not public.black_friday_offer_open(pg_catalog.now())
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'This Black Friday bundle is no longer available.';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_items) item(value)
    join public."Products" bundle
      on bundle.id = (item.value->>'id')::uuid
    cross join lateral pg_catalog.jsonb_array_elements(bundle.bundle_contents) content(value)
    left join public."Products" component
      on component.id = (content.value->>'product_id')::uuid
    where pg_catalog.jsonb_typeof(bundle.bundle_contents) = 'array'
      and pg_catalog.jsonb_array_length(bundle.bundle_contents) > 0
      and component.id is null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'This Black Friday bundle is no longer available.';
  end if;

  perform 1
  from public.stock_groups g
  where g.id in (
    select d.stock_group_id
    from public.order_stock_demand(p_items) d
    where d.stock_group_id is not null
  )
  order by g.id
  for update;

  perform 1
  from public."Products" p
  where p.id in (
    select d.product_id
    from public.order_stock_demand(p_items) d
    where d.stock_group_id is null
      and d.bundle_qty > 0
  )
  order by p.id
  for update;

  for v_shared in
    select
      demand.stock_group_id,
      sum(demand.qty)::integer as requested_quantity,
      g.stock,
      g.label
    from public.order_stock_demand(p_items) demand
    join public.stock_groups g
      on g.id = demand.stock_group_id
    where demand.stock_group_id is not null
    group by demand.stock_group_id, g.stock, g.label
    order by demand.stock_group_id
  loop
    if v_shared.requested_quantity > v_shared.stock then
      raise exception using
        errcode = 'P0001',
        message = pg_catalog.format(
          'Only %s shared unit(s) of %s remain in stock.',
          v_shared.stock,
          v_shared.label
        );
    end if;

    v_stock_targets := v_stock_targets || pg_catalog.jsonb_build_object(
      v_shared.stock_group_id,
      v_shared.stock - v_shared.requested_quantity
    );
  end loop;

  for v_plain in
    select
      demand.product_id,
      demand.bundle_qty,
      p.stock,
      p.name
    from public.order_stock_demand(p_items) demand
    join public."Products" p
      on p.id = demand.product_id
    where demand.stock_group_id is null
      and demand.bundle_qty > 0
    order by demand.product_id
  loop
    if v_plain.bundle_qty > v_plain.stock then
      raise exception using
        errcode = 'P0001',
        message = pg_catalog.format(
          'Only %s unit(s) of %s remain in stock.',
          v_plain.stock,
          v_plain.name
        );
    end if;

    v_loose_targets := v_loose_targets || pg_catalog.jsonb_build_object(
      v_plain.product_id::text,
      v_plain.bundle_qty
    );
  end loop;

  perform pg_catalog.set_config('lumina.stock_mirror', 'on', true);

  begin
    v_result := public.place_order_without_volume_offers(
      p_customer,
      p_items,
      p_delivery_method,
      p_referral_code,
      p_telegram_token
    );

    for v_shared in
      select key as stock_group_id, value::integer as target_stock
      from pg_catalog.jsonb_each_text(v_stock_targets)
    loop
      update public.stock_groups
      set stock = v_shared.target_stock,
          updated_at = pg_catalog.clock_timestamp()
      where id = v_shared.stock_group_id;
    end loop;

    for v_plain in
      select key as product_id, value::integer as bundle_qty
      from pg_catalog.jsonb_each_text(v_loose_targets)
    loop
      update public."Products"
      set stock = stock - v_plain.bundle_qty
      where id = v_plain.product_id::uuid
        and stock_group_id is null;
    end loop;

    perform pg_catalog.set_config(
      'lumina.stock_mirror',
      coalesce(nullif(v_previous_mirror, ''), 'off'),
      true
    );
  exception when others then
    perform pg_catalog.set_config(
      'lumina.stock_mirror',
      coalesce(nullif(v_previous_mirror, ''), 'off'),
      true
    );
    raise;
  end;

  select
    coalesce(sum(line.qty) filter (where not line.is_bundle), 0)::integer,
    coalesce(sum(line.line_total) filter (where not line.is_bundle), 0)::numeric(12, 2),
    coalesce(sum(line.line_total), 0)::numeric(12, 2)
  into v_eligible_quantity, v_eligible_subtotal, v_product_subtotal
  from (
    select
      greatest(0, coalesce((value->>'qty')::integer, 0)) as qty,
      greatest(0, coalesce((value->>'qty')::integer, 0))
        * greatest(0, coalesce((value->>'price_each')::numeric, 0)) as line_total,
      exists (
        select 1
        from public."Products" p
        where p.id = (value->>'id')::uuid
          and pg_catalog.jsonb_typeof(p.bundle_contents) = 'array'
          and pg_catalog.jsonb_array_length(p.bundle_contents) > 0
      ) as is_bundle
    from pg_catalog.jsonb_array_elements(v_result->'items')
  ) line;

  v_total_quantity := v_eligible_quantity;

  if public.black_friday_offer_open(pg_catalog.now()) then
    v_discount_min_qty := 2;
    v_discount_rate := 0.15;
    v_discount_label := '15% Black Friday discount (2+ products)';
  end if;

  if v_eligible_quantity >= v_discount_min_qty then
    v_discount := round(v_eligible_subtotal * v_discount_rate, 2);
  end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(v_result->'items')
  loop
    v_quantity := greatest(0, coalesce((v_item->>'qty')::integer, 0));
    v_unit_price := greatest(0, coalesce((v_item->>'price_each')::numeric, 0));
    v_regular_line_total := v_unit_price * v_quantity;
    v_is_bundle := exists (
      select 1
      from public."Products" p
      where p.id = (v_item->>'id')::uuid
        and pg_catalog.jsonb_typeof(p.bundle_contents) = 'array'
        and pg_catalog.jsonb_array_length(p.bundle_contents) > 0
    );
    v_line_discount := case
      when v_eligible_quantity >= v_discount_min_qty and not v_is_bundle
        then round(v_regular_line_total * v_discount_rate, 2)
      else 0
    end;
    v_includes := null;
    if v_is_bundle then
      select pg_catalog.string_agg(component.name, ' + ' order by component.name)
      into v_includes
      from public."Products" bundle
      cross join lateral pg_catalog.jsonb_array_elements(bundle.bundle_contents) content(value)
      join public."Products" component
        on component.id = (content.value->>'product_id')::uuid
      where bundle.id = (v_item->>'id')::uuid;
    end if;

    v_items := v_items || pg_catalog.jsonb_build_array(
      v_item || pg_catalog.jsonb_build_object(
        'line_total', v_regular_line_total - v_line_discount,
        'promotion_discount', v_line_discount,
        'promotion_label', case
          when v_line_discount > 0 then v_discount_label
          else null
        end,
        'bundle_includes', v_includes
      )
    );
  end loop;

  v_order_id := (v_result->>'order_id')::uuid;
  v_reference := v_result->>'reference';
  v_total := greatest(0, (v_result->>'total_amount')::numeric - v_discount);

  update public."Orders"
  set total_amount = v_total,
      details = details
        || pg_catalog.jsonb_build_object('items', v_items)
        || pg_catalog.jsonb_build_object(
          'meta',
          coalesce(details->'meta', '{}'::jsonb)
          || pg_catalog.jsonb_build_object('promotion_discount', v_discount)
        )
  where id = v_order_id;

  update public."ReferralEvents"
  set order_total = v_total
  where order_reference = v_reference;

  return v_result || pg_catalog.jsonb_build_object(
    'total_amount', v_total,
    'items', v_items,
    'promotion_discount', v_discount,
    'promotion_label', case
      when v_discount > 0 then v_discount_label
      else null
    end
  );
end;
$function$;


