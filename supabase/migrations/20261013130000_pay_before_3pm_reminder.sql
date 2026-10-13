-- Send the existing 3pm payment reminder once for each still-pending order.
-- pg_cron calls the edge function at 13:00 and 14:00 UTC. The function sends
-- only when it is 14:00 in Europe/London, so BST and GMT both land at 2pm UK.
-- Orders created at or after that day's 14:00 UK wait until the next day.
-- A Telegram or email failure must not mark the reminder as sent.

create or replace function public.pay_before_3pm_settings()
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'cron_secret', coalesce((
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'pay_before_3pm_cron_secret'
      limit 1
    ), '')
  );
$function$;

revoke all on function public.pay_before_3pm_settings() from public;
revoke all on function public.pay_before_3pm_settings() from anon;
revoke all on function public.pay_before_3pm_settings() from authenticated;
grant execute on function public.pay_before_3pm_settings() to service_role;

do $secret$
begin
  if not exists (
    select 1 from vault.secrets where name = 'pay_before_3pm_cron_secret'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'pay_before_3pm_cron_secret',
      'Authenticates the 14:00 UK 3pm payment reminder'
    );
  end if;
end;
$secret$;

create or replace function public.preview_pay_before_3pm_reminders(p_cutoff timestamp with time zone)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if public.orders_are_paused() then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'order_id', picked.id,
      'reference', picked.reference
    ) order by picked.created_at, picked.reference)
    from (
      select o.id, o.reference, o.created_at
      from public."Orders" o
      where pg_catalog.lower(coalesce(o.status, '')) = 'pending'
        and o.created_at at time zone 'UTC' < p_cutoff
        and coalesce(o.details #>> '{meta,pay_before_3pm_sent_at}', '') = ''
        and nullif(pg_catalog.btrim(coalesce(o.details #>> '{customer,email}', '')), '') is not null
      order by o.created_at, o.reference
    ) picked
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.claim_pay_before_3pm_reminders(
  p_cutoff timestamp with time zone,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
  v_row public."Orders"%rowtype;
  v_meta jsonb;
  v_claimed text;
  v_claimed_at timestamp with time zone;
  v_email text;
  v_rows jsonb := '[]'::jsonb;
begin
  if public.orders_are_paused() then
    return '[]'::jsonb;
  end if;

  for v_row in
    select o.*
    from public."Orders" o
    where pg_catalog.lower(coalesce(o.status, '')) = 'pending'
      and o.created_at at time zone 'UTC' < p_cutoff
      and coalesce(o.details #>> '{meta,pay_before_3pm_sent_at}', '') = ''
      and nullif(pg_catalog.btrim(coalesce(o.details #>> '{customer,email}', '')), '') is not null
    order by o.created_at, o.reference
    limit v_limit
    for update skip locked
  loop
    v_meta := coalesce(v_row.details->'meta', '{}'::jsonb);
    if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
      v_meta := '{}'::jsonb;
    end if;

    v_claimed := v_meta->>'pay_before_3pm_claimed_at';
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

    v_email := pg_catalog.btrim(v_row.details #>> '{customer,email}');
    v_meta := pg_catalog.jsonb_set(
      v_meta,
      '{pay_before_3pm_claimed_at}',
      pg_catalog.to_jsonb(pg_catalog.clock_timestamp()),
      true
    );
    update public."Orders"
    set details = pg_catalog.jsonb_set(coalesce(details, '{}'::jsonb), '{meta}', v_meta, true)
    where id = v_row.id;

    v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'order_id', v_row.id,
      'reference', v_row.reference,
      'email', v_email,
      'customer_name', coalesce(nullif(pg_catalog.btrim(v_row.details #>> '{customer,name}'), ''), 'Customer'),
      'total_amount', v_row.total_amount
    ));
  end loop;

  return v_rows;
end;
$function$;

create or replace function public.finish_pay_before_3pm_reminder(
  p_order_id uuid,
  p_result text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_meta jsonb;
begin
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

  v_meta := v_meta - 'pay_before_3pm_claimed_at';
  if p_result = 'sent' then
    v_meta := v_meta || pg_catalog.jsonb_build_object(
      'pay_before_3pm_sent_at', pg_catalog.clock_timestamp(),
      'pay_before_3pm_sent_by', 'cron',
      'pay_before_3pm_result', 'sent'
    );
  else
    v_meta := v_meta || pg_catalog.jsonb_build_object(
      'pay_before_3pm_result', 'failed'
    );
  end if;

  update public."Orders"
  set details = pg_catalog.jsonb_set(coalesce(details, '{}'::jsonb), '{meta}', v_meta, true)
  where id = p_order_id;
end;
$function$;

revoke all on function public.preview_pay_before_3pm_reminders(timestamp with time zone) from public;
revoke all on function public.preview_pay_before_3pm_reminders(timestamp with time zone) from anon;
revoke all on function public.preview_pay_before_3pm_reminders(timestamp with time zone) from authenticated;
grant execute on function public.preview_pay_before_3pm_reminders(timestamp with time zone) to service_role;

revoke all on function public.claim_pay_before_3pm_reminders(timestamp with time zone, integer) from public;
revoke all on function public.claim_pay_before_3pm_reminders(timestamp with time zone, integer) from anon;
revoke all on function public.claim_pay_before_3pm_reminders(timestamp with time zone, integer) from authenticated;
grant execute on function public.claim_pay_before_3pm_reminders(timestamp with time zone, integer) to service_role;

revoke all on function public.finish_pay_before_3pm_reminder(uuid, text) from public;
revoke all on function public.finish_pay_before_3pm_reminder(uuid, text) from anon;
revoke all on function public.finish_pay_before_3pm_reminder(uuid, text) from authenticated;
grant execute on function public.finish_pay_before_3pm_reminder(uuid, text) to service_role;

do $cron$
declare
  v_command text := $cmd$
    select net.http_post(
      url := 'https://qketnqhfjfxbqiuqevnh.supabase.co/functions/v1/send-pay-before-3pm',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'pay_before_3pm_cron_secret'
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cmd$;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'pay-before-3pm-13utc') then
      perform cron.unschedule('pay-before-3pm-13utc');
    end if;
    if exists (select 1 from cron.job where jobname = 'pay-before-3pm-14utc') then
      perform cron.unschedule('pay-before-3pm-14utc');
    end if;
    perform cron.schedule('pay-before-3pm-13utc', '0 13 * * *', v_command);
    perform cron.schedule('pay-before-3pm-14utc', '0 14 * * *', v_command);
  end if;
end;
$cron$;
