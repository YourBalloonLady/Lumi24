import { createClient } from 'npm:@supabase/supabase-js@2';
import { deliverAdminNewOrderAlert } from '../_shared/admin-new-order.js';

// Tim's admin account is @Admi_181. The numeric chat id lives in vault
// (telegram_admin_chat_id) or TELEGRAM_ADMIN_CHAT_ID. Customer order updates
// stay on their own path. This alert never messages a customer chat.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function sameSecret(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = left.length === 0 || right.length === 0 ? 1 : 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function adminChatId(settings: { admin_chat_id?: string }) {
  const fromEnv = String(Deno.env.get('TELEGRAM_ADMIN_CHAT_ID') || '').trim();
  const fromVault = String(settings?.admin_chat_id || '').trim();
  const chatId = fromEnv || fromVault;
  if (!/^-?\d{5,20}$/.test(chatId)) return { chatId: '', source: '' };
  return { chatId, source: fromEnv ? 'env' : 'vault' };
}

const TEST_ORDER = {
  reference: 'LWTESTONLY',
  total_amount: 0,
  details: {
    customer: { name: 'TEST' },
    items: [{ name: 'TEST item', qty: 1, line_total: 0 }],
  },
};

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, delivered: false, reason: 'not_configured' });
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: settings, error: settingsError } = await db.rpc('admin_order_notify_settings');
  if (settingsError || !settings?.notify_secret) {
    return json({ ok: false, delivered: false, reason: 'not_configured' });
  }
  const provided = request.headers.get('x-notify-secret') || '';
  if (!(await sameSecret(provided, String(settings.notify_secret)))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: { order_id?: string; test?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const { chatId, source } = adminChatId(settings || {});
  if (body.test === true) {
    const result = await deliverAdminNewOrderAlert({
      order: TEST_ORDER,
      token: botToken,
      chatId,
      test: true,
    });
    return json({
      ok: true,
      delivered: result.delivered,
      reason: result.reason || null,
      destination: 'admin',
      admin_username: '@Admi_181',
      chat_source: source || null,
      message: result.message,
    });
  }

  const orderId = String(body.order_id || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
    return json({ ok: true, delivered: false, reason: 'missing_order' });
  }

  const { data: order, error: orderError } = await db
    .from('Orders')
    .select('id, reference, total_amount, details')
    .eq('id', orderId)
    .maybeSingle();
  if (orderError || !order) {
    return json({ ok: true, delivered: false, reason: 'order_not_found' });
  }

  const result = await deliverAdminNewOrderAlert({
    order,
    token: botToken,
    chatId,
  });
  return json({
    ok: true,
    delivered: result.delivered,
    reason: result.reason || null,
    destination: 'admin',
  });
});
