-- Tell Tim's admin Telegram chat when an order is inserted.
-- The HTTP call is queued and runs only after the order commits.
-- Any Telegram or network error is swallowed so the order still saves.
-- The chat id is not stored in this file. It is read from vault secret
-- telegram_admin_chat_id (Tim, @Admi_181) or TELEGRAM_ADMIN_CHAT_ID.

create or replace function public.admin_order_notify_settings()
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'notify_secret', coalesce((
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'admin_order_notify_secret'
      limit 1
    ), ''),
    'admin_chat_id', coalesce((
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'telegram_admin_chat_id'
      limit 1
    ), '')
  );
$function$;

revoke all on function public.admin_order_notify_settings() from public;
revoke all on function public.admin_order_notify_settings() from anon;
revoke all on function public.admin_order_notify_settings() from authenticated;
grant execute on function public.admin_order_notify_settings() to service_role;

do $do$
begin
  if not exists (
    select 1 from vault.secrets where name = 'admin_order_notify_secret'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'admin_order_notify_secret',
      'Authenticates new-order admin Telegram calls'
    );
  end if;
end;
$do$;

create or replace function public.notify_admin_on_new_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_secret text;
begin
  begin
    select decrypted_secret
      into v_secret
      from vault.decrypted_secrets
     where name = 'admin_order_notify_secret'
     limit 1;

    if coalesce(v_secret, '') = '' then
      return new;
    end if;

    perform net.http_post(
      url := 'https://qketnqhfjfxbqiuqevnh.supabase.co/functions/v1/notify-admin-new-order',
      body := pg_catalog.jsonb_build_object('order_id', new.id),
      params := '{}'::jsonb,
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notify-secret', v_secret
      ),
      timeout_milliseconds := 5000
    );
  exception
    when others then
      raise log 'admin new-order notify skipped: %', sqlerrm;
  end;

  return new;
exception
  when others then
    raise log 'admin new-order notify skipped: %', sqlerrm;
    return null;
end;
$function$;

-- The inserting role must be allowed to run the trigger, or the insert fails.
grant execute on function public.notify_admin_on_new_order() to public;
grant execute on function public.notify_admin_on_new_order() to anon;
grant execute on function public.notify_admin_on_new_order() to authenticated;
grant execute on function public.notify_admin_on_new_order() to service_role;

drop trigger if exists orders_notify_admin_on_insert on public."Orders";
create trigger orders_notify_admin_on_insert
  after insert on public."Orders"
  for each row
  execute function public.notify_admin_on_new_order();
