// The admin "Cancel + restock" button calls cancel_order_and_restock, then
// EmailJS template_cancelled. This job uses that same database function and
// the same template fields. The button does not send a customer Telegram.

export const CANCELLED_EMAIL_SERVICE_ID = 'service_i5zi096';
export const CANCELLED_EMAIL_TEMPLATE_ID = 'template_cancelled';
export const CANCELLED_EMAIL_PUBLIC_KEY = 'uZOuTrBdIAc6AmKjo';
export const ADMIN_SUMMARY_CHAT_ID = '5839927114';
export const AUTO_CANCEL_AFTER_MS = 24 * 60 * 60 * 1000;

export function autoCancelCutoff(now = new Date()) {
  return new Date(now.getTime() - AUTO_CANCEL_AFTER_MS).toISOString();
}

export function cancelledOrderDate(createdAt, now = new Date()) {
  const raw = String(createdAt || '').trim();
  const source = raw || now.toISOString();
  const iso = /(?:z|[+-]\d{2}:?\d{2})$/i.test(source)
    ? source
    : `${source.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return source;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export function cancelledEmailTemplateParams(order, now = new Date()) {
  const toEmail = String(order?.email || '').trim();
  if (!toEmail) return null;
  const name = order?.customerName ?? order?.customer_name;
  const reference = order?.reference ?? order?.order_ref;
  const createdAt = order?.created_at_utc ?? order?.created_at ?? order?.createdAt;
  return {
    email: toEmail,
    customer_name: String(name || '').trim() || 'Customer',
    order_ref: String(reference || '').trim(),
    order_date: cancelledOrderDate(createdAt, now),
  };
}

export function autoCancelSummary(references, failed = []) {
  const lines = [];
  const refs = references.map((reference) => String(reference || '').trim()).filter(Boolean);
  const stuck = failed.map((reference) => String(reference || '').trim()).filter(Boolean);
  if (refs.length) {
    const noun = refs.length === 1 ? 'order' : 'orders';
    lines.push(`Auto-cancelled ${refs.length} pending ${noun} after 24 hours: ${refs.join(', ')}`);
  }
  if (stuck.length) {
    const noun = stuck.length === 1 ? 'order' : 'orders';
    lines.push(`Could not auto-cancel ${stuck.length} pending ${noun} (stock was not changed): ${stuck.join(', ')}`);
  }
  return lines.join('\n');
}

export async function sendCancelledEmail({
  params,
  serviceId = CANCELLED_EMAIL_SERVICE_ID,
  templateId = CANCELLED_EMAIL_TEMPLATE_ID,
  publicKey = CANCELLED_EMAIL_PUBLIC_KEY,
  privateKey = '',
  fetchImpl = globalThis.fetch,
}) {
  if (!params?.email) throw new Error('Cancelled email is missing an address.');
  if (!serviceId || !templateId || !publicKey) throw new Error('Cancelled email is not configured.');
  const response = await fetchImpl('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      ...(privateKey ? { accessToken: privateKey } : {}),
      template_params: {
        email: params.email,
        customer_name: params.customer_name,
        order_ref: params.order_ref,
        order_date: params.order_date,
      },
    }),
  });
  if (!response.ok) throw new Error('Cancelled email was rejected.');
}

function safeOrders(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    reference: row?.reference || '',
    created_at: row?.created_at || null,
    due_at: row?.due_at || null,
  }));
}

async function deliverCancelledEmail(row, finishEmail, sendEmail) {
  if (!row?.email_pending) return 'skipped';
  const orderId = row.order_id || row.id;
  const params = cancelledEmailTemplateParams(row);
  if (!orderId || !params) {
    if (orderId) await finishEmail(orderId, 'failed');
    return 'failed';
  }
  try {
    await sendEmail(params);
    await finishEmail(orderId, 'sent');
    return 'sent';
  } catch {
    await finishEmail(orderId, 'failed').catch(() => {});
    return 'failed';
  }
}

export async function runAutoCancelPending({
  now = new Date(),
  dryRun = false,
  preview,
  claim,
  claimEmail,
  finishEmail,
  sendEmail,
  sendTelegram,
}) {
  const cutoff = autoCancelCutoff(now);
  if (dryRun) {
    const orders = safeOrders(await preview(cutoff));
    return {
      ok: true,
      dry_run: true,
      cutoff,
      count: orders.length,
      orders,
      cancelled: 0,
      failed: 0,
      emails_sent: 0,
      emails_failed: 0,
      telegram: 'skipped',
    };
  }

  const cancelled = [];
  const failed = [];
  let emailsSent = 0;
  let emailsFailed = 0;

  for (let index = 0; index < 50; index += 1) {
    const row = await claim(cutoff);
    if (!row || row.status === 'none') break;
    if (row.status === 'failed') {
      if (row.reference) failed.push(row.reference);
      continue;
    }
    if (row.status !== 'Cancelled') continue;
    if (row.reference) cancelled.push(row.reference);
    const emailResult = await deliverCancelledEmail(row, finishEmail, sendEmail);
    if (emailResult === 'sent') emailsSent += 1;
    if (emailResult === 'failed') emailsFailed += 1;
  }

  if (claimEmail) {
    for (let index = 0; index < 50; index += 1) {
      const row = await claimEmail();
      if (!row || row.status === 'none') break;
      if (row.status !== 'email') break;
      const emailResult = await deliverCancelledEmail(row, finishEmail, sendEmail);
      if (emailResult === 'sent') emailsSent += 1;
      if (emailResult === 'failed') emailsFailed += 1;
    }
  }

  let telegram = 'skipped';
  if ((cancelled.length || failed.length) && sendTelegram) {
    try {
      await sendTelegram(autoCancelSummary(cancelled, failed));
      telegram = 'sent';
    } catch {
      telegram = 'failed';
    }
  }

  return {
    ok: true,
    dry_run: false,
    cutoff,
    cancelled: cancelled.length,
    failed: failed.length,
    emails_sent: emailsSent,
    emails_failed: emailsFailed,
    references: cancelled,
    failed_references: failed,
    telegram,
  };
}
