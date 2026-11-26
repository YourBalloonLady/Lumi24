import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { deliverPaidOrderEffects } from '../supabase/functions/_shared/paid-order-effects.js';
import {
  LOSEWELL_GIFT_URL,
  LOSEWELL_POSTER_URL,
  LOSEWELL_REDEEM_URL,
  ensureLoseWellCode,
  losewellEmailFields,
  losewellSectionHtml,
  losewellSectionText,
  requestLoseWellGift,
} from '../supabase/functions/_shared/losewell-gift.js';

const ORDER_ID = '7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';
const HEADLINE = "You don't have to do this alone";
const BODY = 'Your Lumi24 order includes complimentary lifetime access to LoseWell — our companion app built to support you through a healthier way of losing weight, with simple daily guidance to help you stay on track.';
const INSTRUCTION = 'Sign up or sign in with this email address and enter your code to unlock complimentary lifetime access — no card or subscription required.';

function assertApprovedCopy(value, code) {
  assert.match(value, new RegExp(HEADLINE));
  assert.match(value, new RegExp(BODY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(value, new RegExp(INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(value, new RegExp(`Personal access code:.*${code}`));
  assert.match(value, new RegExp(LOSEWELL_REDEEM_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(value, new RegExp(LOSEWELL_POSTER_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

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
  const paid = await readFile(new URL('../supabase/migrations/20261009180000_paid_order_effects.sql', import.meta.url), 'utf8');
  const gift = await readFile(new URL('../supabase/migrations/20261126120000_losewell_gift_code.sql', import.meta.url), 'utf8');
  await db.exec(paid);
  await db.exec(gift);
  await db.query(
    `insert into public."Orders" (id, reference, status, total_amount, details)
     values ($1, 'LWAB12CD34', 'Paid', 40.00, $2::jsonb)`,
    [ORDER_ID, JSON.stringify({ customer: { email: 'ada@example.com', name: 'Ada Lovelace' } })],
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
    if (name === 'claim_losewell_gift') {
      const result = await db.query(
        `select public.claim_losewell_gift($1::uuid) as result`,
        [args.p_order_id],
      );
      return result.rows[0].result;
    }
    if (name === 'store_losewell_gift') {
      const result = await db.query(
        `select public.store_losewell_gift($1::uuid, $2::text, $3::text) as result`,
        [args.p_order_id, args.p_code, args.p_status],
      );
      return result.rows[0].result;
    }
    throw new Error(`Unexpected rpc ${name}`);
  };
}

test('the LoseWell section carries the approved copy, code, redeem link and poster', () => {
  const fields = losewellEmailFields('LW-GIFT-1');
  assert.equal(fields.losewell_code, 'LW-GIFT-1');
  assert.equal(fields.losewell_redeem_url, LOSEWELL_REDEEM_URL);
  assert.equal(fields.losewell_poster_url, LOSEWELL_POSTER_URL);
  assertApprovedCopy(fields.losewell_section_text, 'LW-GIFT-1');
  assertApprovedCopy(losewellSectionHtml('LW-GIFT-1'), 'LW-GIFT-1');
  assert.equal(losewellSectionText(''), '');
  assert.match(losewellSectionHtml('A&B<C>'), /A&amp;B&lt;C&gt;/);
});

test('a missing LoseWell secret does not call LoseWell', async () => {
  let called = false;
  const gift = await requestLoseWellGift({
    secret: '',
    order: { order_id: ORDER_ID, order_reference: 'LWAB12CD34', customer_email: 'ada@example.com', customer_name: 'Ada' },
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  });
  assert.equal(gift.status, 'not_configured');
  assert.equal(gift.code, '');
  assert.equal(called, false);
});

test('gift issuance stores one code and a retry reuses it in the paid email', async () => {
  const db = await database();
  const calls = [];
  const emails = [];
  const issueLoseWell = async (order) => {
    calls.push(order);
    return { status: 'issued', code: 'LIFE-ADA' };
  };
  const run = () => deliverPaidOrderEffects({
    orderId: ORDER_ID,
    actor: 'stripe-webhook',
    rpc: rpcFor(db),
    issueLoseWell,
    sendEmail: async (params) => { emails.push(params); },
    sendTelegram: async () => {},
  });

  const first = await run();
  assert.equal(first.losewell, 'issued');
  assert.equal(first.email, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].order_id, ORDER_ID);
  assert.equal(calls[0].order_reference, 'LWAB12CD34');
  assert.equal(calls[0].customer_email, 'ada@example.com');
  assert.equal(calls[0].customer_name, 'Ada Lovelace');
  assert.equal(emails[0].losewell_code, 'LIFE-ADA');
  assertApprovedCopy(emails[0].losewell_section_text, 'LIFE-ADA');
  assertApprovedCopy(emails[0].losewell_section_html, 'LIFE-ADA');

  const second = await run();
  assert.equal(second.email, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(emails.length, 1);
  const stored = await db.query(`select details #>> '{meta,losewell_code}' as code from public."Orders" where id = $1`, [ORDER_ID]);
  assert.equal(stored.rows[0].code, 'LIFE-ADA');
  await db.close();
});

test('a LoseWell failure still sends the paid email without a code', async () => {
  const db = await database();
  const emails = [];
  const result = await deliverPaidOrderEffects({
    orderId: ORDER_ID,
    actor: 'stripe-webhook',
    rpc: rpcFor(db),
    issueLoseWell: async () => { throw new Error('LoseWell is down'); },
    sendEmail: async (params) => { emails.push(params); },
    sendTelegram: async () => {},
  });
  assert.equal(result.email, 'sent');
  assert.equal(result.losewell, 'failed');
  assert.equal(emails[0].losewell_code, '');
  assert.equal(emails[0].losewell_section_text, '');
  await db.close();
});

test('the request uses the shared secret header and default LoseWell URL', async () => {
  const seen = [];
  const gift = await requestLoseWellGift({
    secret: 'shared-secret',
    order: {
      order_id: ORDER_ID,
      order_reference: 'LWAB12CD34',
      customer_email: 'ada@example.com',
      customer_name: 'Ada',
    },
    fetchImpl: async (url, options) => {
      seen.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ losewell_code: 'FROM-LOSEWELL' }) };
    },
  });
  assert.equal(gift.code, 'FROM-LOSEWELL');
  assert.equal(seen[0].url, LOSEWELL_GIFT_URL);
  assert.equal(seen[0].headers['x-lumi24-gift-secret'], 'shared-secret');
  assert.deepEqual(seen[0].body, {
    order_id: ORDER_ID,
    order_reference: 'LWAB12CD34',
    customer_email: 'ada@example.com',
    customer_name: 'Ada',
  });
});

test('a stored code is reused by the dispatch email and is not replaced', async () => {
  const db = await database();
  const rpc = rpcFor(db);
  const first = await ensureLoseWellCode({
    book: {
      order_id: ORDER_ID,
      reference: 'LWAB12CD34',
      customer_email: 'ada@example.com',
      customer_name: 'Ada Lovelace',
    },
    rpc,
    requestGift: async () => ({ status: 'issued', code: 'SHIP-1' }),
  });
  assert.equal(first.code, 'SHIP-1');
  const second = await ensureLoseWellCode({
    book: { order_id: ORDER_ID, reference: 'LWAB12CD34' },
    rpc,
    requestGift: async () => ({ status: 'issued', code: 'SHIP-2' }),
  });
  assert.equal(second.code, 'SHIP-1');

  const order = {
    reference: 'LWAB12CD34',
    total_amount: 40,
    details: {
      customer: { name: 'Ada', email: 'ada@example.com' },
      meta: { losewell_code: second.code, tracking_number: 'AB123' },
      items: [{ qty: 1, name: 'Vial' }],
    },
  };
  const browser = await readFile(new URL('../public/losewell-email.js', import.meta.url), 'utf8');
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(browser, /You don't have to do this alone/);
  assert.match(browser, /https:\/\/losewell\.co\.uk\/redeem/);
  assert.match(browser, /https:\/\/www\.lumi24\.org\/losewell-email-poster\.png/);
  assert.match(admin, /LuminaLoseWell\?\.sectionText\(order\)/);
  assert.match(admin, /LuminaLoseWell\?\.emailParams\(order\)/);
  const text = [
    'Your order LWAB12CD34 has been shipped.',
    losewellSectionText(order.details.meta.losewell_code),
  ].join('\n\n');
  assertApprovedCopy(text, 'SHIP-1');
  await db.close();
});

test('paid and dispatch wiring keeps Stripe payment links untouched', async () => {
  const webhook = await readFile(new URL('../supabase/functions/stripe-payment-link-webhook/index.ts', import.meta.url), 'utf8');
  const paid = await readFile(new URL('../supabase/functions/order-paid-effects/index.ts', import.meta.url), 'utf8');
  assert.match(webhook, /LOSEWELL_GIFT_SECRET/);
  assert.match(webhook, /issueLoseWell/);
  assert.match(paid, /LOSEWELL_GIFT_SECRET/);
  assert.doesNotMatch(webhook, /checkout\.sessions\.create|payment_intent/);
  assert.match(webhook, /STRIPE_WEBHOOK_SECRET/);
});
