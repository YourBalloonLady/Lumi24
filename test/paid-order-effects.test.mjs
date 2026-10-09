import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  createServiceRoleRpc,
  deliverPaidOrderEffects,
  paidEmailTemplateParams,
  sendPaidEmailThroughEmailJs,
  sendPaidTelegramUpdate,
} from '../supabase/functions/_shared/paid-order-effects.js';

const ORDER_ID = '7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';
const SECOND_ID = '8ad9fc6c-bc1a-43db-9ed0-c12ab3c71e19';

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create table public."Orders" (
      id uuid primary key,
      reference text,
      status text not null,
      total_amount numeric(12, 2) not null,
      referral_code text,
      details jsonb not null default '{}'::jsonb
    );
    create table public."ReferralCodes" (
      code text primary key,
      owner_email text not null,
      is_active boolean not null default true
    );
    create table public.customers (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      name text,
      credit_balance numeric(12, 2) not null default 0,
      referral_code text unique,
      referred_by text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  const migration = await readFile(
    new URL('../supabase/migrations/20261009180000_paid_order_effects.sql', import.meta.url),
    'utf8',
  );
  await db.exec(migration);
  await db.query(
    `insert into public."ReferralCodes" (code, owner_email, is_active)
     values ('LUM-FRIEND', 'referrer@example.com', true),
            ('LUM-QUIET', 'quiet@example.com', false)`,
  );
  await db.query(
    `insert into public."Orders" (id, reference, status, total_amount, referral_code, details)
     values ($1, 'LWAB12CD34', 'Paid', 20.00, 'LUM-FRIEND', $2::jsonb)`,
    [ORDER_ID, JSON.stringify({
      customer: { email: 'Buyer@Example.com', name: 'Ada' },
      meta: { promotion_discount: '1.00' },
    })],
  );
  return db;
}

function rpcFor(db) {
  return async (name, args) => {
    if (name === 'prepare_paid_order_effects') {
      const result = await db.query(
        `select public.prepare_paid_order_effects($1::uuid, $2::text, $3::text) as result`,
        [args.p_order_id, args.p_order_reference, args.p_actor],
      );
      return result.rows[0].result;
    }
    if (name === 'claim_paid_order_effect') {
      const result = await db.query(
        `select public.claim_paid_order_effect($1::uuid, $2::text) as result`,
        [args.p_order_id, args.p_effect],
      );
      return result.rows[0].result;
    }
    if (name === 'finish_paid_order_effect') {
      const result = await db.query(
        `select public.finish_paid_order_effect($1::uuid, $2::text, $3::text) as result`,
        [args.p_order_id, args.p_effect, args.p_result],
      );
      return result.rows[0].result;
    }
    throw new Error(`Unexpected rpc ${name}`);
  };
}

async function balances(db) {
  const result = await db.query(
    `select email, credit_balance::float8 as credit_balance
     from public.customers
     order by email`,
  );
  return result.rows;
}

test('a paid order sends each effect once and awards both £10 credits once', async () => {
  const db = await database();
  const emails = [];
  const telegrams = [];
  const run = () => deliverPaidOrderEffects({
    orderReference: 'lwab12cd34',
    actor: 'stripe-webhook',
    rpc: rpcFor(db),
    sendEmail: async (params) => { emails.push(params); },
    sendTelegram: async (reference) => { telegrams.push(reference); },
  });

  const first = await run();
  assert.equal(first.credit, 'awarded');
  assert.equal(first.email, 'sent');
  assert.equal(first.telegram, 'sent');
  assert.deepEqual(emails, [{
    email: 'Buyer@Example.com',
    customer_name: 'Ada',
    order_ref: 'LWAB12CD34',
    order_total: '£20.00',
  }]);
  assert.deepEqual(telegrams, ['LWAB12CD34']);
  assert.deepEqual(await balances(db), [
    { email: 'buyer@example.com', credit_balance: 10 },
    { email: 'referrer@example.com', credit_balance: 10 },
  ]);

  const second = await run();
  assert.equal(second.credit, 'already_awarded');
  assert.equal(second.email, 'sent');
  assert.equal(second.telegram, 'sent');
  assert.equal(emails.length, 1);
  assert.equal(telegrams.length, 1);
  assert.deepEqual(await balances(db), [
    { email: 'buyer@example.com', credit_balance: 10 },
    { email: 'referrer@example.com', credit_balance: 10 },
  ]);

  const stored = await db.query(`select details from public."Orders" where id = $1`, [ORDER_ID]);
  assert.equal(stored.rows[0].details.meta.promotion_discount, '1.00');
  assert.equal(stored.rows[0].details.meta.referral_buyer_amount, 10);
  assert.equal(stored.rows[0].details.meta.referral_referrer_amount, 10);
  assert.equal(stored.rows[0].details.meta.paid_email_result, 'sent');
  assert.equal(stored.rows[0].details.meta.paid_telegram_result, 'sent');
  await db.close();
});

