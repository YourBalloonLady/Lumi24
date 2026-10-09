import { handlePaymentLinkWebhook } from './payment.js';

const MAX_BYTES = 1_000_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function applyEvent(instruction: {
  eventId: string;
  eventType: string;
  orderReference: string;
  amountPence: number | null;
  currency: string;
  paymentStatus: string;
  checkoutSessionId: string;
}) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase service role is not configured.');
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/apply_payment_link_event`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_event_id: instruction.eventId,
      p_event_type: instruction.eventType,
      p_order_reference: instruction.orderReference,
      p_amount_pence: instruction.amountPence,
      p_currency: instruction.currency,
      p_payment_status: instruction.paymentStatus,
      p_checkout_session_id: instruction.checkoutSessionId,
    }),
  });

  if (!response.ok) {
    throw new Error('Could not record the payment.');
  }
  return response.json();
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const claimedLength = Number(request.headers.get('content-length') || 0);
  if (claimedLength > MAX_BYTES) return json({ error: 'Request is too large.' }, 413);

  const payload = await request.text();
  if (payload.length > MAX_BYTES) return json({ error: 'Request is too large.' }, 413);

  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET') || '';
  if (!secret) return json({ error: 'Stripe webhook is not configured yet.' }, 500);

  try {
    const result = await handlePaymentLinkWebhook({
      payload,
      signature: request.headers.get('stripe-signature') || '',
      secret,
      applyEvent,
    });
    return json(result.body, result.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('Invalid Stripe signature') || message.includes('timestamp')) {
      return json({ error: 'Invalid Stripe signature.' }, 400);
    }
    console.error('Payment Link webhook failed.');
    return json({ error: 'Could not record the payment.' }, 500);
  }
});
