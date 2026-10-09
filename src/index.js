import Stripe from 'stripe';
import { integrationIdentifier, interpretStripeEvent, poundsToPence } from './payment-events.js';

const STRIPE_API_VERSION = '2026-09-30.endive';
const MAX_WEBHOOK_BYTES = 1_000_000;
const ALLOWED_HOSTS = new Set([
  'www.lumi24.org',
  'lumi24.lumi365admin.workers.dev',
  'localhost',
  '127.0.0.1',
]);
const ORDER_REFERENCE = /^LW[0-9A-F]{8}$/i;
const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function stripeClient(secretKey) {
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
}

function siteOrigin(request) {
  const url = new URL(request.url);
  if (!ALLOWED_HOSTS.has(url.hostname)) return 'https://www.lumi24.org';
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${port}`;
}

function originAllowed(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return ALLOWED_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function customerEmail(details) {
  const email = details?.customer?.email || details?.email || '';
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : undefined;
}

function isStripeCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'checkout.stripe.com' || url.hostname === 'pay.stripe.com'
    );
  } catch {
    return false;
  }
}

function paidLike(status) {
  return ['paid', 'packed', 'shipped'].includes(String(status || '').toLowerCase());
}

async function readJson(request, maxBytes) {
  const claimed = Number(request.headers.get('content-length') || 0);
  if (claimed > maxBytes) {
    return { error: json({ error: 'Request is too large.' }, 413) };
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    return { error: json({ error: 'Request is too large.' }, 413) };
  }
  try {
    return { text, value: text ? JSON.parse(text) : {} };
  } catch {
    return { error: json({ error: 'Request could not be read.' }, 400) };
  }
}

function supabaseHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'content-type': 'application/json',
    ...extra,
  };
}

async function supabaseRpc(env, fetchImpl, name, args) {
  const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: supabaseHeaders(env),
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = new Error('Supabase request failed.');
    error.status = response.status;
    error.code = body?.code || '';
    throw error;
  }
  return body;
}

async function loadOrder(env, fetchImpl, orderId) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/Orders`);
  url.searchParams.set('id', `eq.${orderId}`);
  url.searchParams.set('select', 'id,reference,status,total_amount,details');
  const response = await fetchImpl(url, { headers: supabaseHeaders(env) });
  if (!response.ok) {
    throw new Error('Order lookup failed.');
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function createCheckoutSession(request, env, deps) {
  if (!originAllowed(request)) {
    return json({ error: 'Card checkout is not available from this site.' }, 403);
  }
  if (!env.STRIPE_SECRET_KEY || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Card checkout is not configured yet.' }, 503);
  }

  const body = await readJson(request, 16_384);
  if (body.error) return body.error;
  const orderId = String(body.value?.orderId || body.value?.order_id || '').trim().toLowerCase();
  const reference = String(body.value?.reference || body.value?.order_reference || '').trim().toUpperCase();
  if (!ORDER_ID.test(orderId) || !ORDER_REFERENCE.test(reference)) {
    return json({ error: 'A saved order is required before card checkout.' }, 400);
  }

  const fetchImpl = deps.fetch || fetch;
  const order = await loadOrder(env, fetchImpl, orderId);
  if (!order || String(order.reference || '').toUpperCase() !== reference) {
    return json({ error: 'That order could not be found.' }, 404);
  }
  if (paidLike(order.status)) {
    return json({ alreadyPaid: true });
  }
  if (String(order.status || '').toLowerCase() !== 'pending') {
    return json({ error: 'This order is not waiting for payment.' }, 409);
  }

  const amountPence = poundsToPence(order.total_amount);
  if (!Number.isInteger(amountPence) || amountPence < 1) {
    return json({ error: 'This order does not have a card amount to collect.' }, 422);
  }

  const stripe = deps.stripe || stripeClient(env.STRIPE_SECRET_KEY);
  let previousSessionId = '';
  const existingSessionId = order.details?.meta?.stripe_checkout_session_id;
  if (typeof existingSessionId === 'string' && existingSessionId.startsWith('cs_')) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(existingSessionId);
      if (
        existing?.status === 'open'
        && existing.amount_total === amountPence
        && String(existing.currency || '').toLowerCase() === 'gbp'
        && isStripeCheckoutUrl(existing.url)
      ) {
        return json({ url: existing.url, sessionId: existing.id });
      }
      previousSessionId = existing?.id || existingSessionId;
    } catch (error) {
      console.error('Stored Stripe Checkout session could not be reused.', error?.message || 'lookup failed');
      previousSessionId = existingSessionId;
    }
  }

  const origin = siteOrigin(request);
  const email = customerEmail(order.details);
  const metadata = {
    order_id: orderId,
    order_reference: reference,
  };
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: reference,
    success_url: `${origin}/success.html?ref=${encodeURIComponent(reference)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/checkout.html`,
    metadata,
    payment_intent_data: { metadata },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'gbp',
        unit_amount: amountPence,
        product_data: { name: `Lumina order ${reference}` },
      },
    }],
    integration_identifier: integrationIdentifier(),
    ...(email ? { customer_email: email } : {}),
  }, {
    idempotencyKey: previousSessionId
      ? `lumi24-${orderId}-${amountPence}-after-${previousSessionId}`
      : `lumi24-${orderId}-${amountPence}`,
  });

  if (!isStripeCheckoutUrl(session?.url)) {
    return json({ error: 'Card checkout could not be started.' }, 502);
  }

  try {
    await supabaseRpc(env, fetchImpl, 'attach_stripe_checkout_session', {
      p_order_id: orderId,
      p_order_reference: reference,
      p_session_id: session.id,
      p_session_url: session.url,
    });
  } catch (error) {
    console.error('Stripe Checkout session was created but not stored.', error?.code || error?.message || 'attach failed');
  }

  return json({ url: session.url, sessionId: session.id });
}

