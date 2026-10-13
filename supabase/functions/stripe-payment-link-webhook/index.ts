import { sendAdminTelegram } from '../_shared/admin-new-order.js';
import { handlePaymentLinkWebhook, cancelledPaymentAlertText } from './payment.js';
import {
  createServiceRoleRpc,
  deliverPaidOrderEffects,
  sendPaidEmailThroughEmailJs,
  sendPaidTelegramUpdate,
} from '../_shared/paid-order-effects.js';

const ADMIN_PAYMENT_ALERT_CHAT_ID = '5839927114';

const PAID_EMAIL_SERVICE_ID = 'service_i5zi096';
const PAID_EMAIL_TEMPLATE_ID = 'template_paid';
const PAID_EMAIL_PUBLIC_KEY = 'uZOuTrBdIAc6AmKjo';

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

async function serviceRpc(name: string, args: Record<string, unknown>) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase service role is not configured.');
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error('Could not record the cancelled payment alert.');
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function alertCancelledPayment(reference: string) {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
  if (!token) throw new Error('Telegram is not configured.');
  await sendAdminTelegram({
    token,
    chatId: ADMIN_PAYMENT_ALERT_CHAT_ID,
    text: cancelledPaymentAlertText(reference),
  });
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const result = await handlePaymentLinkWebhook({
      payload,
      signature: request.headers.get('stripe-signature') || '',
      secret,
      applyEvent,
      onPaidOrder: async (instruction) => {
        if (!supabaseUrl || !serviceRoleKey || !instruction.orderReference) {
          throw new Error('Paid notifications are not configured.');
        }
        await deliverPaidOrderEffects({
          orderReference: instruction.orderReference,
          actor: 'stripe-webhook',
          rpc: createServiceRoleRpc({ supabaseUrl, serviceRoleKey }),
          sendEmail: (params) => sendPaidEmailThroughEmailJs({
            params,
            serviceId: PAID_EMAIL_SERVICE_ID,
            templateId: Deno.env.get('EMAILJS_PAID_TEMPLATE_ID') || PAID_EMAIL_TEMPLATE_ID,
            publicKey: Deno.env.get('EMAILJS_PUBLIC_KEY') || PAID_EMAIL_PUBLIC_KEY,
            privateKey: Deno.env.get('EMAILJS_PRIVATE_KEY') || '',
          }),
          sendTelegram: (orderReference) => sendPaidTelegramUpdate({
            supabaseUrl,
            serviceRoleKey,
            orderReference,
          }),
        });
      },
      onCancelledPayment: async (_instruction, result) => {
        const orderId = String(result?.order_id || '').trim();
        if (!orderId) throw new Error('Cancelled order id is missing.');
        const claimed = await serviceRpc('claim_cancelled_payment_alert', { p_order_id: orderId });
        if (!claimed?.claimed) return;
        try {
          await alertCancelledPayment(String(claimed.reference || result?.reference || ''));
          await serviceRpc('finish_cancelled_payment_alert', {
            p_order_id: orderId,
            p_result: 'sent',
          });
        } catch (error) {
          await serviceRpc('finish_cancelled_payment_alert', {
            p_order_id: orderId,
            p_result: 'failed',
          }).catch(() => {});
          throw error;
        }
      },
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
