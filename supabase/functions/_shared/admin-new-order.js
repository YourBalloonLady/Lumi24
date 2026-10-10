// Admin-only new-order Telegram text. This never reads a customer chat.

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function paymentMethodLabel(details) {
  const raw = String(
    details?.meta?.payment_method
    || details?.payment_method
    || ''
  ).trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');

  if (raw === 'card' || raw === 'stripe' || raw === 'card_payment') return 'Card';
  if (raw === 'bank' || raw === 'bank_transfer' || raw === 'transfer') return 'Bank transfer';
  if (!raw) return 'Card or bank transfer';
  return String(details?.meta?.payment_method || details?.payment_method).trim();
}

function itemLine(item) {
  const qty = Math.max(1, Math.trunc(Number(item?.qty ?? item?.quantity ?? 1) || 1));
  const name = String(item?.name || 'Item').trim() || 'Item';
  const extras = [];
  if (item?.variant_label) extras.push(String(item.variant_label));
  else if (item?.variant === 'cartridge-only') extras.push('Cartridge Only');
  else if (item?.variant === 'full-kit') extras.push('Full Kit (Pen + Cartridge)');
  if (item?.pen_heads) {
    extras.push(`Pen heads: ${item.pen_heads === 'none' ? 'None required' : item.pen_heads}`);
  }
  if (item?.syringes) {
    extras.push(`Syringes: ${item.syringes === 'none' ? 'None required' : item.syringes}`);
  }
  if (item?.sema_form) extras.push(String(item.sema_form));
  const colour = item?.pen_colour || item?.penColour;
  if (colour) extras.push(String(colour));
  const lineTotal = Number(item?.line_total ?? (Number(item?.price_each ?? item?.price ?? 0) * qty));
  const extraText = extras.length ? ` (${extras.join(', ')})` : '';
  const price = Number.isFinite(lineTotal) ? ` — £${lineTotal.toFixed(2)}` : '';
  return `${qty} × ${name}${extraText}${price}`;
}

export function adminNewOrderMessage(order, { test = false } = {}) {
  const details = order?.details && typeof order.details === 'object' ? order.details : {};
  const items = Array.isArray(details.items) ? details.items : [];
  const total = Number(order?.total_amount ?? 0);
  const delivery = details.delivery && typeof details.delivery === 'object' ? details.delivery : {};
  const lines = [];

  if (test) {
    lines.push('<b>TEST</b> new-order alert');
    lines.push('No customer order was created.');
  } else {
    lines.push('<b>New order</b>');
  }
  lines.push('');
  lines.push(`Reference: <b>${escapeHtml(order?.reference || '')}</b>`);
  lines.push(`Customer: ${escapeHtml(details.customer?.name || 'Customer')}`);
  lines.push(`Payment method: ${escapeHtml(paymentMethodLabel(details))}`);
  lines.push(`Total: £${escapeHtml((Number.isFinite(total) ? total : 0).toFixed(2))}`);
  lines.push('');
  lines.push('Items:');
  if (items.length === 0) lines.push('No items listed');
  for (const item of items) lines.push(escapeHtml(itemLine(item)));
  if (delivery.label) lines.push(`Delivery: ${escapeHtml(delivery.label)}`);

  return lines.join('\n');
}

export async function sendAdminTelegram({ token, chatId, text, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram returned ${response.status}: ${String(body).slice(0, 180)}`);
  }
}

export async function deliverAdminNewOrderAlert({
  order,
  token,
  chatId,
  send = sendAdminTelegram,
  test = false,
}) {
  const message = adminNewOrderMessage(order, { test });
  const destination = 'admin';
  if (!String(token || '').trim() || !String(chatId || '').trim()) {
    return { ok: true, delivered: false, reason: 'admin_chat_not_configured', destination, message };
  }
  try {
    await send({ token, chatId: String(chatId), text: message });
    return { ok: true, delivered: true, destination, message };
  } catch {
    return { ok: true, delivered: false, reason: 'telegram_error', destination, message };
  }
}
