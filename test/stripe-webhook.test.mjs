import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { handleRequest } from '../src/index.js';

const SECRET = 'whsec_test_secret';
const ORDER_ID = '7ad9fc6c-bc1a-43db-9ed0-c12ab3c71e18';
const REFERENCE = 'LWAB12CD34';
const stripe = new Stripe('rk_test_dummy', { apiVersion: '2026-09-30.endive' });

function signedRequest(event, { secret = SECRET, timestamp = undefined } = {}) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    ...(timestamp ? { timestamp } : {}),
  });
  return new Request('https://www.lumi24.org/api/stripe-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': header, 'content-type': 'application/json' },
    body: payload,
  });
}

function paidEvent(id = 'evt_paid_1') {
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_paid',
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: 2000,
        currency: 'gbp',
        client_reference_id: REFERENCE,
        payment_intent: 'pi_test_paid',
        metadata: { order_id: ORDER_ID, order_reference: REFERENCE },
      },
    },
  };
}

function envWith(overrides = {}) {
  return {
    STRIPE_SECRET_KEY: 'rk_test_dummy',
    STRIPE_WEBHOOK_SECRET: SECRET,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    ...overrides,
  };
}

test('a valid signature records a paid checkout session against the order', async () => {
  const calls = [];
  const response = await handleRequest(signedRequest(paidEvent()), envWith(), {
    stripe,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(init.body),
        authorization: init.headers.authorization,
      });
      return new Response(JSON.stringify({ status: 'paid', outcome: 'paid', marked_paid: true }), { status: 200 });
    },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.outcome, 'paid');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /apply_stripe_order_payment$/);
  assert.equal(calls[0].body.p_requested_outcome, 'paid');
  assert.equal(calls[0].body.p_order_id, ORDER_ID);
  assert.equal(calls[0].body.p_order_reference, REFERENCE);
  assert.equal(calls[0].body.p_amount_pence, 2000);
  assert.equal(calls[0].body.p_currency, 'gbp');
  assert.equal(calls[0].body.p_event_id, 'evt_paid_1');
  assert.equal(calls[0].authorization, 'Bearer service-role-test');
});

test('an invalid or stale signature does not touch the order', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  const invalid = await handleRequest(
    signedRequest(paidEvent(), { secret: 'whsec_wrong' }),
    envWith(),
    { stripe, fetch: fetchImpl },
  );
  assert.equal(invalid.status, 400);
  const stale = await handleRequest(
    signedRequest(paidEvent('evt_stale'), { timestamp: Math.floor(Date.now() / 1000) - 3600 }),
    envWith(),
    { stripe, fetch: fetchImpl },
  );
  assert.equal(stale.status, 400);
  assert.equal(called, false);
});

test('failed, expired, and unpaid events are recorded without requesting paid', async () => {
  const outcomes = [];
  const fetchImpl = async (_url, init) => {
    outcomes.push(JSON.parse(init.body).p_requested_outcome);
    return new Response(JSON.stringify({ outcome: 'recorded' }), { status: 200 });
  };
  const events = [
    { ...paidEvent('evt_unpaid'), data: { object: { ...paidEvent().data.object, payment_status: 'unpaid' } } },
    { ...paidEvent('evt_expired'), type: 'checkout.session.expired', data: { object: { ...paidEvent().data.object, payment_status: 'unpaid' } } },
    { ...paidEvent('evt_async_failed'), type: 'checkout.session.async_payment_failed', data: { object: { ...paidEvent().data.object, payment_status: 'unpaid' } } },
    {
      id: 'evt_pi_failed',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_failed',
          amount: 2000,
          currency: 'gbp',
          metadata: { order_id: ORDER_ID, order_reference: REFERENCE },
        },
      },
    },
  ];
  for (const event of events) {
    const response = await handleRequest(signedRequest(event), envWith(), { stripe, fetch: fetchImpl });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(outcomes, ['unpaid', 'expired', 'failed', 'failed']);
});

