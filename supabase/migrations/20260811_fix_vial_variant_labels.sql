do $migration$
declare
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(
    'public.place_order_without_volume_offers(jsonb,jsonb,text,text,text)'::regprocedure
  )
  into v_definition;

  v_updated := replace(
    v_definition,
    'when v_item->>''variant'' in (''full-kit'', ''cartridge-only'') then v_item->>''variant''',
    'when lower(coalesce(v_product.name, '''')) like ''%pen%'' and lower(coalesce(v_product.name, '''')) not like ''%refill pen%'' and v_item->>''variant'' in (''full-kit'', ''cartridge-only'') then v_item->>''variant'''
  );
  v_updated := replace(
    v_updated,
    '''variant'', coalesce(v_variant, ''full-kit''),',
    '''variant'', v_variant,'
  );
  v_updated := replace(
    v_updated,
    '''variant_label'', case when v_variant = ''cartridge-only'' then ''Cartridge Only'' else ''Full Kit (Pen + Cartridge)'' end,',
    '''variant_label'', case when v_variant = ''cartridge-only'' then ''Cartridge Only'' when v_variant = ''full-kit'' then ''Full Kit (Pen + Cartridge)'' else null end,'
  );

  if v_updated = v_definition then
    raise exception 'Expected place_order_without_volume_offers variant logic was not found.';
  end if;

  execute v_updated;
end;
$migration$;

update public."Orders" o
set details = jsonb_set(
  o.details,
  '{items}',
  (
    select jsonb_agg(
      case
        when lower(coalesce(item->>'name', '')) not like '%pen%'
         and item->>'variant' = 'full-kit'
        then item - 'variant' - 'variant_label'
        else item
      end
    )
    from jsonb_array_elements(o.details->'items') item
  ),
  false
)
where jsonb_typeof(o.details->'items') = 'array'
  and exists (
    select 1
    from jsonb_array_elements(o.details->'items') item
    where lower(coalesce(item->>'name', '')) not like '%pen%'
      and item->>'variant' = 'full-kit'
  );
