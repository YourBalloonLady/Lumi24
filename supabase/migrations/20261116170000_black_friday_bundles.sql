-- Black Friday bundles, 16 November 2026 through 23:59:59 UK on Friday 27 November 2026.
-- UK time is GMT on that date, so the cutoff is 2026-11-27 23:59:59+00.
-- Idempotent. Safe to run more than once. Does not replace the outer place_order
-- wrapper, so the customer blocklist stays in front of checkout.
-- The website already shows the deals. Until this script is run, each button
-- stays on "Available shortly" and a bundle cannot be purchased.

create or replace function public.black_friday_offer_open(
  p_at timestamp with time zone default pg_catalog.now()
)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select p_at <= timestamptz '2026-11-27 23:59:59+00';
$function$;

revoke all on function public.black_friday_offer_open(timestamp with time zone)
  from public, anon, authenticated;

create or replace function public.order_stock_demand(p_items jsonb)
returns table(
  stock_group_id text,
  product_id uuid,
  qty integer,
  bundle_qty integer
)
language sql
stable
security definer
set search_path to ''
as $function$
  with lines as (
    select
      (item.value->>'id')::uuid as product_id,
      greatest(coalesce((item.value->>'qty')::integer, 0), 0) as requested_quantity
    from pg_catalog.jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) item(value)
    where pg_catalog.jsonb_typeof(coalesce(p_items, '[]'::jsonb)) = 'array'
  ),
  parts as (
    select
      component.stock_group_id,
      component.id as product_id,
      lines.requested_quantity * greatest(coalesce((content.value->>'qty')::integer, 1), 1) as qty,
      true as from_bundle
    from lines
    join public."Products" bundle
      on bundle.id = lines.product_id
    cross join lateral pg_catalog.jsonb_array_elements(bundle.bundle_contents) content(value)
    join public."Products" component
      on component.id = (content.value->>'product_id')::uuid
    where pg_catalog.jsonb_typeof(bundle.bundle_contents) = 'array'
      and pg_catalog.jsonb_array_length(bundle.bundle_contents) > 0
    union all
    select
      p.stock_group_id,
      p.id,
      lines.requested_quantity,
      false
    from lines
    join public."Products" p
      on p.id = lines.product_id
    where pg_catalog.jsonb_typeof(p.bundle_contents) is distinct from 'array'
       or pg_catalog.jsonb_array_length(coalesce(p.bundle_contents, '[]'::jsonb)) = 0
  )
  select
    parts.stock_group_id,
    parts.product_id,
    sum(parts.qty)::integer as qty,
    sum(parts.qty) filter (where parts.from_bundle)::integer as bundle_qty
  from parts
  group by parts.stock_group_id, parts.product_id;
$function$;

revoke all on function public.order_stock_demand(jsonb)
  from public, anon, authenticated;

do $guard$
begin
  if to_regprocedure('public.place_order_before_pause_guard(jsonb,jsonb,text,text,text)') is null then
    raise exception 'place_order_before_pause_guard is missing. This script will not replace place_order.';
  end if;
end;
$guard$;

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

  if v_eligible_quantity >= 3 then
    v_discount := round(v_eligible_subtotal * 0.10, 2);
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
      when v_eligible_quantity >= 3 and not v_is_bundle then round(v_regular_line_total * 0.10, 2)
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
          when v_line_discount > 0 then '10% multi-product discount'
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
      when v_total_quantity >= 3 then '10% multi-product discount'
      else null
    end
  );
end;
$function$;


