const ORDER_REFERENCE = /^LW[0-9A-F]{8}$/;
const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function poundsToPence(amount) {
  if (amount === null || amount === undefined || amount === '') return null;
  const text = String(amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return (Number(whole) * 100) + Number(fraction.padEnd(2, '0'));
}

export function integrationIdentifier() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `lumi24_checkout_${suffix}`;
}

function asReference(value) {
  if (typeof value !== 'string') return null;
  const reference = value.trim().toUpperCase();
  return ORDER_REFERENCE.test(reference) ? reference : null;
}

function asOrderId(value) {
  if (typeof value !== 'string') return null;
  const orderId = value.trim().toLowerCase();
  return ORDER_ID.test(orderId) ? orderId : null;
}

function integerPence(value) {
  return Number.isInteger(value) ? value : null;
}

function metadataOf(object) {
  const metadata = object?.metadata;
  return metadata && typeof metadata === 'object' ? metadata : {};
}

function linkedOrder(object, clientReferenceId) {
  const metadata = metadataOf(object);
  const references = [
    asReference(clientReferenceId),
    asReference(metadata.order_reference),
    asReference(metadata.reference),
  ].filter(Boolean);
  const uniqueReferences = [...new Set(references)];
  return {
    orderId: asOrderId(metadata.order_id),
    orderReference: uniqueReferences.length === 1 ? uniqueReferences[0] : null,
    referenceConflict: uniqueReferences.length > 1,
  };
}

function paymentIntentId(value) {
  if (typeof value === 'string' && value.startsWith('pi_')) return value;
  if (value && typeof value.id === 'string' && value.id.startsWith('pi_')) return value.id;
  return null;
}

function ignored(reason) {
  return { disposition: 'ignore', reason };
}

function applyFromSession(eventType, session, requestedOutcome, note) {
  const link = linkedOrder(session, session?.client_reference_id);
  if (link.referenceConflict || (!link.orderId && !link.orderReference)) {
    return ignored(link.referenceConflict ? 'reference_conflict' : 'unlinked_checkout_session');
  }
  return {
    disposition: 'apply',
    requestedOutcome,
    orderId: link.orderId,
    orderReference: link.orderReference,
    amountPence: integerPence(session?.amount_total),
    currency: typeof session?.currency === 'string' ? session.currency.toLowerCase() : null,
    checkoutSessionId: typeof session?.id === 'string' ? session.id : null,
    paymentIntentId: paymentIntentId(session?.payment_intent),
    note,
    eventType,
  };
}

function applyFromPaymentIntent(eventType, paymentIntent, requestedOutcome, note) {
  const link = linkedOrder(paymentIntent);
  if (link.referenceConflict || (!link.orderId && !link.orderReference)) {
    return ignored(link.referenceConflict ? 'reference_conflict' : 'unlinked_payment_intent');
  }
  const amountPence = requestedOutcome === 'paid'
    ? integerPence(paymentIntent?.amount_received)
    : integerPence(paymentIntent?.amount_received ?? paymentIntent?.amount);
  return {
    disposition: 'apply',
    requestedOutcome,
    orderId: link.orderId,
    orderReference: link.orderReference,
    amountPence,
    currency: typeof paymentIntent?.currency === 'string' ? paymentIntent.currency.toLowerCase() : null,
    checkoutSessionId: null,
    paymentIntentId: typeof paymentIntent?.id === 'string' ? paymentIntent.id : null,
    note,
    eventType,
  };
}

export function interpretStripeEvent(event) {
  const eventType = event?.type;
  const object = event?.data?.object;
  if (typeof eventType !== 'string' || !object || typeof object !== 'object') {
    return ignored('unrecognised_event');
  }

  if (eventType === 'checkout.session.completed' || eventType === 'checkout.session.async_payment_succeeded') {
    if (object.payment_status === 'paid') {
      return applyFromSession(eventType, object, 'paid', 'Stripe reported this checkout session as paid.');
    }
    return applyFromSession(
      eventType,
      object,
      'unpaid',
      'Checkout completed before Stripe confirmed the funds. The order stays pending.',
    );
  }

  if (eventType === 'checkout.session.async_payment_failed') {
    return applyFromSession(eventType, object, 'failed', 'Stripe reported that the checkout payment failed.');
  }

  if (eventType === 'checkout.session.expired') {
    return applyFromSession(eventType, object, 'expired', 'The checkout session expired before payment.');
  }

  if (eventType === 'payment_intent.succeeded') {
    return applyFromPaymentIntent(eventType, object, 'paid', 'Stripe reported this payment intent as succeeded.');
  }

  if (eventType === 'payment_intent.payment_failed') {
    return applyFromPaymentIntent(eventType, object, 'failed', 'Stripe reported that the payment failed.');
  }

  return ignored('unhandled_event_type');
}
