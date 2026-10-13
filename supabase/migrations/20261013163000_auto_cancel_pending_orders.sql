-- Cancel and restock an order that is still Pending 24 hours after it was
-- placed. The admin button and this job both call perform_cancel_and_restock.
-- created_at is a UTC wall time. The edge function passes now() minus 24 hours.
-- pg_cron runs every 15 minutes, so an order is cancelled on the first run at
-- or after that instant. Ordering pause does not keep an unpaid order open.
-- A row is locked and its status is checked again at the update, so a payment
-- that landed first is left alone and stock is not changed.

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

create or replace function public.cancel_order_and_restock(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_admin_email text := pg_catalog.lower(coalesce(auth.email(), ''));
begin
  if v_admin_email <> 'luminaweight@gmail.com' then
    raise exception using errcode = '42501', message = 'Administrator access is required.';
  end if;

  return public.perform_cancel_and_restock(p_order_id, v_admin_email, false);
end;
$function$;

revoke all on function public.perform_cancel_and_restock(uuid, text, boolean) from public;
revoke all on function public.perform_cancel_and_restock(uuid, text, boolean) from anon;
revoke all on function public.perform_cancel_and_restock(uuid, text, boolean) from authenticated;
grant execute on function public.perform_cancel_and_restock(uuid, text, boolean) to service_role;

revoke all on function public.cancel_order_and_restock(uuid) from public, anon;
grant execute on function public.cancel_order_and_restock(uuid) to authenticated;

create or replace function public.auto_cancel_pending_settings()
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'cron_secret', coalesce((
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'auto_cancel_pending_cron_secret'
      limit 1
    ), '')
  );
$function$;

revoke all on function public.auto_cancel_pending_settings() from public;
revoke all on function public.auto_cancel_pending_settings() from anon;
revoke all on function public.auto_cancel_pending_settings() from authenticated;
grant execute on function public.auto_cancel_pending_settings() to service_role;

do $secret$
begin
  if not exists (
    select 1 from vault.secrets where name = 'auto_cancel_pending_cron_secret'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'auto_cancel_pending_cron_secret',
      'Authenticates the 24-hour pending-order auto-cancel'
    );
  end if;
end;
$secret$;

create or replace function public.preview_auto_cancel_pending_orders(p_cutoff timestamp with time zone)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'reference', picked.reference,
      'created_at', picked.created_at at time zone 'UTC',
      'due_at', (picked.created_at at time zone 'UTC') + interval '24 hours'
    ) order by picked.created_at, picked.reference)
    from (
      select o.reference, o.created_at
      from public."Orders" o
      where pg_catalog.lower(coalesce(o.status, '')) = 'pending'
        and o.created_at at time zone 'UTC' <= p_cutoff
        and coalesce(o.details #>> '{meta,restocked_at}', '') = ''
        and coalesce(o.details #>> '{meta,auto_cancel_error}', '') = ''
      order by o.created_at, o.reference
    ) picked
  ), '[]'::jsonb);
$function$;

create or replace function public.claim_auto_cancel_pending_order(p_cutoff timestamp with time zone)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_reference text;
  v_result jsonb;
  v_message text;
