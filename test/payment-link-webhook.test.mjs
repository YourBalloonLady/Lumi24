import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Stripe from 'stripe';
import {
  handlePaymentLinkWebhook,
  interpretPaymentLinkEvent,
  shouldDeliverPaidEffects,
  verifyStripeSignature,
} from '../supabase/functions/stripe-payment-link-webhook/payment.js';

const SECRET = 'whsec_test_secret';
const stripe = new Stripe('rk_test_unused_for_signature_fixtures_only', { apiVersion: '2026-09-30.endive' });

function signed(event, { secret = SECRET, timestamp } = {}) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    ...(timestamp ? { timestamp } : {}),
  });
  return { payload, header };
}

function paidEvent(overrides = {}) {
  return {
    id: 'evt_paid_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: 2000,
        currency: 'gbp',
        client_reference_id: 'LWAB12CD34',
        customer_email: 'buyer@example.com',
        ...overrides,
      },
    },
  };
}

test('the official Stripe signature is accepted and a bad one is rejected', async () => {
  const { payload, header } = signed(paidEvent());
  await verifyStripeSignature(payload, header, SECRET);
  await stripe.webhooks.constructEventAsync(payload, header, SECRET);
  await assert.rejects(
    verifyStripeSignature(payload, header, 'whsec_wrong'),
    /Invalid Stripe signature/,
  );
  const stale = signed(paidEvent(), { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  await assert.rejects(
    verifyStripeSignature(stale.payload, stale.header, SECRET),
    /timestamp/,
  );
});

test('a paid session is applied only from its order reference', async () => {
  const applied = [];
  const { payload, header } = signed(paidEvent());
  const result = await handlePaymentLinkWebhook({
    payload,
    signature: header,
    secret: SECRET,
    applyEvent: async (instruction) => {
      applied.push(instruction);
      return { outcome: 'paid' };
    },
  });
  assert.equal(result.body.outcome, 'paid');
  assert.equal(applied[0].orderReference, 'LWAB12CD34');
  assert.equal(applied[0].amountPence, 2000);
  assert.equal(applied[0].currency, 'gbp');
  assert.equal(applied[0].paymentStatus, 'paid');
  assert.equal('customerEmail' in applied[0], false);
});

test('unpaid, failed, and unlinked events do not ask for a paid match by email', async () => {
  const outcomes = [];
  const cases = [
    paidEvent({ payment_status: 'unpaid' }),
    { ...paidEvent(), type: 'checkout.session.async_payment_succeeded', data: { object: { ...paidEvent().data.object, payment_status: 'paid' } } },
    { id: 'evt_failed', type: 'payment_intent.payment_failed', data: { object: { amount: 2000 } } },
    paidEvent({ client_reference_id: null }),
  ];
  for (const event of cases) {
    const { payload, header } = signed(event);
    const result = await handlePaymentLinkWebhook({
      payload,
      signature: header,
      secret: SECRET,
      applyEvent: async (instruction) => {
        outcomes.push(instruction);
        return { outcome: 'recorded' };
      },
    });
    if (event.type === 'payment_intent.payment_failed') {
      assert.equal(result.body.ignored, true);
    }
  }
  assert.equal(outcomes.length, 3);
  assert.equal(outcomes[0].paymentStatus, 'unpaid');
  assert.equal(outcomes[1].eventType, 'checkout.session.async_payment_succeeded');
  assert.equal(outcomes[2].orderReference, '');
  assert.equal(interpretPaymentLinkEvent(paidEvent()).disposition, 'apply');
});

test('a bad signature never reaches the order update', async () => {
  let called = false;
  const { payload, header } = signed(paidEvent(), { secret: 'whsec_other' });
  await assert.rejects(
    handlePaymentLinkWebhook({
      payload,
      signature: header,
      secret: SECRET,
      applyEvent: async () => { called = true; },
    }),
    /Invalid Stripe signature/,
  );
  assert.equal(called, false);
});

test('paid results run notifications once and a failure asks Stripe to retry', async () => {
  assert.equal(shouldDeliverPaidEffects({ marked_paid: true }), true);
  assert.equal(shouldDeliverPaidEffects({ outcome: 'not_pending' }), true);
  assert.equal(shouldDeliverPaidEffects({ status: 'already_processed', outcome: 'paid' }), true);
  assert.equal(shouldDeliverPaidEffects({ status: 'already_processed', outcome: 'unpaid' }), false);
  assert.equal(shouldDeliverPaidEffects({ outcome: 'unpaid' }), false);

  let calls = 0;
  const paid = signed(paidEvent());
  const delivered = await handlePaymentLinkWebhook({
    payload: paid.payload,
    signature: paid.header,
    secret: SECRET,
    applyEvent: async () => ({ marked_paid: true, outcome: 'paid' }),
    onPaidOrder: async () => { calls += 1; },
  });
  assert.equal(delivered.status, 200);
  assert.equal(calls, 1);

  const unpaid = signed(paidEvent({ payment_status: 'unpaid', id: 'evt_unpaid' }));
  await handlePaymentLinkWebhook({
    payload: unpaid.payload,
    signature: unpaid.header,
    secret: SECRET,
    applyEvent: async () => ({ marked_paid: false, outcome: 'unpaid' }),
    onPaidOrder: async () => { calls += 1; },
  });
  assert.equal(calls, 1);

  const failed = signed(paidEvent());
  const retry = await handlePaymentLinkWebhook({
    payload: failed.payload,
    signature: failed.header,
    secret: SECRET,
    applyEvent: async () => ({ marked_paid: true, outcome: 'paid' }),
    onPaidOrder: async () => { throw new Error('mail down'); },
  });
  assert.equal(retry.status, 500);
  assert.equal(retry.body.error, 'Could not finish the paid order notifications.');
});

test('checkout and admin payment links append the order reference', () => {
  const context = { window: {}, URL };
  vm.runInNewContext(readFileSync(new URL('../public/stripe-payment-link.js', import.meta.url), 'utf8'), context);
  const link = context.window.LuminaStripePaymentLink.forReference('lwab12cd34');
  assert.equal(link, 'https://buy.stripe.com/dRm9AL7bO3Yh0IsgBs2880E?client_reference_id=LWAB12CD34');
  assert.equal(
    context.window.LuminaStripePaymentLink.forReference('not-a-reference'),
    'https://buy.stripe.com/dRm9AL7bO3Yh0IsgBs2880E',
  );
  const checkout = readFileSync(new URL('../public/checkout.html', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(checkout, /stripe-payment-link\.js/);
  assert.match(checkout, /forReference\(details\.ref\)/);
  assert.match(admin, /forReference\(order\.reference\)/);
  assert.doesNotMatch(checkout, /STRIPE_SECRET|sk_live|rk_live/);
  assert.doesNotMatch(admin, /STRIPE_SECRET|sk_live|rk_live/);
});
