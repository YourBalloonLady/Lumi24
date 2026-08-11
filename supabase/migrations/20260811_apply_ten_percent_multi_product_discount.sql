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
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_quantity integer;
  v_total_quantity integer := 0;
  v_product_subtotal numeric(12, 2) := 0;
  v_unit_price numeric(12, 2);
  v_regular_line_total numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_discount numeric(12, 2) := 0;
  v_total numeric(12, 2);
  v_order_id uuid;
  v_reference text;
begin
  v_result := public.place_order_without_volume_offers(
    p_customer,
    p_items,
    p_delivery_method,
    p_referral_code,
    p_telegram_token
  );

  select
    coalesce(sum(greatest(0, coalesce((value->>'qty')::integer, 0))), 0)::integer,
    coalesce(sum(
      greatest(0, coalesce((value->>'qty')::integer, 0))
      * greatest(0, coalesce((value->>'price_each')::numeric, 0))
    ), 0)::numeric(12, 2)
  into v_total_quantity, v_product_subtotal
  from jsonb_array_elements(v_result->'items');

  if v_total_quantity >= 3 then
    v_discount := round(v_product_subtotal * 0.10, 2);
  end if;

  for v_item in select value from jsonb_array_elements(v_result->'items')
  loop
    v_quantity := greatest(0, coalesce((v_item->>'qty')::integer, 0));
    v_unit_price := greatest(0, coalesce((v_item->>'price_each')::numeric, 0));
    v_regular_line_total := v_unit_price * v_quantity;
    v_line_discount := case
      when v_total_quantity >= 3 then round(v_regular_line_total * 0.10, 2)
      else 0
    end;

    v_items := v_items || jsonb_build_array(
      v_item || jsonb_build_object(
        'line_total', v_regular_line_total - v_line_discount,
        'promotion_discount', v_line_discount,
        'promotion_label', case
          when v_total_quantity >= 3 then '10% multi-product discount'
          else null
        end
      )
    );
  end loop;

  v_order_id := (v_result->>'order_id')::uuid;
  v_reference := v_result->>'reference';
  v_total := greatest(0, (v_result->>'total_amount')::numeric - v_discount);

  update public."Orders"
  set total_amount = v_total,
      details = details
        || jsonb_build_object('items', v_items)
        || jsonb_build_object(
          'meta',
          coalesce(details->'meta', '{}'::jsonb)
          || jsonb_build_object('promotion_discount', v_discount)
        )
  where id = v_order_id;

  update public."ReferralEvents"
  set order_total = v_total
  where order_reference = v_reference;

  return v_result || jsonb_build_object(
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