begin
  perform pg_catalog.pg_advisory_xact_lock(2026082401::bigint);

  select o.id, o.reference
  into v_id, v_reference
  from public."Orders" o
  where pg_catalog.lower(coalesce(o.status, '')) = 'pending'
    and o.created_at at time zone 'UTC' <= p_cutoff
    and coalesce(o.details #>> '{meta,restocked_at}', '') = ''
    and coalesce(o.details #>> '{meta,auto_cancel_error}', '') = ''
  order by o.created_at, o.reference
  limit 1
  for update skip locked;

  if v_id is null then
    return pg_catalog.jsonb_build_object('status', 'none');
  end if;

  begin
    v_result := public.perform_cancel_and_restock(v_id, 'cron', true);
  exception
    when others then
      if sqlstate = 'P0001' then
        return pg_catalog.jsonb_build_object(
          'status', 'skipped',
          'reason', 'not_pending',
          'reference', v_reference
        );
      end if;

      v_message := pg_catalog.left(sqlerrm, 180);
      update public."Orders"
      set details = pg_catalog.jsonb_set(
        coalesce(details, '{}'::jsonb),
        '{meta}',
        coalesce(details->'meta', '{}'::jsonb) || pg_catalog.jsonb_build_object(
          'auto_cancel_error', v_message,
          'auto_cancel_error_at', pg_catalog.clock_timestamp()
        ),
        true
      )
      where id = v_id
        and pg_catalog.lower(coalesce(status, '')) = 'pending'
        and coalesce(details #>> '{meta,restocked_at}', '') = '';

      return pg_catalog.jsonb_build_object(
        'status', 'failed',
        'reference', v_reference
      );
  end;

  return v_result;
end;
$function$;

create or replace function public.claim_auto_cancel_email()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_meta jsonb;
  v_claimed text;
  v_claimed_at timestamp with time zone;
  v_email text;
begin
  for v_order in
    select o.*
    from public."Orders" o
    where pg_catalog.lower(coalesce(o.status, '')) = 'cancelled'
      and coalesce(o.details #>> '{meta,auto_cancelled_at}', '') <> ''
      and coalesce(o.details #>> '{meta,cancelled_email_sent_at}', '') = ''
      and nullif(pg_catalog.btrim(coalesce(o.details #>> '{customer,email}', '')), '') is not null
    order by o.created_at, o.reference
    limit 50
    for update skip locked
  loop
    v_meta := coalesce(v_order.details->'meta', '{}'::jsonb);
    if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
      v_meta := '{}'::jsonb;
    end if;

    v_claimed := v_meta->>'cancelled_email_claimed_at';
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

    v_email := pg_catalog.btrim(v_order.details #>> '{customer,email}');
    v_meta := pg_catalog.jsonb_set(
      v_meta,
      '{cancelled_email_claimed_at}',
      pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
      true
    );
    update public."Orders"
    set details = pg_catalog.jsonb_set(coalesce(details, '{}'::jsonb), '{meta}', v_meta, true)
    where id = v_order.id;

    return pg_catalog.jsonb_build_object(
      'status', 'email',
      'order_id', v_order.id,
      'reference', v_order.reference,
      'email', v_email,
      'customer_name', coalesce(
        nullif(pg_catalog.btrim(v_order.details #>> '{customer,name}'), ''),
        'Customer'
      ),
      'created_at_utc', pg_catalog.to_char(v_order.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'email_pending', true
    );
  end loop;

  return pg_catalog.jsonb_build_object('status', 'none');
end;
$function$;

create or replace function public.finish_auto_cancel_email(
  p_order_id uuid,
  p_result text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_meta jsonb;
begin
  if p_result not in ('sent', 'failed') then
    raise exception 'Unknown cancelled email result.';
  end if;

  select coalesce(details->'meta', '{}'::jsonb)
  into v_meta
  from public."Orders"
  where id = p_order_id
  for update;

  if v_meta is null then
    return;
  end if;
  if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
    v_meta := '{}'::jsonb;
  end if;

  if p_result = 'sent' then
    v_meta := (v_meta - 'cancelled_email_claimed_at') || pg_catalog.jsonb_build_object(
      'cancelled_email_sent_at', pg_catalog.clock_timestamp(),
      'cancelled_email_result', 'sent'
    );
  else
    v_meta := v_meta || pg_catalog.jsonb_build_object(
      'cancelled_email_claimed_at', pg_catalog.clock_timestamp(),
      'cancelled_email_result', 'failed'
    );
  end if;

  update public."Orders"
  set details = pg_catalog.jsonb_set(coalesce(details, '{}'::jsonb), '{meta}', v_meta, true)
  where id = p_order_id;
end;
$function$;

revoke all on function public.preview_auto_cancel_pending_orders(timestamp with time zone) from public;
revoke all on function public.preview_auto_cancel_pending_orders(timestamp with time zone) from anon;
revoke all on function public.preview_auto_cancel_pending_orders(timestamp with time zone) from authenticated;
grant execute on function public.preview_auto_cancel_pending_orders(timestamp with time zone) to service_role;

revoke all on function public.claim_auto_cancel_pending_order(timestamp with time zone) from public;
revoke all on function public.claim_auto_cancel_pending_order(timestamp with time zone) from anon;
revoke all on function public.claim_auto_cancel_pending_order(timestamp with time zone) from authenticated;
grant execute on function public.claim_auto_cancel_pending_order(timestamp with time zone) to service_role;

revoke all on function public.claim_auto_cancel_email() from public;
revoke all on function public.claim_auto_cancel_email() from anon;
revoke all on function public.claim_auto_cancel_email() from authenticated;
grant execute on function public.claim_auto_cancel_email() to service_role;

revoke all on function public.finish_auto_cancel_email(uuid, text) from public;
revoke all on function public.finish_auto_cancel_email(uuid, text) from anon;
revoke all on function public.finish_auto_cancel_email(uuid, text) from authenticated;
grant execute on function public.finish_auto_cancel_email(uuid, text) to service_role;

do $cron$
declare
  v_command text := $cmd$
    select net.http_post(
      url := 'https://qketnqhfjfxbqiuqevnh.supabase.co/functions/v1/auto-cancel-pending-orders',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'auto_cancel_pending_cron_secret'
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cmd$;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'auto-cancel-pending-orders') then
      perform cron.unschedule('auto-cancel-pending-orders');
    end if;
    perform cron.schedule('auto-cancel-pending-orders', '*/15 * * * *', v_command);
  end if;
end;
$cron$;
