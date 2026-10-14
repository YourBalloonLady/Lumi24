-- Customer blocklist. Checkout and a direct Orders insert both use this.
-- The customer only ever sees a neutral error. Match reasons go to Tim's
-- admin Telegram chat and are not returned to the browser.
-- A postcode on its own matches nobody. A surname matches only with the
-- entry's postcode. Another person with the same surname elsewhere is allowed.

create or replace function public.normalise_block_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when cleaned !~ '^[^@[:space:]]+@[^@[:space:]]+$' then ''
    when lower(split_part(cleaned, '@', 2)) in ('gmail.com', 'googlemail.com') then
      regexp_replace(
        split_part(lower(split_part(cleaned, '@', 1)), '+', 1),
        '\.',
        '',
        'g'
      ) || '@gmail.com'
    else lower(cleaned)
  end
  from (select trim(coalesce(p_email, '')) as cleaned) as source;
$function$;

create or replace function public.normalise_block_phone(p_phone text)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_digits text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
begin
  if v_digits = '' then
    return '';
  end if;

  if v_digits like '0044%' then
    v_digits := substring(v_digits from 5);
  elsif v_digits like '44%' and length(v_digits) >= 12 then
    v_digits := substring(v_digits from 3);
  end if;

  while v_digits like '0%' and length(v_digits) > 10 loop
    v_digits := substring(v_digits from 2);
  end loop;

  if length(v_digits) = 10 then
    return v_digits;
  end if;

  return '';
end;
$function$;