test('credit is skipped for self-referral, inactive codes, later orders, and unpaid orders', async () => {
  const db = await database();
  await db.query(
    `update public."Orders" set referral_code = 'LUM-FRIEND', details = $2::jsonb where id = $1`,
    [ORDER_ID, JSON.stringify({ customer: { email: 'referrer@example.com', name: 'Ref' } })],
  );
  const self = await rpcFor(db)('prepare_paid_order_effects', {
    p_order_id: ORDER_ID,
    p_order_reference: null,
    p_actor: 'admin',
  });
  assert.equal(self.credit, 'not_eligible');

  await db.query(`delete from public.customers`);
  await db.query(
    `update public."Orders"
     set referral_code = 'LUM-QUIET',
         details = '{"customer":{"email":"buyer@example.com","name":"Ada"}}'::jsonb
     where id = $1`,
    [ORDER_ID],
  );
  const inactive = await rpcFor(db)('prepare_paid_order_effects', {
    p_order_id: ORDER_ID,
    p_order_reference: null,
    p_actor: 'admin',
  });
  assert.equal(inactive.credit, 'not_eligible');

  await db.query(
    `update public."Orders"
     set referral_code = 'LUM-FRIEND', status = 'Paid'
     where id = $1`,
    [ORDER_ID],
  );
  await rpcFor(db)('prepare_paid_order_effects', {
    p_order_id: ORDER_ID,
    p_order_reference: null,
    p_actor: 'admin',
  });
  await db.query(
    `insert into public."Orders" (id, reference, status, total_amount, referral_code, details)
     values ($1, 'LWAB12CD35', 'Paid', 15, 'LUM-FRIEND', '{"customer":{"email":"buyer@example.com","name":"Ada"}}'::jsonb)`,
    [SECOND_ID],
  );
  const later = await rpcFor(db)('prepare_paid_order_effects', {
    p_order_id: SECOND_ID,
    p_order_reference: null,
    p_actor: 'admin',
  });
  assert.equal(later.credit, 'not_eligible');
  assert.equal(later.email, 'pending');
  assert.deepEqual(await balances(db), [
    { email: 'buyer@example.com', credit_balance: 10 },
    { email: 'referrer@example.com', credit_balance: 10 },
  ]);

  await db.query(`update public."Orders" set status = 'Pending' where id = $1`, [SECOND_ID]);
  const pending = await rpcFor(db)('prepare_paid_order_effects', {
    p_order_id: SECOND_ID,
    p_order_reference: null,
    p_actor: 'admin',
  });
  assert.equal(pending.status, 'not_paid');
  assert.equal(pending.credit, 'not_paid');
  await db.close();
});

