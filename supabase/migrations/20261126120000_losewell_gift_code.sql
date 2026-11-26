-- Store one LoseWell access code per paid order. A second caller sees the
-- saved code and does not ask LoseWell for another. A claim with no code yet
-- blocks a parallel caller for two minutes, then can be retried.

create or replace function public.claim_losewell_gift(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_details jsonb;
  v_meta jsonb;
  v_code text;
  v_claim timestamp with time zone;
begin
  select *
  into v_order
  from public."Orders"
  where id = p_order_id
  for update;

  if v_order.id is null then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  v_details := coalesce(v_order.details, '{}'::jsonb);
  v_meta := coalesce(v_details->'meta', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
    v_meta := '{}'::jsonb;
  end if;

  v_code := pg_catalog.btrim(coalesce(v_meta->>'losewell_code', ''));
  if v_code <> '' then
    return pg_catalog.jsonb_build_object('status', 'issued', 'code', v_code);
  end if;

  begin
    v_claim := nullif(v_meta->>'losewell_claimed_at', '')::timestamp with time zone;
  exception when others then
    v_claim := null;
  end;

  if v_claim is not null
     and v_claim > pg_catalog.clock_timestamp() - interval '2 minutes' then
    return pg_catalog.jsonb_build_object('status', 'pending');
  end if;

  v_meta := v_meta || pg_catalog.jsonb_build_object(
    'losewell_claimed_at', pg_catalog.clock_timestamp(),
    'losewell_status', 'claiming'
  );
  update public."Orders"
  set details = pg_catalog.jsonb_set(v_details, '{meta}', v_meta, true)
  where id = v_order.id;

  return pg_catalog.jsonb_build_object('status', 'claim');
end;
$function$;

create or replace function public.store_losewell_gift(
  p_order_id uuid,
  p_code text,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public."Orders"%rowtype;
  v_details jsonb;
  v_meta jsonb;
  v_existing text;
  v_code text;
begin
  select *
  into v_order
  from public."Orders"
  where id = p_order_id
  for update;

  if v_order.id is null then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  v_details := coalesce(v_order.details, '{}'::jsonb);
  v_meta := coalesce(v_details->'meta', '{}'::jsonb);
  if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
    v_meta := '{}'::jsonb;
  end if;

  v_existing := pg_catalog.btrim(coalesce(v_meta->>'losewell_code', ''));
  if v_existing <> '' then
    return pg_catalog.jsonb_build_object('status', 'issued', 'code', v_existing);
  end if;

  v_code := pg_catalog.btrim(coalesce(p_code, ''));
  if v_code <> '' then
    v_meta := (v_meta || pg_catalog.jsonb_build_object(
      'losewell_code', v_code,
      'losewell_status', 'issued',
      'losewell_issued_at', pg_catalog.clock_timestamp()
    )) - 'losewell_claimed_at';
  else
    v_meta := (v_meta || pg_catalog.jsonb_build_object(
      'losewell_status', coalesce(nullif(pg_catalog.btrim(p_status), ''), 'failed')
    )) - 'losewell_claimed_at';
  end if;

  update public."Orders"
  set details = pg_catalog.jsonb_set(v_details, '{meta}', v_meta, true)
  where id = v_order.id;

  return pg_catalog.jsonb_build_object(
    'status', case when v_code <> '' then 'issued' else coalesce(nullif(pg_catalog.btrim(p_status), ''), 'failed') end,
    'code', v_code
  );
end;
$function$;

revoke all on function public.claim_losewell_gift(uuid) from public, anon, authenticated;
revoke all on function public.store_losewell_gift(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_losewell_gift(uuid) to service_role;
grant execute on function public.store_losewell_gift(uuid, text, text) to service_role;
