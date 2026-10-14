import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  BLOCKED_CHECKOUT_CHAT_ID,
  CUSTOMER_BLOCK_MESSAGE,
  blockedCheckoutTelegramText,
  handleBlockedCheckout,
} from '../supabase/functions/_shared/blocked-checkout.js';

const SEEDED_EMAIL = 'debrakgerdes@gmail.com';
const SEEDED_PHONE = '+447890873090';
const NEUTRAL = "We're unable to process this order. Please contact us.";
const PAUSE = 'Orders are paused until Monday 26th October';

async function database() {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create or replace function auth.email() returns text language sql stable as $$ select null::text $$;
    create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create table public."Orders" (
      id uuid primary key default gen_random_uuid(),
      reference text,
      status text,
      total_amount numeric,
      details jsonb not null default '{}'::jsonb
    );
    create or replace function public.orders_are_paused(p_at timestamp with time zone default now())
    returns boolean
    language sql
    stable
    as $$ select false $$;
    create or replace function public.place_order(
      p_customer jsonb,
      p_items jsonb,
      p_delivery_method text default 'tracked24',
      p_referral_code text default null,
      p_telegram_token text default null
    ) returns jsonb
    language plpgsql
    as $function$
    declare
      v_id uuid := gen_random_uuid();
    begin
      insert into public."Orders" (id, reference, status, total_amount, details)
      values (
        v_id,
        'LWABCDEF01',
        'Pending',
        10,
        jsonb_build_object('customer', p_customer, 'items', coalesce(p_items, '[]'::jsonb))
      );
      return jsonb_build_object(
        'order_id', v_id,
        'reference', 'LWABCDEF01',
        'items', '[]'::jsonb,
        'total_amount', 10
      );
    end;
    $function$;
  `);
  const migration = await readFile(
    new URL('../supabase/migrations/20261014100000_customer_blocklist.sql', import.meta.url),
    'utf8',
  );
  await db.exec(migration);
  return db;
}

function matches(db, customer) {
  return db.query(
    'select public.customer_block_matches($1::jsonb) as result',
    [JSON.stringify(customer)],
  ).then((result) => result.rows[0].result);
}

function payload(db, customer, reasons) {
  return db.query(
    'select public.blocked_checkout_notify_payload($1::jsonb, $2::text[]) as result',
    [JSON.stringify(customer), reasons],
  ).then((result) => result.rows[0].result);
}

async function orderCount(db) {
  const result = await db.query('select count(*)::int as count from public."Orders"');
  return result.rows[0].count;
}

async function messageOf(fn) {
  try {
    await fn();
  } catch (error) {
    return String(error.message || error);
  }
  throw new Error('expected the order to be rejected');
}

const other = {
  name: 'Jane Smith',
  email: 'jane.smith@example.com',
  phone: '07123456789',
  address1: '99 High Street',
  city: 'Wolverhampton',
  postcode: 'WV4 6PR',
};

test('the seeded person matches on email, phone, address, or surname with that postcode', async () => {
  const db = await database();
  const seeded = await matches(db, {
    name: 'Debby Gerdes',
    email: SEEDED_EMAIL,
    phone: SEEDED_PHONE,
    address1: '23 Lapper Avenue',
    city: 'Wolverhampton',
    postcode: 'WV4 6PR',
  });
  assert.equal(seeded.blocked, true);
  assert.deepEqual(seeded.reasons, ['email', 'phone', 'address', 'surname_postcode']);

  const gmail = await matches(db, {
    name: 'A Person',
    email: 'debra.k.gerdes+shop@gmail.com',
    phone: '07111111111',
    address1: '10 King Street',
    postcode: 'M1 1AE',
  });
  assert.deepEqual(gmail.reasons, ['email']);

  const googlemail = await matches(db, {
    name: 'A Person',
    email: 'Debra.K.Gerdes@googlemail.com',
    phone: '07111111111',
    address1: '10 King Street',
    postcode: 'M1 1AE',
  });
  assert.deepEqual(googlemail.reasons, ['email']);

  const yahoo = await matches(db, {
    name: 'A Person',
    email: 'debra.k.gerdes@yahoo.com',
    phone: '07111111111',
    address1: '10 King Street',
    postcode: 'M1 1AE',
  });
  assert.equal(yahoo.blocked, false);

  const phone = await matches(db, {
    name: 'A Person',
    email: 'other@example.com',
    phone: '+44 (0)7890 873090',
    address1: '10 King Street',
    postcode: 'M1 1AE',
  });
  assert.deepEqual(phone.reasons, ['phone']);

  const national = await matches(db, {
    name: 'A Person',
    email: 'other@example.com',
    phone: '07890 873090',
    address1: '10 King Street',
    postcode: 'M1 1AE',
  });
  assert.deepEqual(national.reasons, ['phone']);

  const whatsapp = await matches(db, {
    name: 'A Person',
    email: 'other@example.com',
    phone: '07111111111',
    whatsapp_phone: '00447890873090',
    address1: '10 King Street',
    postcode: 'M1 1AE',
  });
  assert.deepEqual(whatsapp.reasons, ['phone']);

  const house = await matches(db, {
    name: 'A Person',
    email: 'other@example.com',
    phone: '07111111111',
    address1: '23A High Street',
    postcode: 'wv4  6pr',
  });
  assert.deepEqual(house.reasons, ['address']);

  const street = await matches(db, {
    name: 'A Person',
    email: 'other@example.com',
    phone: '07111111111',
    address1: '5 lapper avenue',
    postcode: 'WV46PR',
  });
  assert.deepEqual(street.reasons, ['address']);

  const surname = await matches(db, {
    name: 'john gerdes',
    email: 'other@example.com',
    phone: '07111111111',
    address1: '1 Other Road',
    postcode: 'WV4 6PR',
  });
  assert.deepEqual(surname.reasons, ['surname_postcode']);

  assert.equal((await matches(db, other)).blocked, false);
  assert.equal((await matches(db, {
    name: 'John Gerdes',
    email: 'other@example.com',
    phone: '07111111111',
    address1: '1 Other Road',
    postcode: 'B1 1AA',
  })).blocked, false);
  assert.equal((await matches(db, {
    name: 'Debra Gerdes',
    email: 'new-person@example.com',
    phone: '07999111222',
    address1: '10 King Street',
    postcode: 'M1 1AE',
  })).blocked, false);
  assert.equal((await matches(db, {
    name: 'A Person',
    email: 'other@example.com',
    phone: '07111111111',
    address1: '123 High Street',
    postcode: 'WV4 6PR',
  })).blocked, false);
  assert.equal((await matches(db, {
    name: 'A Person',
    email: 'other@example.com',
    phone: '07111111111',
    address1: '5 Clapper Street',
    postcode: 'WV4 6PR',
  })).blocked, false);
  assert.equal((await matches(db, {
    name: 'A Person',
    email: 'other@example.com',
    phone: '07111111111',
    address1: '23 Lapper Avenue',
    postcode: 'SW1A 1AA',
  })).blocked, false);

  const nested = await matches(db, {
    customer: {
      name: 'Debby Gerdes',
      email: SEEDED_EMAIL,
      phone: '07890873090',
      address1: '23 Lapper Avenue',
      postcode: 'WV4 6PR',
    },
    items: [{ name: 'Example' }],
  });
  assert.equal(nested.blocked, true);
  assert.equal(JSON.stringify(nested).includes(SEEDED_EMAIL), false);
  assert.equal(JSON.stringify(nested).includes('7890873090'), false);
  await db.close();
});

test('a blocked place_order or direct insert creates no order and hides the reason', async () => {
  const db = await database();
  const blocked = {
    name: 'Debby Gerdes',
    email: 'debra.k.gerdes@gmail.com',
    phone: '07890873090',
    address1: '23 Lapper Avenue',
    city: 'Wolverhampton',
    postcode: 'WV4 6PR',
  };

  const rpcMessage = await messageOf(() => db.query(
    'select public.place_order($1::jsonb, \'[]\'::jsonb) as result',
    [JSON.stringify(blocked)],
  ));
  assert.match(rpcMessage, /unable to process this order/);
  assert.equal(rpcMessage.includes('blocklist'), false);
  assert.equal(rpcMessage.includes('surname_postcode'), false);
  assert.equal(await orderCount(db), 0);

  const insertMessage = await messageOf(() => db.query(
    `insert into public."Orders" (reference, status, total_amount, details)
     values ('LWDIRECT01', 'Pending', 10, $1::jsonb)`,
    [JSON.stringify({ customer: blocked })],
  ));
  assert.match(insertMessage, /unable to process this order/);
  assert.equal(await orderCount(db), 0);

  const created = await db.query(
    'select public.place_order($1::jsonb, \'[]\'::jsonb) as result',
    [JSON.stringify(other)],
  );
  assert.equal(created.rows[0].result.reference, 'LWABCDEF01');
  assert.equal(await orderCount(db), 1);

  await db.query(`
    create or replace function public.orders_are_paused(p_at timestamp with time zone default now())
    returns boolean language sql stable as $$ select true $$
  `);
  const pausedBlocked = await messageOf(() => db.query(
    'select public.place_order($1::jsonb, \'[]\'::jsonb) as result',
    [JSON.stringify(blocked)],
  ));
  assert.match(pausedBlocked, /Orders are paused until Monday 26th October/);
  assert.equal(pausedBlocked.includes(NEUTRAL), false);
  const pausedOther = await messageOf(() => db.query(
    'select public.place_order($1::jsonb, \'[]\'::jsonb) as result',
    [JSON.stringify(other)],
  ));
  assert.match(pausedOther, /Orders are paused/);
  assert.equal(await orderCount(db), 1);
  await db.close();
});

test('the telegram payload names only the matched details, and a postcode alone cannot be saved', async () => {
  const db = await database();
  const emailOnly = await payload(db, {
    name: 'A Person',
    email: 'debra.k.gerdes+shop@gmail.com',
    phone: '07111111111',
    address1: '10 King Street',
    postcode: 'M1 1AE',
  }, ['email']);
  assert.deepEqual(emailOnly.matched, { email: 'debra.k.gerdes+shop@gmail.com' });
  assert.equal(JSON.stringify(emailOnly).includes('07111111111'), false);

  const addressOnly = await payload(db, {
    name: 'A Person',
    email: 'other@example.com',
    phone: '07111111111',
    address1: '23 High Street',
    city: 'Wolverhampton',
    postcode: 'WV4 6PR',
  }, ['address']);
  assert.equal(addressOnly.matched.address, '23 High Street, Wolverhampton');
  assert.equal(addressOnly.matched.postcode, 'WV4 6PR');
  assert.equal(addressOnly.matched.email, undefined);
  assert.equal(addressOnly.matched.phone, undefined);

  await assert.rejects(
    () => db.query(`insert into public.customer_blocklist (postcode) values ('SW1A 1AA')`),
    /customer_blocklist_has_matcher/,
  );
  await assert.rejects(
    () => db.query(`insert into public.customer_blocklist (surname) values ('Gerdes')`),
    /customer_blocklist_has_matcher/,
  );

  await db.query(`update public.customer_blocklist set active = false where email_key <> ''`);
  assert.equal((await matches(db, {
    email: SEEDED_EMAIL,
    phone: SEEDED_PHONE,
    address1: '23 Lapper Avenue',
    postcode: 'WV4 6PR',
    name: 'Debby Gerdes',
  })).blocked, false);

  const privileges = await db.query(`
    select
      has_table_privilege('anon', 'public.customer_blocklist', 'select') as anon_read,
      has_function_privilege('anon', 'public.customer_block_matches(jsonb)', 'execute') as anon_match,
      has_function_privilege('anon', 'public.place_order(jsonb,jsonb,text,text,text)', 'execute') as anon_place,
      has_function_privilege('anon', 'public.place_order_before_blocklist(jsonb,jsonb,text,text,text)', 'execute') as anon_inner
  `);
  assert.equal(privileges.rows[0].anon_read, false);
  assert.equal(privileges.rows[0].anon_match, false);
  assert.equal(privileges.rows[0].anon_place, true);
  assert.equal(privileges.rows[0].anon_inner, false);
  await db.close();
});

test('checkout shows the neutral sentence and the alert goes only to Tim', async () => {
  const checkout = await readFile(new URL('../public/checkout.html', import.meta.url), 'utf8');
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  const migration = await readFile(
    new URL('../supabase/migrations/20261014100000_customer_blocklist.sql', import.meta.url),
    'utf8',
  );
  assert.equal(CUSTOMER_BLOCK_MESSAGE, NEUTRAL);
  assert.equal(checkout.includes(NEUTRAL), true);
  assert.equal(checkout.toLowerCase().includes('blocklist'), false);
  assert.equal(checkout.includes(SEEDED_EMAIL), false);
  assert.equal(checkout.includes(SEEDED_PHONE), false);
  assert.equal(admin.includes('customer_blocklist'), true);
  assert.equal(admin.includes(SEEDED_EMAIL), false);
  assert.equal(admin.includes(SEEDED_PHONE), false);
  assert.equal(migration.includes(SEEDED_EMAIL), true);
  assert.equal(migration.includes(PAUSE), true);

  const text = blockedCheckoutTelegramText({
    reasons: ['email', 'address'],
    matched: {
      name: 'Hidden',
      email: 'Person <bad>@gmail.com',
      phone: '07000000000',
      address: '23 High Street',
      postcode: 'WV4 6PR',
    },
    chat_id: '111',
  });
  assert.match(text, /Blocked checkout attempt/);
  assert.match(text, /Matched: email, postcode with the house number or street/);
  assert.match(text, /Person &lt;bad&gt;@gmail.com/);
  assert.equal(text.includes('07000000000'), false);
  assert.equal(text.includes('Hidden'), false);
  assert.equal(BLOCKED_CHECKOUT_CHAT_ID, '5839927114');

  const calls = [];
  const sent = await handleBlockedCheckout({
    method: 'POST',
    providedSecret: 'secret',
    expectedSecret: 'secret',
    payload: {
      reasons: ['phone'],
      matched: { phone: '07890 873090' },
      chat_id: '111',
    },
    token: 'bot',
    send: async (request) => calls.push(request),
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.delivered, true);
  assert.equal(JSON.stringify(sent.body).includes('07890'), false);
  assert.equal(calls[0].chatId, '5839927114');
  assert.match(calls[0].text, /Matched: phone/);

  const rejected = await handleBlockedCheckout({
    method: 'POST',
    providedSecret: 'nope',
    expectedSecret: 'secret',
    payload: { reasons: ['email'], matched: { email: 'person@example.com' } },
    send: async () => calls.push('should-not-send'),
  });
  assert.equal(rejected.status, 401);
  assert.equal(calls.length, 1);

  const failed = await handleBlockedCheckout({
    method: 'POST',
    providedSecret: 'secret',
    expectedSecret: 'secret',
    payload: { reasons: ['email'], matched: { email: 'person@example.com' } },
    send: async () => { throw new Error('telegram down'); },
  });
  assert.equal(failed.body.delivered, false);
  assert.equal(JSON.stringify(failed.body).includes('person@example.com'), false);
});
