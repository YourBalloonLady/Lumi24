// Tim's admin chat. A blocked checkout alerts this chat only.
export const BLOCKED_CHECKOUT_CHAT_ID = '5839927114';

export const CUSTOMER_BLOCK_MESSAGE = "We're unable to process this order. Please contact us.";

const REASON_LABELS = {
  email: 'email',
  phone: 'phone',
  address: 'postcode with the house number or street',
  surname_postcode: 'surname with the postcode',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function blockedCheckoutTelegramText(payload) {
  const reasons = Array.isArray(payload?.reasons) ? payload.reasons.map((reason) => String(reason)) : [];
  const matched = payload?.matched && typeof payload.matched === 'object' ? payload.matched : {};
  const labels = reasons.map((reason) => REASON_LABELS[reason] || reason);
  const lines = [
    'Blocked checkout attempt',
    `Matched: ${labels.length ? labels.join(', ') : 'unknown'}`,
  ];
  const addressMatch = reasons.includes('address') || reasons.includes('surname_postcode');

  if (reasons.includes('surname_postcode') && matched.name) lines.push(`Name: ${escapeHtml(matched.name)}`);
  if (reasons.includes('email') && matched.email) lines.push(`Email: ${escapeHtml(matched.email)}`);
  if (reasons.includes('phone') && matched.phone) lines.push(`Phone: ${escapeHtml(matched.phone)}`);
  if (addressMatch && matched.address) lines.push(`Address: ${escapeHtml(matched.address)}`);
  if (addressMatch && matched.postcode) lines.push(`Postcode: ${escapeHtml(matched.postcode)}`);
  return lines.join('\n');
}

export async function sameSecret(left, right) {
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

export async function handleBlockedCheckout({
  method,
  providedSecret,
  expectedSecret,
  payload,
  token,
  send,
}) {
  if (method !== 'POST') {
    return { status: 405, body: { error: 'Method not allowed.' } };
  }
  if (!(await sameSecret(String(providedSecret || ''), String(expectedSecret || '')))) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  const reasons = Array.isArray(payload?.reasons) ? payload.reasons : [];
  if (reasons.length === 0) {
    return { status: 200, body: { ok: true, delivered: false } };
  }

  const text = blockedCheckoutTelegramText(payload);
  try {
    await send({
      token,
      chatId: BLOCKED_CHECKOUT_CHAT_ID,
      text,
    });
    return { status: 200, body: { ok: true, delivered: true } };
  } catch {
    return { status: 200, body: { ok: true, delivered: false } };
  }
}