async function handleWebhook(request, env, deps) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Stripe webhook is not configured yet.' }, 500);
  }
  const signature = request.headers.get('stripe-signature');
  if (!signature) return json({ error: 'Invalid Stripe signature.' }, 400);

  const claimed = Number(request.headers.get('content-length') || 0);
  if (claimed > MAX_WEBHOOK_BYTES) return json({ error: 'Request is too large.' }, 413);
  const payload = await request.text();
  if (payload.length > MAX_WEBHOOK_BYTES) return json({ error: 'Request is too large.' }, 413);

  const stripe = deps.stripe || stripeClient(env.STRIPE_SECRET_KEY || 'rk_test_webhook_verifier');
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('Stripe webhook signature was rejected.', error?.message || 'invalid signature');
    return json({ error: 'Invalid Stripe signature.' }, 400);
  }

  const instruction = interpretStripeEvent(event);
  if (instruction.disposition !== 'apply') {
    return json({ received: true, ignored: true });
  }

  try {
    const result = await supabaseRpc(env, deps.fetch || fetch, 'apply_stripe_order_payment', {
      p_event_id: event.id,
      p_event_type: instruction.eventType,
      p_requested_outcome: instruction.requestedOutcome,
      p_order_id: instruction.orderId,
      p_order_reference: instruction.orderReference,
      p_amount_pence: instruction.amountPence,
      p_currency: instruction.currency,
      p_checkout_session_id: instruction.checkoutSessionId,
      p_payment_intent_id: instruction.paymentIntentId,
      p_note: instruction.note,
    });
    return json({
      received: true,
      outcome: result?.outcome || result?.status || 'recorded',
    });
  } catch (error) {
    console.error('Stripe payment could not be recorded.', error?.code || 'rpc failed');
    return json({ error: 'Could not record the payment.' }, 500);
  }
}

export async function handleRequest(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/api/stripe-checkout') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    try {
      return await createCheckoutSession(request, env, deps);
    } catch (error) {
      console.error('Stripe Checkout session failed.', error?.message || 'checkout failed');
      return json({ error: 'Card checkout could not be started.' }, 500);
    }
  }

  if (url.pathname === '/api/stripe-webhook') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    return handleWebhook(request, env, deps);
  }

  if (url.pathname.startsWith('/api/')) {
    return json({ error: 'Not found.' }, 404);
  }

  if (!env.ASSETS) return json({ error: 'Not found.' }, 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
