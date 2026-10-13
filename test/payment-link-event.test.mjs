import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const ORDER_ID = '7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';

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
    new URL('../supabase/migrations/20261009173000_payment_link_paid_event.sql', import.meta.url),
    'utf8',
  );
  const alert = await readFile(
    new URL('../supabase/migrations/20261013163100_cancelled_payment_alert.sql', import.meta.url),
    'utf8',
  );
  await db.exec(migration);
  await db.exec(alert);
  await db.query(
    `insert into public."Orders" (id, reference, status, total_amount, details)
     values ($1, 'LWAB12CD34', 'Pending', 20.00, '{"meta":{"promotion_discount":"1.00"},"customer":{"email":"buyer@example.com"}}'::jsonb)`,
    [ORDER_ID],
  );
  return db;
}

function apply(db, overrides = {}) {
  const args = {
    eventId: 'evt_1',
    eventType: 'checkout.session.completed',
    reference: 'LWAB12CD34',
    amount: 2000,
    currency: 'gbp',
    paymentStatus: 'paid',
    sessionId: 'cs_1',
    ...overrides,
  };
  return db.query(
    `select public.apply_payment_link_event($1, $2, $3, $4, $5, $6, $7) as result`,
    [args.eventId, args.eventType, args.reference, args.amount, args.currency, args.paymentStatus, args.sessionId],
  ).then((result) => result.rows[0].result);
}

async function statusOf(db) {
  const result = await db.query('select status, details from public."Orders" where id = $1', [ORDER_ID]);
  return result.rows[0];
}

test('a matching paid Payment Link marks the pending order once', async () => {
  const db = await database();
  const first = await apply(db);
  assert.equal(first.marked_paid, true);
  assert.equal(first.outcome, 'paid');
  const row = await statusOf(db);
  assert.equal(row.status, 'Paid');
  assert.equal(row.details.meta.promotion_discount, '1.00');
  assert.equal(row.details.customer.email, 'buyer@example.com');

  const second = await apply(db);
  assert.equal(second.status, 'already_processed');
  const events = await db.query('select count(*)::int as count from public.stripe_webhook_events');
  assert.equal(events.rows[0].count, 1);
  await db.close();
});

test('wrong amount, wrong reference, unpaid, and a packed order stay unmarked', async () => {
  const db = await database();
  const cases = [
    [{ eventId: 'evt_amount', amount: 1999 }, 'amount_mismatch', 'Pending'],
    [{ eventId: 'evt_currency', currency: 'usd' }, 'amount_mismatch', 'Pending'],
    [{ eventId: 'evt_other', reference: 'LW00000000' }, 'unmatched', 'Pending'],
    [{ eventId: 'evt_blank', reference: '' }, 'unmatched', 'Pending'],
    [{ eventId: 'evt_emailish', reference: 'buyer@example.com' }, 'unmatched', 'Pending'],
    [{ eventId: 'evt_unpaid', paymentStatus: 'unpaid' }, 'unpaid', 'Pending'],
  ];
  for (const [overrides, outcome, status] of cases) {
    await db.query(`update public."Orders" set status = 'Pending' where id = $1`, [ORDER_ID]);
    const result = await apply(db, overrides);
    assert.equal(result.outcome, outcome, overrides.eventId);
    assert.equal(result.marked_paid, false, overrides.eventId);
    assert.equal((await statusOf(db)).status, status, overrides.eventId);
  }

  await db.query(`update public."Orders" set status = 'Packed' where id = $1`, [ORDER_ID]);
  const packed = await apply(db, { eventId: 'evt_packed' });
  assert.equal(packed.outcome, 'not_pending');
  assert.equal((await statusOf(db)).status, 'Packed');
  await db.close();
});

test('a payment for a cancelled order stays cancelled and asks Tim to sort it', async () => {
  const db = await database();
  await db.query(
    `update public."Orders"
     set status = 'Cancelled',
         details = details || '{"meta":{"restocked_at":"2026-10-13T12:00:00Z"}}'::jsonb
     where id = $1`,
    [ORDER_ID],
  );
  const first = await apply(db, { eventId: 'evt_late' });
  assert.equal(first.marked_paid, false);
  assert.equal(first.outcome, 'cancelled_paid');
  assert.equal(first.alert_admin, true);
  assert.equal((await statusOf(db)).status, 'Cancelled');

  const replay = await apply(db, { eventId: 'evt_late' });
  assert.equal(replay.status, 'already_processed');
  assert.equal(replay.alert_admin, true);
  assert.equal((await statusOf(db)).status, 'Cancelled');

  await db.query(`select public.finish_cancelled_payment_alert($1::uuid, 'sent')`, [ORDER_ID]);
  const afterAlert = await apply(db, { eventId: 'evt_late' });
  assert.equal(afterAlert.alert_admin, false);
  assert.equal((await statusOf(db)).status, 'Cancelled');
  await db.close();
});

test('a delayed payment success can mark the order paid', async () => {
  const db = await database();
  const result = await apply(db, {
    eventId: 'evt_async',
    eventType: 'checkout.session.async_payment_succeeded',
  });
  assert.equal(result.marked_paid, true);
  assert.equal((await statusOf(db)).status, 'Paid');
  await db.close();
});

test('anonymous visitors cannot call the payment function', async () => {
  const db = await database();
  await db.exec('set role anon');
  await assert.rejects(
    db.query(`select public.apply_payment_link_event('evt', 'checkout.session.completed', 'LWAB12CD34', 2000, 'gbp', 'paid', 'cs')`),
    /permission denied/,
  );
  await db.close();
});
