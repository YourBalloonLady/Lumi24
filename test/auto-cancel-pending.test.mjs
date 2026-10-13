import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  ADMIN_SUMMARY_CHAT_ID,
  CANCELLED_EMAIL_TEMPLATE_ID,
  autoCancelCutoff,
  autoCancelSummary,
  cancelledEmailTemplateParams,
  cancelledOrderDate,
  runAutoCancelPending,
  sendCancelledEmail,
} from '../supabase/functions/_shared/auto-cancel-pending.js';

const PHONE = 'PHONE-SHOULD-NOT-APPEAR';
const NOW = new Date('2026-10-13T15:30:00.000Z');
const CUTOFF = autoCancelCutoff(NOW);
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_OLD = '7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';
const ORDER_GROUP = '8ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';
const ORDER_PAID = '9ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';
const ORDER_YOUNG = 'aad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';
const ORDER_BAD = 'bad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';

function details(items, extraMeta = {}) {
  return JSON.stringify({
    customer: { name: 'Ada', email: 'buyer@example.com', phone: PHONE },
    items,
    meta: extraMeta,
  });
}

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create schema extensions;
    create function extensions.gen_random_bytes(n integer)
    returns bytea language plpgsql as $$
    begin
      return decode(repeat('ab', n), 'hex');
    end $$;
    create schema vault;
    create table vault.secrets (
      id uuid primary key default gen_random_uuid(),
      name text unique,
      description text,
      secret text
    );
    create view vault.decrypted_secrets as
      select id, name, description, secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(
      new_secret text,
      new_name text default null,
      new_description text default null,
      new_key_id uuid default null
    ) returns uuid language plpgsql as $$
    declare
      v_id uuid := gen_random_uuid();
    begin
      insert into vault.secrets (id, name, description, secret)
      values (v_id, new_name, new_description, new_secret);
      return v_id;
    end $$;
    create schema auth;
    create function auth.email() returns text language sql as $$
      select 'luminaweight@gmail.com'
    $$;
    create table public."Products" (
      id uuid primary key,
      name text not null,
      stock integer not null,
      stock_group_id text
    );
    create table public.stock_groups (
      id text primary key,
      stock integer not null,
      updated_at timestamp with time zone
    );
    create table public."Orders" (
      id uuid primary key,
      reference text not null,
      status text not null,
      total_amount numeric(12, 2) not null,
      created_at timestamp without time zone not null,
      details jsonb not null default '{}'::jsonb
    );
  `);
  const payment = await readFile(
    new URL('../supabase/migrations/20261009173000_payment_link_paid_event.sql', import.meta.url),
    'utf8',
  );
  const cancel = await readFile(
    new URL('../supabase/migrations/20261013163000_auto_cancel_pending_orders.sql', import.meta.url),
    'utf8',
  );
  const alert = await readFile(
    new URL('../supabase/migrations/20261013163100_cancelled_payment_alert.sql', import.meta.url),
    'utf8',
  );
  await db.exec(payment);
  await db.exec(cancel);
  await db.exec(alert);
  await db.exec(`
    insert into public.stock_groups (id, stock) values ('semaglutide-20mg', 10);
    insert into public."Products" (id, name, stock, stock_group_id) values
      ('${PRODUCT_ID}', 'Vitamin', 5, null),
      ('${GROUP_PRODUCT_ID}', 'Semaglutide 20mg', 3, 'semaglutide-20mg');
  `);
  return db;
}

test('the cancelled email uses the admin template fields and a 24 hour cutoff', async () => {
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(admin, /template_cancelled/);
  assert.match(admin, /cancel_order_and_restock/);
  assert.match(admin, /function sendCancelledEmail\(order\)/);
  const params = cancelledEmailTemplateParams({
    email: 'buyer@example.com',
    customer_name: 'Ada',
    reference: 'LWAB12CD34',
    created_at_utc: '2026-10-12T13:07:54Z',
    phone: PHONE,
  });
  assert.deepEqual(Object.keys(params).sort(), ['customer_name', 'email', 'order_date', 'order_ref']);
  assert.equal(params.order_ref, 'LWAB12CD34');
  assert.equal(params.customer_name, 'Ada');
  assert.equal(params.order_date, cancelledOrderDate('2026-10-12T13:07:54Z'));
  assert.match(params.order_date, /12\/10\/2026/);
  assert.match(params.order_date, /14:07:54/);
  assert.equal(JSON.stringify(params).includes(PHONE), false);
  assert.equal(autoCancelCutoff(NOW), '2026-10-12T15:30:00.000Z');
  assert.equal(
    autoCancelSummary(['LWAB12CD34', 'LWCD34EF56']),
    'Auto-cancelled 2 pending orders after 24 hours: LWAB12CD34, LWCD34EF56',
  );
  assert.equal(ADMIN_SUMMARY_CHAT_ID, '5839927114');
});

test('a dry run lists due orders and does not cancel, email, or telegram', async () => {
  let claimed = false;
  const result = await runAutoCancelPending({
    now: NOW,
    dryRun: true,
    preview: async (cutoff) => {
      assert.equal(cutoff, CUTOFF);
      return [{
        reference: 'LWAB12CD34',
        created_at: '2026-10-12T10:00:00.000Z',
        due_at: '2026-10-13T10:00:00.000Z',
        email: 'buyer@example.com',
        phone: PHONE,
      }];
    },
    claim: async () => { claimed = true; return { status: 'none' }; },
    claimEmail: async () => { claimed = true; return { status: 'none' }; },
    finishEmail: async () => { claimed = true; },
    sendEmail: async () => { claimed = true; },
    sendTelegram: async () => { claimed = true; },
  });
  assert.equal(claimed, false);
  assert.equal(result.cancelled, 0);
  assert.equal(result.telegram, 'skipped');
  assert.deepEqual(result.orders, [{
    reference: 'LWAB12CD34',
    created_at: '2026-10-12T10:00:00.000Z',
    due_at: '2026-10-13T10:00:00.000Z',
  }]);
  assert.equal(JSON.stringify(result).includes(PHONE), false);
  assert.equal(JSON.stringify(result).includes('@'), false);
});

test('a live run sends the cancelled template once and tells only the admin chat', async () => {
  const emails = [];
  const telegrams = [];
  const finished = [];
  let claims = 0;
  const result = await runAutoCancelPending({
    now: NOW,
    preview: async () => { throw new Error('preview is only for a dry run'); },
    claim: async () => {
      claims += 1;
      if (claims > 1) return { status: 'none' };
      return {
        status: 'Cancelled',
        order_id: ORDER_OLD,
        reference: 'LWAB12CD34',
        email: 'buyer@example.com',
        customer_name: 'Ada',
        created_at_utc: '2026-10-12T10:00:00Z',
        email_pending: true,
        phone: PHONE,
        details: { customer: { phone: PHONE } },
      };
    },
    claimEmail: async () => ({ status: 'none' }),
    finishEmail: async (orderId, outcome) => finished.push([orderId, outcome]),
    sendEmail: async (params) => emails.push(params),
    sendTelegram: async (text) => telegrams.push(text),
  });
  assert.equal(result.cancelled, 1);
  assert.equal(result.emails_sent, 1);
  assert.equal(result.telegram, 'sent');
  assert.deepEqual(result.references, ['LWAB12CD34']);
  assert.equal(emails[0].order_ref, 'LWAB12CD34');
  assert.equal(finished[0][1], 'sent');
  assert.equal(telegrams[0], 'Auto-cancelled 1 pending order after 24 hours: LWAB12CD34');
  assert.equal(JSON.stringify(result).includes(PHONE), false);
  assert.equal(JSON.stringify(result).includes('buyer@example.com'), false);
});

test('EmailJS gets the cancelled template and a failed email does not undo the cancel', async () => {
  const calls = [];
  await sendCancelledEmail({
    params: cancelledEmailTemplateParams({
      email: 'buyer@example.com',
      customer_name: 'Ada',
      reference: 'LWAB12CD34',
      created_at_utc: '2026-10-12T10:00:00Z',
    }),
    privateKey: 'private',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    },
  });
  assert.equal(calls[0].url, 'https://api.emailjs.com/api/v1.0/email/send');
  assert.equal(calls[0].body.template_id, CANCELLED_EMAIL_TEMPLATE_ID);
  assert.equal(calls[0].body.service_id, 'service_i5zi096');
  assert.deepEqual(Object.keys(calls[0].body.template_params).sort(), [
    'customer_name',
    'email',
    'order_date',
    'order_ref',
  ]);

  const finished = [];
  let claims = 0;
  const result = await runAutoCancelPending({
    now: NOW,
    claim: async () => {
      claims += 1;
      if (claims > 1) return { status: 'none' };
      return {
        status: 'Cancelled',
        order_id: ORDER_OLD,
        reference: 'LWAB12CD34',
        email: 'buyer@example.com',
        customer_name: 'Ada',
        created_at_utc: '2026-10-12T10:00:00Z',
        email_pending: true,
      };
    },
    claimEmail: async () => ({ status: 'none' }),
    finishEmail: async (_orderId, outcome) => finished.push(outcome),
    sendEmail: async () => { throw new Error('mail down'); },
    sendTelegram: async () => {},
  });
  assert.equal(result.cancelled, 1);
  assert.equal(result.emails_failed, 1);
  assert.deepEqual(finished, ['failed']);
});

test('only a pending order at least 24 hours old is restocked once', async () => {
  const db = await database();
  await db.query(
    `insert into public."Orders" (id, reference, status, total_amount, created_at, details) values
      ($1, 'LW11111111', 'Pending', 20, '2026-10-12 10:00:00', $2::jsonb),
      ($3, 'LW22222222', 'Pending', 30, '2026-10-12 11:00:00', $4::jsonb),
      ($5, 'LW33333333', 'Paid', 20, '2026-10-12 09:00:00', $6::jsonb),
      ($7, 'LW44444444', 'Pending', 20, '2026-10-12 16:00:00', $6::jsonb),
      ($8, 'LW55555555', 'Pending', 20, '2026-10-12 08:00:00', $9::jsonb)`,
    [
      ORDER_OLD,
      details([{ id: PRODUCT_ID, name: 'Vitamin', qty: 2 }]),
      ORDER_GROUP,
      details([
        { name: 'Semaglutide 20mg', qty: 1 },
        { product_id: GROUP_PRODUCT_ID, name: 'Semaglutide 20mg', qty: 2 },
      ]),
      ORDER_PAID,
      details([{ id: PRODUCT_ID, name: 'Vitamin', qty: 1 }]),
      ORDER_YOUNG,
      ORDER_BAD,
      details([{ id: '99999999-9999-4999-8999-999999999999', name: 'Missing', qty: 1 }]),
    ],
  );

  const preview = await db.query(
    `select public.preview_auto_cancel_pending_orders($1::timestamptz) as rows`,
    [CUTOFF],
  );
  assert.deepEqual(preview.rows[0].rows.map((row) => row.reference), ['LW55555555', 'LW11111111', 'LW22222222']);
  assert.equal(JSON.stringify(preview.rows[0].rows).includes(PHONE), false);
  assert.equal(JSON.stringify(preview.rows[0].rows).includes('@'), false);

  const failed = await db.query(
    `select public.claim_auto_cancel_pending_order($1::timestamptz) as row`,
    [CUTOFF],
  );
  assert.equal(failed.rows[0].row.status, 'failed');
  assert.equal(failed.rows[0].row.reference, 'LW55555555');
  const bad = await db.query(`select status, details from public."Orders" where id = $1`, [ORDER_BAD]);
  assert.equal(bad.rows[0].status, 'Pending');
  assert.equal(typeof bad.rows[0].details.meta.auto_cancel_error, 'string');

  const first = await db.query(
    `select public.claim_auto_cancel_pending_order($1::timestamptz) as row`,
    [CUTOFF],
  );
  assert.equal(first.rows[0].row.status, 'Cancelled');
  assert.equal(first.rows[0].row.reference, 'LW11111111');
  assert.equal(first.rows[0].row.email, 'buyer@example.com');
  assert.equal(JSON.stringify(first.rows[0].row).includes(PHONE), false);
  const vitamin = await db.query(`select stock from public."Products" where id = $1`, [PRODUCT_ID]);
  assert.equal(vitamin.rows[0].stock, 7);

  const again = await db.query(
    `select public.claim_auto_cancel_pending_order($1::timestamptz) as row`,
    [CUTOFF],
  );
  assert.equal(again.rows[0].row.reference, 'LW22222222');
  const group = await db.query(`select stock from public.stock_groups where id = 'semaglutide-20mg'`);
  const groupProduct = await db.query(`select stock from public."Products" where id = $1`, [GROUP_PRODUCT_ID]);
  assert.equal(group.rows[0].stock, 13);
  assert.equal(groupProduct.rows[0].stock, 3);

  const none = await db.query(
    `select public.claim_auto_cancel_pending_order($1::timestamptz) as row`,
    [CUTOFF],
  );
  assert.equal(none.rows[0].row.status, 'none');
  const paid = await db.query(`select status from public."Orders" where id = $1`, [ORDER_PAID]);
  const young = await db.query(`select status from public."Orders" where id = $1`, [ORDER_YOUNG]);
  assert.equal(paid.rows[0].status, 'Paid');
  assert.equal(young.rows[0].status, 'Pending');
  assert.equal((await db.query(`select stock from public."Products" where id = $1`, [PRODUCT_ID])).rows[0].stock, 7);

  const secondCancel = await db.query(
    `select public.perform_cancel_and_restock($1::uuid, 'cron', true) as row`,
    [ORDER_OLD],
  );
  assert.equal(secondCancel.rows[0].row.status, 'skipped');
  assert.equal((await db.query(`select stock from public."Products" where id = $1`, [PRODUCT_ID])).rows[0].stock, 7);

  const skippedPaid = await db.query(
    `select public.perform_cancel_and_restock($1::uuid, 'cron', true) as row`,
    [ORDER_PAID],
  );
  assert.equal(skippedPaid.rows[0].row.status, 'skipped');
  assert.equal((await db.query(`select status from public."Orders" where id = $1`, [ORDER_PAID])).rows[0].status, 'Paid');

  const payment = await db.query(
    `select public.apply_payment_link_event('evt_late', 'checkout.session.completed', 'LW11111111', 2000, 'gbp', 'paid', 'cs_late') as result`,
  );
  assert.equal(payment.rows[0].result.marked_paid, false);
  assert.equal(payment.rows[0].result.outcome, 'cancelled_paid');
  assert.equal(payment.rows[0].result.alert_admin, true);
  const cancelled = await db.query(`select status from public."Orders" where id = $1`, [ORDER_OLD]);
  assert.equal(cancelled.rows[0].status, 'Cancelled');

  await db.exec('set role anon');
  await assert.rejects(
    () => db.query(`select public.claim_auto_cancel_pending_order('${CUTOFF}'::timestamptz)`),
    /permission denied/,
  );
  await db.close();
});
