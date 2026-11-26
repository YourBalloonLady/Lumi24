export const LOSEWELL_GIFT_URL = 'https://gobypfnqnjcacthuymaf.supabase.co/functions/v1/lumina-lumi24-gift';
export const LOSEWELL_REDEEM_URL = 'https://losewell.co.uk/redeem';
export const LOSEWELL_POSTER_URL = 'https://www.lumi24.org/losewell-email-poster.png';

const HEADLINE = "You don't have to do this alone";
const BODY = "Your Lumi24 order includes complimentary lifetime access to LoseWell — our companion app built to support you through a healthier way of losing weight, with simple daily guidance to help you stay on track.";
const INSTRUCTION = "Sign up or sign in with this email address and enter your code to unlock complimentary lifetime access — no card or subscription required.";

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function losewellSectionText(code) {
  const accessCode = String(code || '').trim();
  if (!accessCode) return '';
  return [
    HEADLINE,
    '',
    BODY,
    '',
    `Personal access code: ${accessCode}`,
    `Start your journey here: ${LOSEWELL_REDEEM_URL}`,
    INSTRUCTION,
    LOSEWELL_POSTER_URL,
  ].join('\n');
}

export function losewellSectionHtml(code) {
  const accessCode = String(code || '').trim();
  if (!accessCode) return '';
  const safeCode = escapeHtml(accessCode);
  return [
    '<div style="margin-top:28px;padding:20px;border:1px solid #e2e8f0;border-radius:16px;background:#0b1220;color:#ffffff;font-family:Inter,Arial,sans-serif;">',
    `<p style="margin:0 0 8px;font-size:22px;font-weight:800;">${HEADLINE}</p>`,
    `<p style="margin:0 0 14px;color:#e2e8f0;line-height:1.5;">${BODY}</p>`,
    `<p style="margin:0 0 8px;">Personal access code: <strong style="letter-spacing:.04em;">${safeCode}</strong></p>`,
    `<p style="margin:0 0 8px;">Start your journey here: <a href="${LOSEWELL_REDEEM_URL}" style="color:#7dd3fc;">${LOSEWELL_REDEEM_URL}</a></p>`,
    `<p style="margin:0 0 14px;color:#e2e8f0;">${INSTRUCTION}</p>`,
    `<img src="${LOSEWELL_POSTER_URL}" alt="Complimentary LoseWell access included with your Lumi24 order" width="560" style="max-width:100%;height:auto;border-radius:12px;">`,
    '</div>',
  ].join('');
}

export function losewellEmailFields(code) {
  const accessCode = String(code || '').trim();
  return {
    losewell_code: accessCode,
    losewell_redeem_url: LOSEWELL_REDEEM_URL,
    losewell_poster_url: LOSEWELL_POSTER_URL,
    losewell_section_text: losewellSectionText(accessCode),
    losewell_section_html: losewellSectionHtml(accessCode),
  };
}

export async function requestLoseWellGift({
  url = LOSEWELL_GIFT_URL,
  secret = '',
  order,
  fetchImpl = globalThis.fetch,
}) {
  if (!String(secret || '').trim()) {
    return { status: 'not_configured', code: '' };
  }
  const response = await fetchImpl(url || LOSEWELL_GIFT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lumi24-gift-secret': String(secret),
    },
    body: JSON.stringify({
      order_id: order.order_id,
      order_reference: order.order_reference || order.reference || '',
      customer_email: order.customer_email || '',
      customer_name: order.customer_name || '',
    }),
  });
  if (!response.ok) return { status: 'failed', code: '' };
  const body = await response.json().catch(() => ({}));
  const code = String(body?.losewell_code || body?.code || '').trim();
  if (!code) return { status: 'failed', code: '' };
  return { status: 'issued', code };
}

export async function ensureLoseWellCode({ book, rpc, requestGift }) {
  if (!book?.order_id || typeof requestGift !== 'function') {
    return { code: '', status: 'skipped' };
  }
  const claim = await rpc('claim_losewell_gift', { p_order_id: book.order_id });
  if (claim?.status === 'issued' && claim.code) {
    return { code: String(claim.code), status: 'issued' };
  }
  if (claim?.status === 'pending') {
    return { code: '', status: 'pending' };
  }
  if (claim?.status !== 'claim') {
    return { code: '', status: claim?.status || 'skipped' };
  }

  let gift = { status: 'failed', code: '' };
  try {
    gift = await requestGift({
      order_id: book.order_id,
      order_reference: book.reference || '',
      customer_email: book.customer_email || '',
      customer_name: book.customer_name || '',
    });
  } catch {
    gift = { status: 'failed', code: '' };
  }

  const code = String(gift?.code || '').trim();
  const stored = await rpc('store_losewell_gift', {
    p_order_id: book.order_id,
    p_code: code,
    p_status: code ? 'issued' : (gift?.status || 'failed'),
  });
  return {
    code: String(stored?.code || code || ''),
    status: stored?.status || (code ? 'issued' : (gift?.status || 'failed')),
  };
}
