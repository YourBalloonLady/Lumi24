import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const ORDER_ID = '7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';
const REFERENCE = 'LWAB12CD34';

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create table public."Orders" (
      id uuid primary key,
      reference text not null,
      status text not null,
      total_amount numeric(12, 2) not null,
      details jsonb not null default '{}'::jsonb
    );
  `);
  const migration = await readFile(
    new URL('../supabase/migrations/20261009160000_apply_stripe_order_payment.sql', import.meta.url),
    'utf8',
  );
  await db.exec(migration);
  return db;
}

async function insertOrder(db, { status = 'Pending', total = '20.00', id = ORDER_ID, reference = REFERENCE, meta = {} } = {}) {
  await db.query(
    `insert into public."Orders" (id, reference, status, total_amount, details)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [id, reference, status, total, JSON.stringify({ customer: { email: 'buyer@example.com' }, meta })],
  );
}

function apply(db, overrides = {}) {
  const args = {
    p_event_id: 'evt_test_1',
    p_event_type: 'checkout.session.completed',
    p_requested_outcome: 'paid',
    p_order_id: ORDER_ID,
    p_order_reference: REFERENCE,
    p_amount_pence: 2000,
    p_currency: 'gbp',
    p_checkout_session_id: 'cs_test_1',
    p_payment_intent_id: 'pi_test_1',
    p_note: 'test',
    ...overrides,
  };
  return db.query(
    `select public.apply_stripe_order_payment(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
    ) as result`,
    [
      args.p_event_id,
      args.p_event_type,
      args.p_requested_outcome,
      args.p_order_id,
      args.p_order_reference,
      args.p_amount_pence,
      args.p_currency,
      args.p_checkout_session_id,
      args.p_payment_intent_id,
      args.p_note,
    ],
  ).then((result) => result.rows[0].result);
}

async function orderRow(db, id = ORDER_ID) {
  const result = await db.query('select status, details from public."Orders" where id = $1', [id]);
  return result.rows[0];
}

test('paid Stripe confirmation marks a pending order Paid once', async () => {
  const db = await database();
  await insertOrder(db, { meta: { promotion_discount: '1.00' } });
  const first = await apply(db);
  assert.equal(first.marked_paid, true);
  assert.equal(first.outcome, 'paid');
  const row = await orderRow(db);
  assert.equal(row.status, 'Paid');
  assert.equal(row.details.meta.promotion_discount, '1.00');
  assert.equal(row.details.meta.stripe_checkout_session_id, 'cs_test_1');
  assert.equal(row.details.customer.email, 'buyer@example.com');

  const second = await apply(db);
  assert.equal(second.status, 'already_processed');
  const events = await db.query('select count(*)::int as count from public.stripe_webhook_events');
  assert.equal(events.rows[0].count, 1);
  await db.close();
});

test('a second Stripe event does not change Packed back to a new state', async () => {
  const db = await database();
  await insertOrder(db, { status: 'Packed' });
  const result = await apply(db, { p_event_id: 'evt_packed' });
  assert.equal(result.outcome, 'already_paid');
  assert.equal(result.marked_paid, false);
  assert.equal((await orderRow(db)).status, 'Packed');
  await db.close();
});

test('failed, expired, unpaid, cancelled, and mismatched payments stay unpaid', async () => {
  const db = await database();
  const cases = [
    ['failed', 'evt_failed', 'Pending', 'failed'],
    ['expired', 'evt_expired', 'Pending', 'expired'],
    ['unpaid', 'evt_unpaid', 'Pending', 'unpaid'],
    ['paid', 'evt_cancelled', 'Cancelled', 'cancelled'],
    ['paid', 'evt_amount', 'Pending', 'amount_mismatch'],
    ['paid', 'evt_currency', 'Pending', 'amount_mismatch'],
  ];
  await insertOrder(db);
  for (const [outcome, eventId, status, expected] of cases) {
    await db.query('update public."Orders" set status = $2 where id = $1', [ORDER_ID, status]);
    const result = await apply(db, {
      p_event_id: eventId,
      p_requested_outcome: outcome,
      p_amount_pence: eventId === 'evt_amount' ? 1999 : 2000,
      p_currency: eventId === 'evt_currency' ? 'usd' : 'gbp',
    });
    assert.equal(result.outcome, expected, eventId);
    assert.equal(result.marked_paid, false, eventId);
    assert.notEqual((await orderRow(db)).status, 'Paid', eventId);
  }
  await db.close();
});

test('payment intent success can find the order from its reference', async () => {
  const db = await database();
  await insertOrder(db);
  const result = await apply(db, {
    p_event_id: 'evt_pi',
    p_event_type: 'payment_intent.succeeded',
    p_order_id: null,
    p_checkout_session_id: null,
  });
  assert.equal(result.marked_paid, true);
  assert.equal((await orderRow(db)).status, 'Paid');
  await db.close();
});

test('a reference that does not match the order is not marked paid', async () => {
  const db = await database();
  await insertOrder(db);
  const result = await apply(db, { p_event_id: 'evt_mismatch', p_order_reference: 'LW00000000' });
  assert.equal(result.outcome, 'reference_mismatch');
  assert.equal((await orderRow(db)).status, 'Pending');
  await db.close();
});

test('anonymous visitors cannot call the payment function or read webhook rows', async () => {
  const db = await database();
  await db.exec('set role anon');
  await assert.rejects(
    db.query("select public.apply_stripe_order_payment('evt', 'checkout.session.completed', 'paid', null, null, null, null, null, null, null)"),
    /permission denied/,
  );
  await assert.rejects(
    db.query('select * from public.stripe_webhook_events'),
    /permission denied/,
  );
  await db.close();
});

test('the checkout session url is stored on a pending order', async () => {
  const db = await database();
  await insertOrder(db, { meta: { promotion_discount: '1.00' } });
  const attached = await db.query(
    `select public.attach_stripe_checkout_session($1, $2, $3, $4) as result`,
    [ORDER_ID, REFERENCE, 'cs_test_attach', 'https://checkout.stripe.com/c/pay/cs_test_attach'],
  );
  assert.equal(attached.rows[0].result.attached, true);
  const row = await orderRow(db);
  assert.equal(row.status, 'Pending');
  assert.equal(row.details.meta.stripe_checkout_url, 'https://checkout.stripe.com/c/pay/cs_test_attach');
  assert.equal(row.details.meta.promotion_discount, '1.00');
  await db.close();
});
