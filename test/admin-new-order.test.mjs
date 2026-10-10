import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  adminNewOrderMessage,
  deliverAdminNewOrderAlert,
} from '../supabase/functions/_shared/admin-new-order.js';

const PHONE = 'PHONE-SHOULD-NOT-APPEAR';
const EMAIL = 'customer@example.com';
const ADDRESS = '1 Secret Street';
const CUSTOMER_CHAT = '111111111';
const ADMIN_CHAT = '999000111';

function sampleOrder() {
  return {
    reference: 'LWAB12CD34',
    total_amount: 42.5,
    customer_chat_id: CUSTOMER_CHAT,
    details: {
      customer: {
        name: 'Ada <Lovelace>',
        email: EMAIL,
        phone: PHONE,
        address1: ADDRESS,
      },
      items: [
        {
          name: 'Example Pen',
          qty: 2,
          variant: 'full-kit',
          pen_heads: '4mm',
          line_total: 40,
        },
      ],
      delivery: { label: 'Tracked24' },
    },
  };
}

test('new-order message includes the reference, customer, items, total and payment method', () => {
  const message = adminNewOrderMessage(sampleOrder());
  assert.match(message, /LWAB12CD34/);
  assert.match(message, /Ada &lt;Lovelace&gt;/);
  assert.match(message, /2 × Example Pen \(Full Kit \(Pen \+ Cartridge\), Pen heads: 4mm\) — £40\.00/);
  assert.match(message, /Payment method: Card or bank transfer/);
  assert.match(message, /Total: £42\.50/);
  assert.match(message, /Delivery: Tracked24/);
  assert.equal(message.includes(PHONE), false);
  assert.equal(message.includes(EMAIL), false);
  assert.equal(message.includes(ADDRESS), false);
  assert.equal(message.includes(CUSTOMER_CHAT), false);
});

test('payment method uses a stored choice when the order has one', () => {
  const card = adminNewOrderMessage({
    ...sampleOrder(),
    details: { ...sampleOrder().details, meta: { payment_method: 'card' } },
  });
  const bank = adminNewOrderMessage({
    ...sampleOrder(),
    details: { ...sampleOrder().details, meta: { payment_method: 'bank_transfer' } },
  });
  assert.match(card, /Payment method: Card/);
  assert.match(bank, /Payment method: Bank transfer/);
});

test('a Telegram error does not throw and the customer chat is not used', async () => {
  const calls = [];
  const failed = await deliverAdminNewOrderAlert({
    order: sampleOrder(),
    token: 'bot-token',
    chatId: ADMIN_CHAT,
    send: async (request) => {
      calls.push(request);
      throw new Error('telegram down');
    },
  });
  assert.equal(failed.delivered, false);
  assert.equal(failed.reason, 'telegram_error');
  assert.equal(failed.destination, 'admin');
  assert.deepEqual(calls.map((call) => call.chatId), [ADMIN_CHAT]);
  assert.equal(calls.some((call) => call.chatId === CUSTOMER_CHAT), false);

  const skipped = await deliverAdminNewOrderAlert({
    order: sampleOrder(),
    token: '',
    chatId: '',
    send: async () => {
      throw new Error('should not send');
    },
  });
  assert.equal(skipped.delivered, false);
  assert.equal(skipped.reason, 'admin_chat_not_configured');
});

test('the alert code does not call the customer Telegram function', async () => {
  const shared = await readFile(
    new URL('../supabase/functions/_shared/admin-new-order.js', import.meta.url),
    'utf8',
  );
  const endpoint = await readFile(
    new URL('../supabase/functions/notify-admin-new-order/index.ts', import.meta.url),
    'utf8',
  );
  const migration = await readFile(
    new URL('../supabase/migrations/20261010143000_admin_new_order_telegram.sql', import.meta.url),
    'utf8',
  );
  const source = `${shared}\n${endpoint}\n${migration}`;
  assert.equal(source.includes('customer_notification_links'), false);
  assert.equal(source.includes('send-telegram-order-update'), false);
  assert.match(endpoint, /@Admi_181/);
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
    create schema net;
    create table net.calls (
      id bigint generated always as identity primary key,
      url text,
      body jsonb,
      headers jsonb
    );
    create function net.http_post(
      url text,
      body jsonb default '{}'::jsonb,
      params jsonb default '{}'::jsonb,
      headers jsonb default '{}'::jsonb,
      timeout_milliseconds integer default 2000
    ) returns bigint language plpgsql as $$
    declare
      v_id bigint;
    begin
      insert into net.calls (url, body, headers) values (url, body, headers) returning id into v_id;
      return v_id;
    end $$;
    create table public."Orders" (
      id uuid primary key default gen_random_uuid(),
      reference text,
      status text,
      total_amount numeric,
      details jsonb
    );
  `);
  const migration = await readFile(
    new URL('../supabase/migrations/20261010143000_admin_new_order_telegram.sql', import.meta.url),
    'utf8',
  );
  await db.exec(migration);
  return db;
}

test('an order still inserts when the Telegram request fails', async () => {
  const db = await database();
  await db.exec(`
    create or replace function net.http_post(
      url text,
      body jsonb default '{}'::jsonb,
      params jsonb default '{}'::jsonb,
      headers jsonb default '{}'::jsonb,
      timeout_milliseconds integer default 2000
    ) returns bigint language plpgsql as $$
    begin
      raise exception 'telegram down';
    end $$;
  `);
  await db.query(
    `insert into public."Orders" (reference, status, total_amount, details)
     values ('LWAB12CD34', 'Pending', 10, '{"customer":{"name":"Ada"}}'::jsonb)`,
  );
  const saved = await db.query(`select reference from public."Orders"`);
  assert.deepEqual(saved.rows, [{ reference: 'LWAB12CD34' }]);
});

test('a new order queues one admin alert and does not require the customer chat', async () => {
  const db = await database();
  await db.query(
    `insert into public."Orders" (reference, status, total_amount, details)
     values ('LWAB12CD34', 'Pending', 10, '{"customer":{"name":"Ada","phone":"${PHONE}"}}'::jsonb)`,
  );
  const calls = await db.query(`select url, body::text as body from net.calls`);
  assert.equal(calls.rows.length, 1);
  assert.match(calls.rows[0].url, /notify-admin-new-order$/);
  assert.match(calls.rows[0].body, /order_id/);
  assert.equal(calls.rows[0].body.includes(PHONE), false);
  assert.equal(calls.rows[0].url.includes('send-telegram-order-update'), false);

  await db.exec(`delete from vault.secrets where name = 'admin_order_notify_secret'`);
  await db.query(
    `insert into public."Orders" (reference, status, total_amount, details)
     values ('LWCD34EF56', 'Pending', 11, '{}'::jsonb)`,
  );
  const after = await db.query(`select count(*)::int as count from net.calls`);
  assert.equal(after.rows[0].count, 1);

  await db.exec('set role anon');
  await assert.rejects(
    () => db.query('select public.admin_order_notify_settings()'),
    /permission denied/,
  );
});
