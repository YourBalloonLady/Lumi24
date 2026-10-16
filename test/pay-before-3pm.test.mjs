import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  ADMIN_SUMMARY_CHAT_ID,
  PAYMENT_CONFIRMATION_NOTICE,
  PAY_BEFORE_3PM_TEMPLATE_ID,
  londonParts,
  payBefore3pmSummary,
  payBefore3pmTemplateParams,
  reminderDecision,
  runPayBefore3pmReminders,
  sendPayBefore3pmEmail,
} from '../supabase/functions/_shared/pay-before-3pm.js';

const PHONE = 'PHONE-SHOULD-NOT-APPEAR';
const CUTOFF = '2026-10-13T13:00:00.000Z';

test('14:00 UK follows BST and GMT, including the clock changes', () => {
  assert.equal(reminderDecision(new Date('2026-10-13T13:00:00Z'), false).due, true);
  assert.equal(londonParts(new Date('2026-10-13T13:00:00Z')).hour, 14);
  assert.equal(reminderDecision(new Date('2026-10-13T12:59:00Z'), false).reason, 'not_due');
  assert.equal(reminderDecision(new Date('2026-10-13T14:00:00Z'), false).reason, 'not_due');
  assert.equal(reminderDecision(new Date('2026-01-15T14:00:00Z'), false).due, true);
  assert.equal(reminderDecision(new Date('2026-01-15T13:00:00Z'), false).reason, 'not_due');
  assert.equal(reminderDecision(new Date('2026-03-29T13:00:00Z'), false).due, true);
  assert.equal(reminderDecision(new Date('2026-10-25T14:00:00Z'), false).due, true);
  assert.equal(reminderDecision(new Date('2026-10-25T13:00:00Z'), false).reason, 'not_due');
  assert.equal(reminderDecision(new Date('2026-10-19T13:00:00Z'), true).due, true);
  assert.equal(reminderDecision(new Date('2026-10-19T13:00:00Z'), true).reason, null);
});

test('the 3pm reminder uses the admin EmailJS template and the same fields', async () => {
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  const notice = admin.match(/const PAYMENT_CONFIRMATION_NOTICE = "([^"]+)";/)[1];
  assert.equal(PAYMENT_CONFIRMATION_NOTICE, notice);
  assert.match(admin, /template_paybefore3pm/);
  assert.match(admin, /pay_before_3pm_sent_at/);

  const params = payBefore3pmTemplateParams({
    email: 'Buyer@Example.com',
    customerName: 'Ada',
    reference: 'LWAB12CD34',
    totalAmount: 42.5,
    phone: PHONE,
  });
  assert.deepEqual(params, {
    email: 'Buyer@Example.com',
    customer_name: 'Ada',
    order_ref: 'LWAB12CD34',
    order_total: '£42.50',
    payment_confirmation_notice: PAYMENT_CONFIRMATION_NOTICE,
  });
  assert.equal(JSON.stringify(params).includes(PHONE), false);
  assert.equal(payBefore3pmSummary(['LWAB12CD34', 'LWCD34EF56']),
    'Sent 3pm payment email to 2 pending orders: LWAB12CD34, LWCD34EF56');
});

test('a due run sends the template once and tells only the admin chat', async () => {
  const emails = [];
  const telegrams = [];
  const finished = [];
  let claimed = false;
  const result = await runPayBefore3pmReminders({
    now: new Date('2026-10-13T13:00:00Z'),
    paused: false,
    preview: async () => { throw new Error('preview is only for a dry run'); },
    claim: async () => {
      if (claimed) return [];
      claimed = true;
      return [{
        order_id: '7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18',
        reference: 'LWAB12CD34',
        email: 'buyer@example.com',
        customer_name: 'Ada',
        total_amount: 42.5,
        phone: PHONE,
      }];
    },
    finish: async (orderId, outcome) => finished.push([orderId, outcome]),
    sendEmail: async (params) => emails.push(params),
    sendTelegram: async (text) => telegrams.push(text),
  });

  assert.equal(result.sent, 1);
  assert.equal(result.telegram, 'sent');
  assert.deepEqual(emails, [payBefore3pmTemplateParams({
    email: 'buyer@example.com',
    customerName: 'Ada',
    reference: 'LWAB12CD34',
    totalAmount: 42.5,
  })]);
  assert.deepEqual(telegrams, ['Sent 3pm payment email to 1 pending order: LWAB12CD34']);
  assert.deepEqual(finished, [['7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18', 'sent']]);
  assert.equal(JSON.stringify(telegrams).includes(PHONE), false);
  assert.equal(ADMIN_SUMMARY_CHAT_ID, '5839927114');
});

