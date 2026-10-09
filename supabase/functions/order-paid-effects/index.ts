import {
  deliverPaidOrderEffects,
  createServiceRoleRpc,
  sendPaidEmailThroughEmailJs,
  sendPaidTelegramUpdate,
} from '../_shared/paid-order-effects.js';

const ADMIN_EMAIL = 'luminaweight@gmail.com';
const PAID_EMAIL_SERVICE_ID = 'service_i5zi096';
const PAID_EMAIL_TEMPLATE_ID = 'template_paid';
const PAID_EMAIL_PUBLIC_KEY = 'uZOuTrBdIAc6AmKjo';

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  });
}

function bearerToken(request: Request) {
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

async function adminEmail(request: Request, supabaseUrl: string, serviceRoleKey: string) {
  const token = bearerToken(request);
  if (!token || token === serviceRoleKey) return '';
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) return '';
  const user = await response.json();
  const email = String(user?.email || '').trim().toLowerCase();
  return email === ADMIN_EMAIL ? email : '';
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Paid notifications are not configured.' }, 500);
  const actor = await adminEmail(request, supabaseUrl, serviceRoleKey);
  if (!actor) return json({ error: 'Not allowed.' }, 403);

  let body: { order_id?: string } = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Order id is required.' }, 400);
  }
  const orderId = String(body.order_id || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
    return json({ error: 'Order id is required.' }, 400);
  }

  try {
    const effects = await deliverPaidOrderEffects({
      orderId,
      actor,
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
    return json(effects);
  } catch (error) {
    console.error('Paid order notifications failed.');
    const effects = error instanceof Error && 'effects' in error ? error.effects : undefined;
    return json({ error: 'Paid notifications failed.', ...(effects ? { effects } : {}) }, 500);
  }
});