test('a failed send releases its claim and a fresh claim can send it again', async () => {
  const db = await database();
  let failEmail = true;
  const emails = [];
  const telegrams = [];
  const run = () => deliverPaidOrderEffects({
    orderId: ORDER_ID,
    actor: 'admin@example.com',
    rpc: rpcFor(db),
    sendEmail: async (params) => {
      if (failEmail) throw new Error('mailbox unavailable');
      emails.push(params.order_ref);
    },
    sendTelegram: async (reference) => { telegrams.push(reference); },
  });

  await assert.rejects(run(), /Paid order notifications failed/);
  assert.deepEqual(telegrams, ['LWAB12CD34']);
  assert.equal(emails.length, 0);

  failEmail = false;
  const retried = await run();
  assert.equal(retried.email, 'sent');
  assert.equal(retried.telegram, 'sent');
  assert.deepEqual(emails, ['LWAB12CD34']);
  assert.deepEqual(telegrams, ['LWAB12CD34']);

  const claimed = await rpcFor(db)('claim_paid_order_effect', {
    p_order_id: ORDER_ID,
    p_effect: 'email',
  });
  assert.equal(claimed, false);
  await db.close();
});

test('anonymous visitors cannot prepare or record paid effects', async () => {
  const db = await database();
  await db.exec('set role anon');
  await assert.rejects(
    db.query(`select public.prepare_paid_order_effects($1::uuid, null, 'anon')`, [ORDER_ID]),
    /permission denied/,
  );
  await db.close();
});

test('email and telegram senders use the existing paid template and order update', async () => {
  assert.deepEqual(paidEmailTemplateParams({
    email: 'buyer@example.com',
    customerName: '',
    reference: 'LWAB12CD34',
    totalAmount: '20',
  }), {
    email: 'buyer@example.com',
    customer_name: 'Customer',
    order_ref: 'LWAB12CD34',
    order_total: '£20.00',
  });

  const requests = [];
  await sendPaidEmailThroughEmailJs({
    params: paidEmailTemplateParams({
      email: 'buyer@example.com',
      customerName: 'Ada',
      reference: 'LWAB12CD34',
      totalAmount: 20,
    }),
    serviceId: 'service_i5zi096',
    templateId: 'template_paid',
    publicKey: 'public-key',
    privateKey: 'private-key',
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, text: async () => 'OK' };
    },
  });
  assert.equal(requests[0].url, 'https://api.emailjs.com/api/v1.0/email/send');
  assert.equal(requests[0].body.template_id, 'template_paid');
  assert.equal(requests[0].body.service_id, 'service_i5zi096');
  assert.equal(requests[0].body.template_params.email, 'buyer@example.com');
  assert.equal(requests[0].body.accessToken, 'private-key');

  const telegram = [];
  const result = await sendPaidTelegramUpdate({
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'service-role',
    orderReference: 'LWAB12CD34',
    fetchImpl: async (url, options) => {
      telegram.push({ url, body: JSON.parse(options.body) });
      return { ok: true, text: async () => 'No Telegram connection for this order' };
    },
  });
  assert.equal(result.noConnection, true);
  assert.equal(telegram[0].url, 'https://example.supabase.co/functions/v1/send-telegram-order-update');
  assert.deepEqual(telegram[0].body, {
    order_reference: 'LWAB12CD34',
    status: 'Paid',
    tracking_number: '',
  });

  await assert.rejects(
    createServiceRoleRpc({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role',
      fetchImpl: async () => ({ ok: false, text: async () => 'buyer@example.com secret failure' }),
    })('prepare_paid_order_effects', {}),
    (error) => {
      assert.equal(error.message, 'Could not update the paid order.');
      assert.equal(String(error).includes('buyer@example.com'), false);
      return true;
    },
  );
});

test('admin paid actions call the shared notification function', async () => {
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  const markPaid = admin.slice(
    admin.indexOf('async function markPaidAndSendById'),
    admin.indexOf('async function cancelAndRestockById'),
  );
  const updateStatus = admin.slice(
    admin.indexOf('async function updateStatus'),
    admin.indexOf('async function copyAddressById'),
  );
  assert.match(markPaid, /runPaidOrderEffects\(orderId\)/);
  assert.match(updateStatus, /runPaidOrderEffects\(id\)/);
  assert.doesNotMatch(markPaid, /sendPaidEmail\(/);
  assert.doesNotMatch(markPaid, /sendTelegramOrderUpdate\(/);
  assert.match(admin, /functions\/v1\/order-paid-effects/);
  assert.doesNotMatch(admin, /awardCreditToCustomerByEmail/);
});
