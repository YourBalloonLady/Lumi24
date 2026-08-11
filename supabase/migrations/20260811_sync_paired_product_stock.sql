-- Keep vial and pen listings synchronized because they represent shared physical stock.
create or replace function public.shared_stock_key(product_name text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select trim(
    regexp_replace(
      regexp_replace(
        lower(product_name),
        '(^|[[:space:]])(pen|vial)([[:space:]]|$)',
        '\1\3',
        'g'
      ),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
$$;

create or replace function public.sync_paired_product_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delta integer;
  v_partner_count integer;
  v_partner_min_stock integer;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  v_delta := coalesce(old.stock, 0) - coalesce(new.stock, 0);

  if v_delta = 0
     or lower(new.name) !~ '(^|[[:space:]])(pen|vial)([[:space:]]|$)' then
    return new;
  end if;

  perform 1
  from public."Products" partner
  where partner.id <> new.id
    and lower(partner.name) ~ '(^|[[:space:]])(pen|vial)([[:space:]]|$)'
    and public.shared_stock_key(partner.name) = public.shared_stock_key(new.name)
  order by partner.id
  for update;

  select count(*), min(coalesce(partner.stock, 0))
  into v_partner_count, v_partner_min_stock
  from public."Products" partner
  where partner.id <> new.id
    and lower(partner.name) ~ '(^|[[:space:]])(pen|vial)([[:space:]]|$)'
    and public.shared_stock_key(partner.name) = public.shared_stock_key(new.name);

  if v_delta > 0
     and v_partner_count > 0
     and v_partner_min_stock < v_delta then
    raise exception using
      errcode = 'P0001',
      message = format(
        'Only %s shared unit(s) of %s remain in stock.',
        v_partner_min_stock,
        public.shared_stock_key(new.name)
      );
  end if;

  update public."Products" partner
  set stock = greatest(0, coalesce(partner.stock, 0) - v_delta)
  where partner.id <> new.id
    and lower(partner.name) ~ '(^|[[:space:]])(pen|vial)([[:space:]]|$)'
    and public.shared_stock_key(partner.name) = public.shared_stock_key(new.name);

  return new;
end;
$$;

drop trigger if exists sync_paired_product_stock_trigger
on public."Products";

create trigger sync_paired_product_stock_trigger
after update of stock on public."Products"
for each row
when (old.stock is distinct from new.stock)
execute function public.sync_paired_product_stock();