test('orders are not emailed before 14:00 UK, and a delivery pause does not skip them', async () => {
  let calls = 0;
  const early = await runPayBefore3pmReminders({
    now: new Date('2026-10-13T12:30:00Z'),
    claim: async () => { calls += 1; return []; },
    sendEmail: async () => { calls += 1; },
    sendTelegram: async () => { calls += 1; },
  });
  assert.equal(early.skipped, 'not_due');
  assert.equal(calls, 0);

  const paused = await runPayBefore3pmReminders({
    now: new Date('2026-10-19T13:00:00Z'),
    paused: true,
    claim: async () => { calls += 1; return []; },
    sendEmail: async () => { calls += 1; },
  });
  assert.equal(paused.skipped, null);
  assert.equal(paused.sent, 0);
  assert.equal(calls, 1);

  const finished = [];
  const failed = await runPayBefore3pmReminders({
    now: new Date('2026-10-13T13:00:00Z'),
    claim: async () => finished.length ? [] : [{
      order_id: '7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18',
      reference: 'LWAB12CD34',
      email: 'buyer@example.com',
      customer_name: 'Ada',
      total_amount: 10,
    }],
    finish: async (orderId, outcome) => finished.push(outcome),
    sendEmail: async () => { throw new Error('email down'); },
    sendTelegram: async () => { throw new Error('should not telegram'); },
  });
  assert.equal(failed.sent, 0);
  assert.equal(failed.telegram, 'skipped');
  assert.deepEqual(finished, ['failed']);
});

test('a dry run lists references and does not send', async () => {
  let sent = 0;
  const result = await runPayBefore3pmReminders({
    now: new Date('2026-10-13T12:30:00Z'),
    dryRun: true,
    preview: async (cutoff) => {
      assert.equal(cutoff, '2026-10-13T13:00:00.000Z');
      return [{ reference: 'LWAB12CD34', email: 'buyer@example.com' }];
    },
    sendEmail: async () => { sent += 1; },
    sendTelegram: async () => { sent += 1; },
  });
  assert.equal(result.dry_run, true);
  assert.equal(result.due, false);
  assert.deepEqual(result.references, ['LWAB12CD34']);
  assert.equal(sent, 0);
  assert.equal(JSON.stringify(result).includes('buyer@example.com'), false);
});

