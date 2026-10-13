import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendAdminTelegram } from '../_shared/admin-new-order.js';
import {
  ADMIN_SUMMARY_CHAT_ID,
  runPayBefore3pmReminders,
  sendPayBefore3pmEmail,
} from '../_shared/pay-before-3pm.js';

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

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !serviceKey) return json({ ok: false, skipped: 'not_configured', sent: 0 });

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: settings, error: settingsError } = await db.rpc('pay_before_3pm_settings');
  if (settingsError || !settings?.cron_secret) return json({ ok: false, skipped: 'not_configured', sent: 0 });
  const provided = request.headers.get('x-cron-secret') || '';
  if (!(await sameSecret(provided, String(settings.cron_secret)))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: { dry_run?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const { data: paused, error: pauseError } = await db.rpc('orders_are_paused');
  if (pauseError) return json({ ok: false, skipped: 'pause_check_failed', sent: 0 });

  const result = await runPayBefore3pmReminders({
    paused: paused === true,
    dryRun: body.dry_run === true,
    preview: async (cutoff) => {
      const { data, error } = await db.rpc('preview_pay_before_3pm_reminders', { p_cutoff: cutoff });
      if (error) throw new Error('Could not list 3pm reminders.');
      return Array.isArray(data) ? data : [];
    },
    claim: async (cutoff) => {
      const { data, error } = await db.rpc('claim_pay_before_3pm_reminders', {
        p_cutoff: cutoff,
        p_limit: 50,
      });
      if (error) throw new Error('Could not claim 3pm reminders.');
      return Array.isArray(data) ? data : [];
    },
    finish: async (orderId, outcome) => {
      const { error } = await db.rpc('finish_pay_before_3pm_reminder', {
        p_order_id: orderId,
        p_result: outcome,
      });
      if (error) throw new Error('Could not record the 3pm reminder.');
    },
    sendEmail: (params) => sendPayBefore3pmEmail({
      params,
      privateKey: Deno.env.get('EMAILJS_PRIVATE_KEY') || '',
      templateId: Deno.env.get('EMAILJS_PAY_BEFORE_3PM_TEMPLATE_ID') || undefined,
      publicKey: Deno.env.get('EMAILJS_PUBLIC_KEY') || undefined,
    }),
    sendTelegram: async (text) => {
      const token = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
      if (!token) throw new Error('Telegram is not configured.');
      await sendAdminTelegram({ token, chatId: ADMIN_SUMMARY_CHAT_ID, text });
    },
  });

  return json(result);
});
