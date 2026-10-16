// The admin "3PM reminder" button sends this EmailJS template with these fields.
// The wording lives in that template. Do not replace it with a different body.

export const PAY_BEFORE_3PM_SERVICE_ID = 'service_i5zi096';
export const PAY_BEFORE_3PM_TEMPLATE_ID = 'template_paybefore3pm';
export const PAY_BEFORE_3PM_PUBLIC_KEY = 'uZOuTrBdIAc6AmKjo';
export const PAYMENT_CONFIRMATION_NOTICE = 'Already paid? You can ignore this email and wait for your payment confirmation email. Payment confirmations are completed manually, so they may not be sent instantly—especially overnight. Please don’t worry; we’ll confirm your payment as soon as it has been checked.';
export const ADMIN_SUMMARY_CHAT_ID = '5839927114';

export function londonParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    hour: Number(value.hour),
    minute: Number(value.minute),
  };
}

// 14:00 Europe/London on the same civil day as `date`, as a UTC instant.
// BST is UTC+1 and GMT is UTC+0, including the March and October changes.
export function londonTwoPm(date) {
  const parts = londonParts(date);
  const utcGuess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 14, 0, 0));
  const shiftHours = londonParts(utcGuess).hour - 14;
  return new Date(utcGuess.getTime() - shiftHours * 60 * 60 * 1000);
}

// Delivery delays do not stop payment reminders. The paused argument is ignored.
export function reminderDecision(date) {
  const hour = londonParts(date).hour;
  const cutoff = londonTwoPm(date).toISOString();
  if (hour !== 14) return { due: false, reason: 'not_due', hour, cutoff };
  return { due: true, reason: null, hour, cutoff };
}

export function payBefore3pmTemplateParams(order) {
  const toEmail = String(order?.email || '').trim();
  if (!toEmail) return null;
  const name = order?.customerName ?? order?.customer_name;
  const total = order?.totalAmount ?? order?.total_amount;
  const reference = order?.reference ?? order?.order_ref;
  return {
    email: toEmail,
    customer_name: String(name || '').trim() || 'Customer',
    order_ref: String(reference || '').trim(),
    order_total: `£${Number(total || 0).toFixed(2)}`,
    payment_confirmation_notice: PAYMENT_CONFIRMATION_NOTICE,
  };
}

export function payBefore3pmSummary(references) {
  const refs = references.map((reference) => String(reference || '').trim()).filter(Boolean);
  const noun = refs.length === 1 ? 'order' : 'orders';
  return `Sent 3pm payment email to ${refs.length} pending ${noun}: ${refs.join(', ')}`;
}

export async function sendPayBefore3pmEmail({
  params,
  serviceId = PAY_BEFORE_3PM_SERVICE_ID,
  templateId = PAY_BEFORE_3PM_TEMPLATE_ID,
  publicKey = PAY_BEFORE_3PM_PUBLIC_KEY,
  privateKey = '',
  fetchImpl = globalThis.fetch,
}) {
  if (!params?.email) throw new Error('3pm reminder is missing an address.');
  if (!serviceId || !templateId || !publicKey) throw new Error('3pm reminder email is not configured.');
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
        order_total: params.order_total,
        payment_confirmation_notice: params.payment_confirmation_notice,
      },
    }),
  });
  if (!response.ok) throw new Error('3pm reminder email was rejected.');
}

export async function runPayBefore3pmReminders({
  now = new Date(),
  paused = false,
  dryRun = false,
  preview,
  claim,
  finish,
  sendEmail,
  sendTelegram,
}) {
  void paused;
  const decision = reminderDecision(now);
  if (dryRun) {
    const rows = await preview(decision.cutoff);
    return {
      ok: true,
      dry_run: true,
      due: decision.due,
      skipped: decision.reason,
      london_hour: decision.hour,
      cutoff: decision.cutoff,
      count: rows.length,
      references: rows.map((row) => row.reference),
      sent: 0,
    };
  }
  if (!decision.due) {
    return {
      ok: true,
      skipped: decision.reason,
      london_hour: decision.hour,
      cutoff: decision.cutoff,
      sent: 0,
      failed: 0,
      telegram: 'skipped',
    };
  }

  const sent = [];
  let failed = 0;
  for (let batch = 0; batch < 8; batch += 1) {
    const rows = await claim(decision.cutoff);
    if (!rows.length) break;
    for (const row of rows) {
      const params = payBefore3pmTemplateParams(row);
      if (!params) {
        await finish(row.order_id, 'failed');
        failed += 1;
        continue;
      }
      try {
        await sendEmail(params);
        await finish(row.order_id, 'sent');
        sent.push(row.reference);
      } catch {
        await finish(row.order_id, 'failed');
        failed += 1;
      }
    }
  }

  let telegram = 'skipped';
  if (sent.length && sendTelegram) {
    try {
      await sendTelegram(payBefore3pmSummary(sent));
      telegram = 'sent';
    } catch {
      telegram = 'failed';
    }
  }

  return {
    ok: true,
    skipped: null,
    london_hour: decision.hour,
    cutoff: decision.cutoff,
    sent: sent.length,
    failed,
    telegram,
    references: sent,
  };
}
