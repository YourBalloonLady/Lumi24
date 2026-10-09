import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretStripeEvent, poundsToPence } from '../src/payment-events.js';

const ORDER_ID = '7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';
const REFERENCE = 'LWAB12CD34';

function sessionEvent(type, overrides = {}) {
  return {
    id: 'evt_session',
    type,
    data: {
      object: {
        id: 'cs_test_123',
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: 2000,
        currency: 'gbp',
        client_reference_id: REFERENCE,
        payment_intent: 'pi_test_123',
        metadata: { order_id: ORDER_ID, order_reference: REFERENCE },
        ...overrides,
      },
    },
  };
}

test('pounds convert to pence without binary rounding', () => {
  assert.equal(poundsToPence('19.99'), 1999);
  assert.equal(poundsToPence(20), 2000);
  assert.equal(poundsToPence('20.5'), 2050);
  assert.equal(poundsToPence('20.555'), null);
  assert.equal(poundsToPence('-1'), null);
});

test('a paid checkout session is linked to the order', () => {
  const result = interpretStripeEvent(sessionEvent('checkout.session.completed'));
  assert.equal(result.disposition, 'apply');
  assert.equal(result.requestedOutcome, 'paid');
  assert.equal(result.orderId, ORDER_ID);
  assert.equal(result.orderReference, REFERENCE);
  assert.equal(result.amountPence, 2000);
  assert.equal(result.currency, 'gbp');
  assert.equal(result.paymentIntentId, 'pi_test_123');
});

test('an unpaid completed session is not treated as paid', () => {
  const result = interpretStripeEvent(sessionEvent('checkout.session.completed', { payment_status: 'unpaid' }));
  assert.equal(result.requestedOutcome, 'unpaid');
});

test('async success is paid and async failure or expiry is not', () => {
  assert.equal(
    interpretStripeEvent(sessionEvent('checkout.session.async_payment_succeeded')).requestedOutcome,
    'paid',
  );
  assert.equal(
    interpretStripeEvent(sessionEvent('checkout.session.async_payment_failed', { payment_status: 'unpaid' })).requestedOutcome,
    'failed',
  );
  assert.equal(
    interpretStripeEvent(sessionEvent('checkout.session.expired', { payment_status: 'unpaid' })).requestedOutcome,
    'expired',
  );
});

test('a payment intent is paid only when it carries the order', () => {
  const linked = interpretStripeEvent({
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_test_123',
        amount_received: 2000,
        currency: 'GBP',
        metadata: { order_id: ORDER_ID, order_reference: REFERENCE },
      },
    },
  });
  assert.equal(linked.requestedOutcome, 'paid');
  assert.equal(linked.amountPence, 2000);
  assert.equal(linked.currency, 'gbp');

  const staticLink = interpretStripeEvent({
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_static', amount_received: 2000, currency: 'gbp', metadata: {} } },
  });
  assert.equal(staticLink.disposition, 'ignore');
  assert.equal(staticLink.reason, 'unlinked_payment_intent');
});

test('a failed payment intent does not request paid', () => {
  const result = interpretStripeEvent({
    type: 'payment_intent.payment_failed',
    data: {
      object: {
        id: 'pi_test_123',
        amount: 2000,
        currency: 'gbp',
        metadata: { order_id: ORDER_ID, order_reference: REFERENCE },
      },
    },
  });
  assert.equal(result.requestedOutcome, 'failed');
  assert.notEqual(result.requestedOutcome, 'paid');
});

test('conflicting order references are ignored', () => {
  const result = interpretStripeEvent(sessionEvent('checkout.session.completed', {
    client_reference_id: 'LW11111111',
    metadata: { order_id: ORDER_ID, order_reference: REFERENCE },
  }));
  assert.equal(result.disposition, 'ignore');
  assert.equal(result.reason, 'reference_conflict');
});
