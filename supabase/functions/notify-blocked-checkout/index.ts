import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendAdminTelegram } from '../_shared/admin-new-order.js';
import { handleBlockedCheckout } from '../_shared/blocked-checkout.js';

// The database calls this while rejecting a blocked checkout. It checks a
// vault secret instead of a Supabase login token, and messages only Tim's
// admin chat. The response never includes the matched details.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

Deno.serve(async (request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
  let expectedSecret = '';

  if (supabaseUrl && serviceKey) {
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data } = await db.rpc('blocked_checkout_notify_settings');
    expectedSecret = String(data?.notify_secret || '');
  }

  let payload: unknown = {};
  if (request.method === 'POST') {
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }
  }

  const result = await handleBlockedCheckout({
    method: request.method,
    providedSecret: request.headers.get('x-notify-secret') || '',
    expectedSecret,
    payload,
    token: botToken,
    send: sendAdminTelegram,
  });
  return json(result.body, result.status);
});
