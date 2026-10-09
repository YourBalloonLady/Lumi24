const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

function timingSafeEqual(left, right) {
  const a = String(left);
  const b = String(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export async function verifyStripeSignature(payload, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) {
    throw new Error('Invalid Stripe signature.');
  }

  const signatures = [];
  let timestamp = '';
  for (const part of String(header).split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  }

  const timestampSeconds = Number(timestamp);
  if (!timestamp || !Number.isFinite(timestampSeconds) || signatures.length === 0) {
    throw new Error('Invalid Stripe signature.');
  }
  if (Math.abs(nowSeconds - timestampSeconds) > 300) {
    throw new Error('Stripe signature timestamp is outside the tolerance.');
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const expected = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!signatures.some((signature) => timingSafeEqual(signature, expected))) {
    throw new Error('Invalid Stripe signature.');
  }
}

export function interpretPaymentLinkEvent(event) {
  if (!HANDLED_EVENTS.has(event?.type)) {
    return { disposition: 'ignore' };
  }

  const session = event?.data?.object && typeof event.data.object === 'object'
    ? event.data.object
    : {};
  return {
    disposition: 'apply',
    eventId: typeof event.id === 'string' ? event.id : '',
    eventType: event.type,
    orderReference: typeof session.client_reference_id === 'string' ? session.client_reference_id : '',
    amountPence: Number.isInteger(session.amount_total) ? session.amount_total : null,
    currency: typeof session.currency === 'string' ? session.currency : '',
    paymentStatus: typeof session.payment_status === 'string' ? session.payment_status : '',
    checkoutSessionId: typeof session.id === 'string' ? session.id : '',
  };
}

export async function handlePaymentLinkWebhook({ payload, signature, secret, nowSeconds, applyEvent }) {
  await verifyStripeSignature(payload, signature, secret, nowSeconds);
  const event = JSON.parse(payload);
  const instruction = interpretPaymentLinkEvent(event);
  if (instruction.disposition !== 'apply') {
    return { status: 200, body: { received: true, ignored: true } };
  }
  if (!instruction.eventId) {
    return { status: 400, body: { error: 'Stripe event id is missing.' } };
  }

  const result = await applyEvent(instruction);
  return {
    status: 200,
    body: { received: true, outcome: result?.outcome || result?.status || 'recorded' },
  };
}
