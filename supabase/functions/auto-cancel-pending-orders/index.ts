import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendAdminTelegram } from '../_shared/admin-new-order.js';
import {
  ADMIN_SUMMARY_CHAT_ID,
  runAutoCancelPending,
  sendCancelledEmail,
} from '../_shared/auto-cancel-pending.js';

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
  if (!supabaseUrl || !serviceKey) return json({ ok: false, skipped: 'not_configured', cancelled: 0 });

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: settings, error: settingsError } = await db.rpc('auto_cancel_pending_settings');
  if (settingsError || !settings?.cron_secret) return json({ ok: false, skipped: 'not_configured', cancelled: 0 });
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

  try {
    const result = await runAutoCancelPending({
      dryRun: body.dry_run === true,
      preview: async (cutoff) => {
        const { data, error } = await db.rpc('preview_auto_cancel_pending_orders', { p_cutoff: cutoff });
        if (error) throw new Error('Could not list stale pending orders.');
        return Array.isArray(data) ? data : [];
      },
      claim: async (cutoff) => {
        const { data, error } = await db.rpc('claim_auto_cancel_pending_order', { p_cutoff: cutoff });
        if (error) throw new Error('Could not cancel a stale pending order.');
        return data;
      },
      claimEmail: async () => {
        const { data, error } = await db.rpc('claim_auto_cancel_email');
        if (error) throw new Error('Could not retry a cancelled email.');
        return data;
      },
      finishEmail: async (orderId, outcome) => {
        const { error } = await db.rpc('finish_auto_cancel_email', {
          p_order_id: orderId,
          p_result: outcome,
        });
        if (error) throw new Error('Could not record the cancelled email.');
      },
      sendEmail: (params) => sendCancelledEmail({
        params,
        privateKey: Deno.env.get('EMAILJS_PRIVATE_KEY') || '',
        templateId: Deno.env.get('EMAILJS_CANCELLED_TEMPLATE_ID') || undefined,
        publicKey: Deno.env.get('EMAILJS_PUBLIC_KEY') || undefined,
      }),
      sendTelegram: async (text) => {
        const token = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
        if (!token) throw new Error('Telegram is not configured.');
        await sendAdminTelegram({ token, chatId: ADMIN_SUMMARY_CHAT_ID, text });
      },
    });
    return json(result);
  } catch {
    console.error('Auto-cancel pending orders failed.');
    return json({ ok: false, skipped: 'failed', cancelled: 0 }, 500);
  }
});