test('EmailJS is called with template_paybefore3pm only', async () => {
  const calls = [];
  await sendPayBefore3pmEmail({
    params: payBefore3pmTemplateParams({
      email: 'buyer@example.com',
      customerName: 'Ada',
      reference: 'LWAB12CD34',
      totalAmount: 10,
    }),
    privateKey: 'private',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    },
  });
  assert.equal(calls[0].url, 'https://api.emailjs.com/api/v1.0/email/send');
  assert.equal(calls[0].body.template_id, PAY_BEFORE_3PM_TEMPLATE_ID);
  assert.equal(calls[0].body.service_id, 'service_i5zi096');
  assert.deepEqual(Object.keys(calls[0].body.template_params).sort(), [
    'customer_name',
    'email',
    'order_ref',
    'order_total',
    'payment_confirmation_notice',
  ]);
});

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
    create function public.orders_are_paused(p_at timestamptz default now())
    returns boolean language sql stable as $$ select false $$;
    create table public."Orders" (
      id uuid primary key default gen_random_uuid(),
      reference text,
      status text,
      total_amount numeric,
      created_at timestamp without time zone default now(),
      details jsonb
    );
  `);
  const migration = await readFile(
    new URL('../supabase/migrations/20261013130000_pay_before_3pm_reminder.sql', import.meta.url),
    'utf8',
  );
  await db.exec(migration);
  return db;
}

function orderDetails(name, email) {
  return JSON.stringify({
    customer: { name, email, phone: PHONE },
    meta: {},
  });
}

test('only a pending order placed before 14:00 UK is claimed, and only once', async () => {
  const db = await database();
  await db.query(
    `insert into public."Orders" (reference, status, total_amount, created_at, details) values
      ('LWBEFORE1', 'Pending', 12.5, '2026-10-13 12:00:00', $1::jsonb),
      ('LWAFTER01', 'Pending', 9, '2026-10-13 13:30:00', $1::jsonb),
      ('LWPAID001', 'Paid', 9, '2026-10-13 10:00:00', $1::jsonb),
      ('LWCANCEL1', 'Cancelled', 9, '2026-10-13 10:00:00', $1::jsonb),
      ('LWSENT001', 'Pending', 9, '2026-10-13 10:00:00', $2::jsonb)`,
    [
      orderDetails('Ada', 'buyer@example.com'),
      JSON.stringify({
        customer: { name: 'Ada', email: 'buyer@example.com', phone: PHONE },
        meta: { pay_before_3pm_sent_at: '2026-10-12T13:00:00Z', pay_before_3pm_sent_by: 'admin' },
      }),
    ],
  );

  const first = await db.query(
    `select public.claim_pay_before_3pm_reminders($1::timestamptz, 50) as rows`,
    [CUTOFF],
  );
  const claimed = first.rows[0].rows;
  assert.deepEqual(claimed.map((row) => row.reference), ['LWBEFORE1']);
  assert.equal(JSON.stringify(claimed).includes(PHONE), false);
  assert.equal(claimed[0].email, 'buyer@example.com');
  assert.equal(claimed[0].total_amount, 12.5);

  const second = await db.query(
    `select public.claim_pay_before_3pm_reminders($1::timestamptz, 50) as rows`,
    [CUTOFF],
  );
  assert.deepEqual(second.rows[0].rows, []);

  await db.query(
    `select public.finish_pay_before_3pm_reminder($1::uuid, 'failed')`,
    [claimed[0].order_id],
  );
  const retried = await db.query(
    `select public.claim_pay_before_3pm_reminders($1::timestamptz, 50) as rows`,
    [CUTOFF],
  );
  assert.deepEqual(retried.rows[0].rows.map((row) => row.reference), ['LWBEFORE1']);
  await db.query(
    `select public.finish_pay_before_3pm_reminder($1::uuid, 'sent')`,
    [claimed[0].order_id],
  );
  const done = await db.query(
    `select public.claim_pay_before_3pm_reminders($1::timestamptz, 50) as rows`,
    [CUTOFF],
  );
  assert.deepEqual(done.rows[0].rows, []);

  const stored = await db.query(
    `select details->'meta'->>'pay_before_3pm_sent_by' as sent_by
     from public."Orders" where reference = 'LWBEFORE1'`,
  );
  assert.equal(stored.rows[0].sent_by, 'cron');

  const reopen = await readFile(
    new URL('../supabase/migrations/20261016160000_reopen_orders_delivery_ack.sql', import.meta.url),
    'utf8',
  );
  await db.exec(reopen);
  await db.exec(`create or replace function public.orders_are_paused(p_at timestamptz default now())
    returns boolean language sql stable as $$ select true $$`);
  await db.query(
    `insert into public."Orders" (reference, status, total_amount, created_at, details)
     values ('LWSTILL01', 'Pending', 11, '2026-10-13 11:00:00', $1::jsonb)`,
    [orderDetails('Bea', 'still@example.com')],
  );
  const paused = await db.query(
    `select public.preview_pay_before_3pm_reminders($1::timestamptz) as rows`,
    [CUTOFF],
  );
  assert.deepEqual(paused.rows[0].rows.map((row) => row.reference), ['LWSTILL01']);

  await db.exec('set role anon');
  await assert.rejects(
    () => db.query(`select public.claim_pay_before_3pm_reminders('${CUTOFF}'::timestamptz, 50)`),
    /permission denied/,
  );
});