test('a static payment link event with no order metadata is ignored', async () => {
  let called = false;
  const response = await handleRequest(signedRequest({
    id: 'evt_static',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_static', amount_received: 2000, currency: 'gbp', metadata: {} } },
  }), envWith(), {
    stripe,
    fetch: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ignored, true);
  assert.equal(called, false);
});

test('a database failure is retried by returning 500', async () => {
  const response = await handleRequest(signedRequest(paidEvent('evt_retry')), envWith(), {
    stripe,
    fetch: async () => new Response(JSON.stringify({ code: 'P0002', message: 'missing' }), { status: 404 }),
  });
  assert.equal(response.status, 500);
});

test('checkout uses the database total and links the session to the order', async () => {
  const created = [];
  const rpc = [];
  const response = await handleRequest(new Request('https://www.lumi24.org/api/stripe-checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://www.lumi24.org' },
    body: JSON.stringify({ orderId: ORDER_ID, reference: REFERENCE, amount: 1 }),
  }), envWith(), {
    stripe: {
      checkout: {
        sessions: {
          retrieve: async () => { throw new Error('none'); },
          create: async (params, options) => {
            created.push({ params, options });
            return { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new', status: 'open' };
          },
        },
      },
    },
    fetch: async (url, init) => {
      const target = String(url);
      if (target.includes('/rest/v1/Orders')) {
        return new Response(JSON.stringify([{
          id: ORDER_ID,
          reference: REFERENCE,
          status: 'Pending',
          total_amount: '19.99',
          details: { customer: { email: 'buyer@example.com' }, meta: { promotion_discount: 0 } },
        }]), { status: 200 });
      }
      rpc.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ attached: true }), { status: 200 });
    },
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).url, 'https://checkout.stripe.com/c/pay/cs_test_new');
  assert.equal(created.length, 1);
  assert.equal(created[0].params.mode, 'payment');
  assert.equal(created[0].params.client_reference_id, REFERENCE);
  assert.equal(created[0].params.metadata.order_id, ORDER_ID);
  assert.equal(created[0].params.metadata.order_reference, REFERENCE);
  assert.deepEqual(created[0].params.payment_intent_data.metadata, created[0].params.metadata);
  assert.equal(created[0].params.line_items[0].price_data.unit_amount, 1999);
  assert.equal(created[0].params.line_items[0].price_data.currency, 'gbp');
  assert.equal(created[0].params.payment_method_types, undefined);
  assert.match(created[0].params.integration_identifier, /^lumi24_checkout_[a-z]{8}$/);
  assert.match(created[0].params.success_url, /success\.html\?ref=LWAB12CD34&session_id=\{CHECKOUT_SESSION_ID\}$/);
  assert.equal(created[0].params.customer_email, 'buyer@example.com');
  assert.equal(rpc[0].p_session_id, 'cs_test_new');
  assert.equal(rpc[0].p_order_id, ORDER_ID);
});

test('an open checkout session is reused instead of charging a different amount', async () => {
  let created = false;
  const response = await handleRequest(new Request('http://127.0.0.1:8787/api/stripe-checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8787' },
    body: JSON.stringify({ orderId: ORDER_ID, reference: REFERENCE }),
  }), envWith(), {
    stripe: {
      checkout: {
        sessions: {
          retrieve: async () => ({
            id: 'cs_existing',
            status: 'open',
            amount_total: 2000,
            currency: 'gbp',
            url: 'https://checkout.stripe.com/c/pay/cs_existing',
          }),
          create: async () => { created = true; },
        },
      },
    },
    fetch: async () => new Response(JSON.stringify([{
      id: ORDER_ID,
      reference: REFERENCE,
      status: 'Pending',
      total_amount: '20.00',
      details: { meta: { stripe_checkout_session_id: 'cs_existing' } },
    }]), { status: 200 }),
  });
  assert.equal((await response.json()).url, 'https://checkout.stripe.com/c/pay/cs_existing');
  assert.equal(created, false);
});

test('static files stay on the asset handler', async () => {
  let assetUrl = '';
  const response = await handleRequest(new Request('https://www.lumi24.org/checkout.html'), envWith({
    ASSETS: { fetch: async (request) => { assetUrl = request.url; return new Response('html', { status: 200 }); } },
  }));
  assert.equal(response.status, 200);
  assert.equal(assetUrl, 'https://www.lumi24.org/checkout.html');
});