create or replace function public.normalise_block_postcode(p_postcode text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select upper(regexp_replace(trim(coalesce(p_postcode, '')), '[^A-Za-z0-9]', '', 'g'));
$function$;

create or replace function public.block_has_word(p_text text, p_word text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select length(trim(coalesce(p_word, ''))) > 0
    and exists (
      select 1
      from regexp_split_to_table(lower(coalesce(p_text, '')), '[^[:alnum:]]+') as word
      where word = lower(trim(p_word))
    );
$function$;

create or replace function public.block_house_matches(p_text text, p_house text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select exists (
    select 1
    from regexp_split_to_table(lower(coalesce(p_text, '')), '[^[:alnum:]]+') as word
    where word <> ''
      and (
        word = lower(trim(coalesce(p_house, '')))
        or (
          lower(trim(coalesce(p_house, ''))) ~ '^[0-9]+$'
          and word ~ ('^' || lower(trim(p_house)) || '[a-z]$')
        )
      )
  );
$function$;

create or replace function public.block_postcode_matches(p_text text, p_postcode_key text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_key text := public.normalise_block_postcode(p_postcode_key);
  v_outward text;
  v_inward text;
begin
  if length(v_key) < 5 then
    return false;
  end if;

  v_outward := left(v_key, length(v_key) - 3);
  v_inward := right(v_key, 3);
  return upper(coalesce(p_text, '')) ~ (
    '(^|[^A-Z0-9])'
    || v_outward
    || '[[:space:]]*'
    || v_inward
    || '([^A-Z0-9]|$)'
  );
end;
$function$;

create table if not exists public.customer_blocklist (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  email text,
  phone text,
  address_line text,
  city text,
  postcode text,
  house_number text not null default '',
  street_token text not null default '',
  surname text not null default '',
  note text,
  email_key text not null default '',
  phone_key text not null default '',
  postcode_key text not null default '',
  active boolean not null default true,
  created_at timestamp with time zone not null default pg_catalog.now(),
  created_by text,
  constraint customer_blocklist_has_matcher check (
    email_key <> ''
    or phone_key <> ''
    or (
      postcode_key <> ''
      and (
        btrim(house_number) <> ''
        or btrim(street_token) <> ''
        or btrim(surname) <> ''
      )
    )
  )
);

create or replace function public.customer_blocklist_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  new.email_key := public.normalise_block_email(new.email);
  new.phone_key := public.normalise_block_phone(new.phone);
  new.postcode_key := public.normalise_block_postcode(new.postcode);
  new.house_number := trim(coalesce(new.house_number, ''));
  new.street_token := trim(coalesce(new.street_token, ''));
  new.surname := trim(coalesce(new.surname, ''));
  if new.active is null then
    new.active := true;
  end if;
  return new;
end;
$function$;

drop trigger if exists customer_blocklist_before_write on public.customer_blocklist;
create trigger customer_blocklist_before_write
before insert or update on public.customer_blocklist
for each row
execute function public.customer_blocklist_before_write();

alter table public.customer_blocklist enable row level security;

drop policy if exists customer_blocklist_admin on public.customer_blocklist;
create policy customer_blocklist_admin
on public.customer_blocklist
for all
to authenticated
using (lower(coalesce(auth.email(), '')) = 'luminaweight@gmail.com')
with check (lower(coalesce(auth.email(), '')) = 'luminaweight@gmail.com');

revoke all on table public.customer_blocklist from public, anon, authenticated;
grant select, insert, update, delete on table public.customer_blocklist to authenticated;
grant select, insert, update, delete on table public.customer_blocklist to service_role;

insert into public.customer_blocklist (
  full_name,
  email,
  phone,
  address_line,
  city,
  postcode,
  house_number,
  street_token,
  surname,
  note,
  created_by
)
select
  'Debby Gerdes',
  'debrakgerdes@gmail.com',
  '+447890873090',
  '23 Lapper Avenue',
  'Wolverhampton',
  'WV4 6PR',
  '23',
  'Lapper',
  'Gerdes',
  'Also known as Debra, Deborah, Debbie and Deb. Match email, phone, WV4 6PR with house 23 or Lapper, or surname Gerdes with that postcode.',
  'seed'
where not exists (
  select 1
  from public.customer_blocklist
  where email_key = public.normalise_block_email('debrakgerdes@gmail.com')
);

create or replace function public.customer_block_customer(p_customer jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case
    when pg_catalog.jsonb_typeof(p_customer) = 'object'
      and p_customer ? 'customer'
      and pg_catalog.jsonb_typeof(p_customer->'customer') = 'object'
      then p_customer->'customer'
    else coalesce(p_customer, '{}'::jsonb)
  end;
$function$;

create or replace function public.customer_block_matches(p_customer jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_customer jsonb := public.customer_block_customer(p_customer);
  v_name text := concat_ws(' ', v_customer->>'name', v_customer->>'full_name');
  v_email_key text := public.normalise_block_email(v_customer->>'email');
  v_address text := concat_ws(
    ' ',
    v_customer->>'address1',
    v_customer->>'address2',
    v_customer->>'address',
    v_customer->>'city'
  );
  v_postcode_text text := concat_ws(
    ' ',
    v_customer->>'postcode',
    v_customer->>'postal_code',
    v_address
  );
  v_phones text[] := array[
    coalesce(v_customer->>'phone', ''),
    coalesce(v_customer->>'tel', ''),
    coalesce(v_customer->>'whatsapp_phone', '')
  ];
  v_entry record;
  v_phone text;
  v_email_hit boolean := false;
  v_phone_hit boolean := false;
  v_address_hit boolean := false;
  v_surname_hit boolean := false;
  v_postcode_hit boolean;
  v_reasons text[] := '{}'::text[];
begin
  for v_entry in
    select *
    from public.customer_blocklist
    where active
  loop
    if v_entry.email_key <> '' and v_entry.email_key = v_email_key then
      v_email_hit := true;
    end if;

    if v_entry.phone_key <> '' then
      foreach v_phone in array v_phones loop
        if public.normalise_block_phone(v_phone) <> ''
          and public.normalise_block_phone(v_phone) = v_entry.phone_key then
          v_phone_hit := true;
        end if;
      end loop;
    end if;

    v_postcode_hit := v_entry.postcode_key <> ''
      and public.block_postcode_matches(v_postcode_text, v_entry.postcode_key);

    if v_postcode_hit and (
      (v_entry.house_number <> '' and public.block_house_matches(v_address, v_entry.house_number))
      or (v_entry.street_token <> '' and public.block_has_word(v_address, v_entry.street_token))
    ) then
      v_address_hit := true;
    end if;

    if v_postcode_hit
      and v_entry.surname <> ''
      and public.block_has_word(v_name, v_entry.surname) then
      v_surname_hit := true;
    end if;
  end loop;

  if v_email_hit then
    v_reasons := v_reasons || array['email'];
  end if;
  if v_phone_hit then
    v_reasons := v_reasons || array['phone'];
  end if;
  if v_address_hit then
    v_reasons := v_reasons || array['address'];
  end if;
  if v_surname_hit then
    v_reasons := v_reasons || array['surname_postcode'];
  end if;

  return pg_catalog.jsonb_build_object(
    'blocked', coalesce(pg_catalog.array_length(v_reasons, 1), 0) > 0,
    'reasons', to_jsonb(v_reasons)
  );
end;
$function$;

create or replace function public.blocked_checkout_notify_payload(
  p_customer jsonb,
  p_reasons text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_customer jsonb := public.customer_block_customer(p_customer);
  v_reasons text[] := coalesce(p_reasons, '{}'::text[]);
  v_matched jsonb := '{}'::jsonb;
  v_address text := nullif(concat_ws(
    ', ',
    nullif(trim(coalesce(v_customer->>'address1', '')), ''),
    nullif(trim(coalesce(v_customer->>'address2', '')), ''),
    nullif(trim(coalesce(v_customer->>'address', '')), ''),
    nullif(trim(coalesce(v_customer->>'city', '')), '')
  ), '');
  v_postcode text := nullif(upper(trim(coalesce(v_customer->>'postcode', v_customer->>'postal_code', ''))), '');
  v_phone text := nullif(trim(coalesce(v_customer->>'phone', v_customer->>'tel', '')), '');
  v_whatsapp text := nullif(trim(coalesce(v_customer->>'whatsapp_phone', '')), '');
  v_name text := nullif(trim(concat_ws(' ', v_customer->>'name', v_customer->>'full_name')), '');
begin
  if 'email' = any (v_reasons) then
    v_matched := v_matched || pg_catalog.jsonb_build_object(
      'email',
      nullif(trim(coalesce(v_customer->>'email', '')), '')
    );
  end if;

  if 'phone' = any (v_reasons) then
    if v_phone is not null and exists (
      select 1
      from public.customer_blocklist as entry
      where entry.active
        and entry.phone_key <> ''
        and entry.phone_key = public.normalise_block_phone(v_phone)
    ) then
      v_matched := v_matched || pg_catalog.jsonb_build_object('phone', v_phone);
    elsif v_whatsapp is not null then
      v_matched := v_matched || pg_catalog.jsonb_build_object('phone', v_whatsapp);
    end if;
  end if;

  if 'surname_postcode' = any (v_reasons) and v_name is not null then
    v_matched := v_matched || pg_catalog.jsonb_build_object('name', v_name);
  end if;

  if 'address' = any (v_reasons) or 'surname_postcode' = any (v_reasons) then
    if v_address is not null then
      v_matched := v_matched || pg_catalog.jsonb_build_object('address', v_address);
    end if;
    if v_postcode is not null then
      v_matched := v_matched || pg_catalog.jsonb_build_object('postcode', v_postcode);
    end if;
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(key, value), '{}'::jsonb)
    into v_matched
  from pg_catalog.jsonb_each(v_matched) as pair(key, value)
  where value <> 'null'::jsonb
    and value <> '""'::jsonb;

  return pg_catalog.jsonb_build_object(
    'reasons', to_jsonb(v_reasons),
    'matched', coalesce(v_matched, '{}'::jsonb)
  );
end;
$function$;

create or replace function public.blocked_checkout_notify_settings()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_secret text := '';
begin
  begin
    select decrypted_secret
      into v_secret
    from vault.decrypted_secrets
    where name = 'blocked_order_notify_secret'
    limit 1;
  exception
    when others then
      v_secret := '';
  end;

  return pg_catalog.jsonb_build_object('notify_secret', coalesce(v_secret, ''));
end;
$function$;

do $secret$
begin
  if to_regnamespace('vault') is null then
    return;
  end if;

  if exists (
    select 1 from vault.secrets where name = 'blocked_order_notify_secret'
  ) then
    return;
  end if;

  perform vault.create_secret(
    encode(extensions.gen_random_bytes(32), 'hex'),
    'blocked_order_notify_secret',
    'Authenticates blocked-checkout Telegram calls'
  );
end
$secret$;

do $http$
begin
  if exists (select 1 from pg_available_extensions where name = 'http')
    and exists (select 1 from pg_namespace where nspname = 'extensions') then
    create extension if not exists http with schema extensions;
  end if;
end
$http$;

create or replace function public.notify_blocked_checkout(
  p_customer jsonb,
  p_reasons text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_secret text := '';
  v_payload jsonb;
  v_status integer;
begin
  if coalesce(pg_catalog.array_length(p_reasons, 1), 0) = 0 then
    return;
  end if;

  begin
    select decrypted_secret
      into v_secret
    from vault.decrypted_secrets
    where name = 'blocked_order_notify_secret'
    limit 1;
  exception
    when others then
      return;
  end;

  if coalesce(v_secret, '') = '' or to_regtype('extensions.http_request') is null then
    return;
  end if;

  v_payload := public.blocked_checkout_notify_payload(p_customer, p_reasons);

  begin
    if exists (select 1 from pg_settings where name = 'http.timeout_msec') then
      perform pg_catalog.set_config('http.timeout_msec', '4000', true);
    end if;

    select response.status
      into v_status
    from extensions.http((
      'POST'::extensions.http_method,
      'https://qketnqhfjfxbqiuqevnh.supabase.co/functions/v1/notify-blocked-checkout',
      array[
        extensions.http_header('Content-Type', 'application/json'),
        extensions.http_header('x-notify-secret', v_secret)
      ],
      'application/json',
      v_payload::text
    )::extensions.http_request) as response;

    if v_status >= 400 then
      raise log 'blocked checkout notify returned %', v_status;
    end if;
  exception
    when others then
      raise log 'blocked checkout notify skipped: %', sqlerrm;
  end;
end;
$function$;

create or replace function public.enforce_customer_block(p_customer jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_match jsonb := public.customer_block_matches(p_customer);
  v_blocked boolean := coalesce((v_match->>'blocked')::boolean, false);
  v_reasons text[] := '{}'::text[];
begin
  if v_blocked then
    select coalesce(array_agg(item.value order by item.ordinality), '{}'::text[])
      into v_reasons
    from pg_catalog.jsonb_array_elements_text(v_match->'reasons') with ordinality as item(value, ordinality);
  end if;

  if public.orders_are_paused(pg_catalog.now()) then
    if v_blocked then
      perform public.notify_blocked_checkout(p_customer, v_reasons);
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'Orders are paused until Monday 26th October';
  end if;

  if v_blocked then
    perform public.notify_blocked_checkout(p_customer, v_reasons);
    raise exception using
      errcode = 'P0001',
      message = 'We''re unable to process this order. Please contact us.';
  end if;
end;
$function$;

create or replace function public.reject_blocked_order_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.enforce_customer_block(new.details);
  return new;
end;
$function$;

-- Runs before orders_reject_during_pause so a blocked attempt during the
-- ordering pause still alerts Tim, while the customer sees the pause message.
drop trigger if exists orders_guard_customer_block on public."Orders";
create trigger orders_guard_customer_block
before insert on public."Orders"
for each row
execute function public.reject_blocked_order_insert();

do $guard$
begin
  if to_regprocedure('public.place_order_before_blocklist(jsonb,jsonb,text,text,text)') is null
    and to_regprocedure('public.place_order(jsonb,jsonb,text,text,text)') is not null then
    alter function public.place_order(jsonb, jsonb, text, text, text)
      rename to place_order_before_blocklist;
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
  perform public.enforce_customer_block(p_customer);

  if to_regprocedure('public.place_order_before_blocklist(jsonb,jsonb,text,text,text)') is null then
    raise exception using
      errcode = 'P0001',
      message = 'Checkout is not available.';
  end if;

  return public.place_order_before_blocklist(
    p_customer,
    p_items,
    p_delivery_method,
    p_referral_code,
    p_telegram_token
  );
end;
$function$;

revoke all on function public.place_order_before_blocklist(jsonb, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.normalise_block_email(text) from public, anon, authenticated;
revoke all on function public.normalise_block_phone(text) from public, anon, authenticated;
revoke all on function public.normalise_block_postcode(text) from public, anon, authenticated;
revoke all on function public.block_has_word(text, text) from public, anon, authenticated;
revoke all on function public.block_house_matches(text, text) from public, anon, authenticated;
revoke all on function public.block_postcode_matches(text, text) from public, anon, authenticated;
revoke all on function public.customer_block_customer(jsonb) from public, anon, authenticated;
revoke all on function public.customer_block_matches(jsonb) from public, anon, authenticated;
revoke all on function public.blocked_checkout_notify_payload(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.blocked_checkout_notify_settings() from public, anon, authenticated;
revoke all on function public.notify_blocked_checkout(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.enforce_customer_block(jsonb) from public, anon, authenticated;
revoke all on function public.customer_blocklist_before_write() from public, anon, authenticated;
revoke all on function public.reject_blocked_order_insert() from public, anon, authenticated;

grant execute on function public.place_order(jsonb, jsonb, text, text, text)
  to anon, authenticated, service_role;
grant execute on function public.customer_block_matches(jsonb) to service_role;
grant execute on function public.blocked_checkout_notify_settings() to service_role;
grant execute on function public.customer_blocklist_before_write() to authenticated, service_role;
grant execute on function public.reject_blocked_order_insert()
  to public, anon, authenticated, service_role;