create or replace function public.perform_cancel_and_restock(
  p_order_id uuid,
  p_actor text,
  p_only_if_pending boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_item jsonb;
  v_product public."Products"%rowtype;
  v_product_id uuid;
  v_quantity integer;
  v_group_quantities jsonb := '{}'::jsonb;
  v_product_quantities jsonb := '{}'::jsonb;
  v_entry record;
  v_meta jsonb;
  v_updated_details jsonb;
  v_email text;
  v_result jsonb;
  v_content jsonb;
  v_component public."Products"%rowtype;
  v_component_qty integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(2026082401::bigint);

  select *
  into v_order
  from public."Orders"
  where id = p_order_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found.';
  end if;

  if p_only_if_pending
     and pg_catalog.lower(coalesce(v_order.status, '')) is distinct from 'pending' then
    return pg_catalog.jsonb_build_object(
      'status', 'skipped',
      'reason', 'not_pending',
      'reference', v_order.reference
    );
  end if;

  if pg_catalog.lower(coalesce(v_order.status, '')) = 'cancelled'
     or v_order.details #>> '{meta,restocked_at}' is not null then
    if p_only_if_pending then
      return pg_catalog.jsonb_build_object(
        'status', 'skipped',
        'reason', 'already_cancelled',
        'reference', v_order.reference
      );
    end if;
    raise exception using errcode = 'P0001', message = 'This order has already been cancelled or restocked.';
  end if;

  if pg_catalog.jsonb_typeof(v_order.details->'items') <> 'array'
     or pg_catalog.jsonb_array_length(v_order.details->'items') = 0 then
    raise exception using errcode = '22023', message = 'This order has no items to restock.';
  end if;

  for v_item in
    select value from pg_catalog.jsonb_array_elements(v_order.details->'items')
  loop
    begin
      v_quantity := (v_item->>'qty')::integer;
    exception when others then
      raise exception using errcode = '22023', message = 'An order item has an invalid quantity.';
    end;

    if v_quantity < 1 then
      raise exception using errcode = '22023', message = 'An order item has an invalid quantity.';
    end if;

    v_product := null;
    v_product_id := null;

    begin
      v_product_id := coalesce(
        nullif(v_item->>'id', ''),
        nullif(v_item->>'product_id', '')
      )::uuid;
    exception when others then
      v_product_id := null;
    end;

    if v_product_id is not null then
      select *
      into v_product
      from public."Products"
      where id = v_product_id;
    end if;

    if v_product.id is null then
      select *
      into v_product
      from public."Products"
      where pg_catalog.btrim(name, E' \t\n\r')
        = pg_catalog.btrim(coalesce(v_item->>'name', ''), E' \t\n\r')
      order by id
      limit 1;
    end if;

    -- Three early orders used the old vial label without storing a product ID.
    if v_product.id is null
       and lower(pg_catalog.btrim(coalesce(v_item->>'name', ''), E' \t\n\r')) = 'semaglutide 20mg' then
      select *
      into v_product
      from public."Products"
      where stock_group_id = 'semaglutide-20mg'
      order by id
      limit 1;
    end if;

    if v_product.id is null then
      raise exception using
        errcode = 'P0002',
        message = pg_catalog.format(
          'Product %s could not be found for restocking.',
          coalesce(v_item->>'name', v_item->>'id', 'unknown')
        );
    end if;

    if pg_catalog.jsonb_typeof(v_product.bundle_contents) = 'array'
       and pg_catalog.jsonb_array_length(v_product.bundle_contents) > 0 then
      for v_content in
        select value
        from pg_catalog.jsonb_array_elements(v_product.bundle_contents)
      loop
        v_component := null;
        select *
        into v_component
        from public."Products"
        where id = (v_content->>'product_id')::uuid;

        if v_component.id is null then
          raise exception using
            errcode = 'P0002',
            message = 'An included material in this bundle could not be restocked.';
        end if;

        v_component_qty := v_quantity * greatest(coalesce((v_content->>'qty')::integer, 1), 1);

        if v_component.stock_group_id is not null then
          v_group_quantities := pg_catalog.jsonb_set(
            v_group_quantities,
            array[v_component.stock_group_id],
            pg_catalog.to_jsonb(
              coalesce((v_group_quantities->>v_component.stock_group_id)::integer, 0)
              + v_component_qty
            ),
            true
          );
        else
          v_product_quantities := pg_catalog.jsonb_set(
            v_product_quantities,
            array[v_component.id::text],
            pg_catalog.to_jsonb(
              coalesce((v_product_quantities->>v_component.id::text)::integer, 0)
              + v_component_qty
            ),
            true
          );
        end if;
      end loop;
    end if;

    if v_product.stock_group_id is not null then
      v_group_quantities := pg_catalog.jsonb_set(
        v_group_quantities,
        array[v_product.stock_group_id],
        pg_catalog.to_jsonb(
          coalesce((v_group_quantities->>v_product.stock_group_id)::integer, 0)
          + v_quantity
        ),
        true
      );
    else
      v_product_quantities := pg_catalog.jsonb_set(
        v_product_quantities,
        array[v_product.id::text],
        pg_catalog.to_jsonb(
          coalesce((v_product_quantities->>v_product.id::text)::integer, 0)
          + v_quantity
        ),
        true
      );
    end if;
  end loop;

  for v_entry in
    select key, value from pg_catalog.jsonb_each_text(v_group_quantities)
  loop
    update public.stock_groups
    set stock = stock + v_entry.value::integer,
        updated_at = pg_catalog.clock_timestamp()
    where id = v_entry.key;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = pg_catalog.format('Unknown shared stock group %s.', v_entry.key);
    end if;
  end loop;

  for v_entry in
    select key, value from pg_catalog.jsonb_each_text(v_product_quantities)
  loop
    update public."Products"
    set stock = stock + v_entry.value::integer
    where id = v_entry.key::uuid;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = pg_catalog.format('Product %s could not be restocked.', v_entry.key);
    end if;
  end loop;

  v_email := pg_catalog.btrim(coalesce(v_order.details #>> '{customer,email}', ''));
  v_meta := coalesce(v_order.details->'meta', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
    v_meta := '{}'::jsonb;
  end if;
  v_meta := v_meta || pg_catalog.jsonb_build_object(
    'restocked_at', pg_catalog.clock_timestamp(),
    'restocked_by', p_actor
  );
  if p_only_if_pending then
    v_meta := v_meta || pg_catalog.jsonb_build_object(
      'auto_cancelled_at', pg_catalog.clock_timestamp(),
      'auto_cancelled_by', 'cron'
    );
    if v_email = '' then
      v_meta := v_meta || pg_catalog.jsonb_build_object(
        'cancelled_email_sent_at', pg_catalog.clock_timestamp(),
        'cancelled_email_result', 'skipped'
      );
    else
      v_meta := v_meta || pg_catalog.jsonb_build_object(
        'cancelled_email_claimed_at', pg_catalog.clock_timestamp()
      );
    end if;
  end if;

  v_updated_details := coalesce(v_order.details, '{}'::jsonb)
    || pg_catalog.jsonb_build_object('meta', v_meta);

  update public."Orders"
  set status = 'Cancelled',
      details = v_updated_details
  where id = v_order.id
    and (
      p_only_if_pending = false
      or pg_catalog.lower(coalesce(status, '')) = 'pending'
    )
    and details #>> '{meta,restocked_at}' is null;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'Order status changed before it could be cancelled.';
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'id', v_order.id,
    'status', 'Cancelled',
    'details', v_updated_details,
    'reference', v_order.reference,
    'total_amount', v_order.total_amount,
    'created_at', v_order.created_at
  );

  if p_only_if_pending then
    v_result := (v_result - 'details') || pg_catalog.jsonb_build_object(
      'order_id', v_order.id,
      'email', nullif(v_email, ''),
      'customer_name', coalesce(
        nullif(pg_catalog.btrim(v_order.details #>> '{customer,name}'), ''),
        'Customer'
      ),
      'created_at_utc', pg_catalog.to_char(v_order.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'email_pending', v_email <> ''
    );
  end if;

  return v_result;
end;
$function$;


do $bundles$
declare
  v_missing text;
begin
  select pg_catalog.string_agg(wanted.name, ', ' order by wanted.name)
  into v_missing
  from (
    values
      ('Tirzepatide 40mg Pen'),
      ('Cagrilintide 10mg Pen'),
      ('BPC-157 + TB500 10mg Pen'),
      ('GHK-CU 100mg Pen'),
      ('Selank 10mg Pen'),
      ('Semax 10mg Pen'),
      ('Nad+1000mg Pen'),
      ('Epithalon 10mg Pen'),
      ('SS-31 Pen'),
      ('Retatrutide 60mg Pen'),
      ('MOTS-C 40mg Pen'),
      ('CJC-1295 (WO/DAC) 5mg + Ipamorelin 5mg Pen'),
      ('Klow Blend 80mg Pen'),
      ('Tirzepatide 60mg Pen'),
      ('SLU-PP-332 Pen')
  ) as wanted(name)
  left join public."Products" p
    on pg_catalog.btrim(p.name) = wanted.name
  where p.id is null;

  if v_missing is not null then
    raise exception 'Black Friday bundles need these catalogue products: %', v_missing;
  end if;
end;
$bundles$;

insert into public."Products" (
  id, name, price, compare_at_price, stock, image, description, type, bundle_contents, bundle_options, colors, featured
)
values
  (
    'cdc2ca39-1a99-4f17-b548-2b8bacfd489f',
    'Weight Research Duo',
    189.00,
    230.00,
    100000,
    'black-friday/bf-weight-research-duo.png',
    'Laboratory research bundle. Includes one Tirzepatide 40mg Pen and one Cagrilintide 10mg Pen. Supplied strictly for laboratory research use only. Not for human consumption.',
    'black-friday',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Tirzepatide 40mg Pen'), 'qty', 1),
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Cagrilintide 10mg Pen'), 'qty', 1)
    ),
    '{}'::jsonb,
    '{}'::text[],
    false
  ),
  (
    '1f9ca463-ead0-4ade-ac8f-47ac9e263e5c',
    'Recovery Stack',
    89.00,
    110.00,
    100000,
    'black-friday/bf-recovery-stack.png',
    'Laboratory research bundle. Includes one BPC-157 + TB500 10mg Pen and one GHK-CU 100mg Pen. Supplied strictly for laboratory research use only. Not for human consumption.',
    'black-friday',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'BPC-157 + TB500 10mg Pen'), 'qty', 1),
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'GHK-CU 100mg Pen'), 'qty', 1)
    ),
    '{}'::jsonb,
    '{}'::text[],
    false
  ),
  (
    '57ef9c13-632c-40d2-a4da-75a305ce096b',
    'Focus Trio',
    119.00,
    150.00,
    100000,
    'black-friday/bf-focus-trio.png',
    'Laboratory research bundle. Includes one Selank 10mg Pen, one Semax 10mg Pen and one Nad+1000mg Pen. Supplied strictly for laboratory research use only. Not for human consumption.',
    'black-friday',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Selank 10mg Pen'), 'qty', 1),
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Semax 10mg Pen'), 'qty', 1),
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Nad+1000mg Pen'), 'qty', 1)
    ),
    '{}'::jsonb,
    '{}'::text[],
    false
  ),
  (
    '5d5f4be6-e409-442c-99f2-972b319ceca8',
    'Longevity Trio',
    119.00,
    150.00,
    100000,
    'black-friday/bf-longevity-trio.png',
    'Laboratory research bundle. Includes one Epithalon 10mg Pen, one Nad+1000mg Pen and one SS-31 Pen. Supplied strictly for laboratory research use only. Not for human consumption.',
    'black-friday',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Epithalon 10mg Pen'), 'qty', 1),
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Nad+1000mg Pen'), 'qty', 1),
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'SS-31 Pen'), 'qty', 1)
    ),
    '{}'::jsonb,
    '{}'::text[],
    false
  ),
  (
    'f844c67a-c66e-458d-87c2-f13467cd8cda',
    'Retatrutide Power Duo',
    205.00,
    250.00,
    100000,
    'black-friday/bf-retatrutide-power-duo.png',
    'Laboratory research bundle. Includes one Retatrutide 60mg Pen and one MOTS-C 40mg Pen. Supplied strictly for laboratory research use only. Not for human consumption.',
    'black-friday',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Retatrutide 60mg Pen'), 'qty', 1),
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'MOTS-C 40mg Pen'), 'qty', 1)
    ),
    '{}'::jsonb,
    '{}'::text[],
    false
  ),
  (
    '2f26b3b7-8be8-41c3-89fc-76e6f5c126ce',
    'Growth Duo',
    125.00,
    150.00,
    100000,
    'black-friday/bf-growth-duo.png',
    'Laboratory research bundle. Includes one CJC-1295 (WO/DAC) 5mg + Ipamorelin 5mg Pen and one Klow Blend 80mg Pen. Supplied strictly for laboratory research use only. Not for human consumption.',
    'black-friday',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'CJC-1295 (WO/DAC) 5mg + Ipamorelin 5mg Pen'), 'qty', 1),
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Klow Blend 80mg Pen'), 'qty', 1)
    ),
    '{}'::jsonb,
    '{}'::text[],
    false
  ),
  (
    '44b14916-100d-4189-8ba2-6577b70f22bd',
    'Tirzepatide 60 Duo',
    179.00,
    215.00,
    100000,
    'black-friday/bf-tirzepatide-60-duo.png',
    'Laboratory research bundle. Includes one Tirzepatide 60mg Pen and one SLU-PP-332 Pen. Supplied strictly for laboratory research use only. Not for human consumption.',
    'black-friday',
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'Tirzepatide 60mg Pen'), 'qty', 1),
      pg_catalog.jsonb_build_object('product_id', (select id from public."Products" where pg_catalog.btrim(name) = 'SLU-PP-332 Pen'), 'qty', 1)
    ),
    '{}'::jsonb,
    '{}'::text[],
    false
  )
on conflict (id) do update
set
  name = excluded.name,
  price = excluded.price,
  compare_at_price = excluded.compare_at_price,
  stock = excluded.stock,
  image = excluded.image,
  description = excluded.description,
  type = excluded.type,
  bundle_contents = excluded.bundle_contents,
  bundle_options = excluded.bundle_options;
