export function paidEmailTemplateParams({ email, customerName, reference, totalAmount }) {
  const toEmail = String(email || '').trim();
  if (!toEmail) return null;
  const name = String(customerName || '').trim() || 'Customer';
  const ref = String(reference || '').trim();
  return {
    email: toEmail,
    customer_name: name,
    order_ref: ref,
    order_total: `£${Number(totalAmount || 0).toFixed(2)}`,
  };
}

export function createServiceRoleRpc({ supabaseUrl, serviceRoleKey, fetchImpl = globalThis.fetch }) {
  return async function rpc(name, args) {
    const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args ?? {}),
    });
    if (!response.ok) throw new Error('Could not update the paid order.');
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

export async function sendPaidEmailThroughEmailJs({
  params,
  serviceId,
  templateId,
  publicKey,
  privateKey,
  fetchImpl = globalThis.fetch,
}) {
  if (!params?.email) throw new Error('Paid email is missing an address.');
  if (!serviceId || !templateId || !publicKey) throw new Error('Paid email is not configured.');

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
      },
    }),
  });
  if (!response.ok) throw new Error('Paid email was rejected.');
}

export async function sendPaidTelegramUpdate({
  supabaseUrl,
  serviceRoleKey,
  orderReference,
  fetchImpl = globalThis.fetch,
}) {
  const response = await fetchImpl(`${supabaseUrl}/functions/v1/send-telegram-order-update`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      order_reference: orderReference,
      status: 'Paid',
      tracking_number: '',
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error('Telegram update failed.');
  return { noConnection: text.includes('No Telegram connection') };
}

async function deliverOne({ book, effect, rpc, send }) {
  if (book[effect] !== 'pending') return book[effect] || 'skipped';

  const claimed = await rpc('claim_paid_order_effect', {
    p_order_id: book.order_id,
    p_effect: effect,
  });
  if (!claimed) return 'already_sent';

  try {
    const outcome = await send();
    const result = outcome === 'skipped' ? 'skipped' : 'sent';
    await rpc('finish_paid_order_effect', {
      p_order_id: book.order_id,
      p_effect: effect,
      p_result: result,
    });
    return result;
  } catch (error) {
    await rpc('finish_paid_order_effect', {
      p_order_id: book.order_id,
      p_effect: effect,
      p_result: 'failed',
    }).catch(() => {});
    throw error;
  }
}

export async function deliverPaidOrderEffects({
  orderId = null,
  orderReference = null,
  actor,
  rpc,
  sendEmail,
  sendTelegram,
}) {
  const book = await rpc('prepare_paid_order_effects', {
    p_order_id: orderId,
    p_order_reference: orderReference,
    p_actor: actor,
  });

  if (!book || book.status !== 'ready') {
    return {
      status: book?.status || 'skipped',
      email: 'skipped',
      telegram: 'skipped',
    };
  }

  const effects = {
    status: 'ready',
    email: book.email,
    telegram: book.telegram,
  };
  const errors = [];

  try {
    effects.email = await deliverOne({
      book,
      effect: 'email',
      rpc,
      send: async () => {
        const params = paidEmailTemplateParams({
          email: book.customer_email,
          customerName: book.customer_name,
          reference: book.reference || book.order_id,
          totalAmount: book.total_amount,
        });
        if (!params) return 'skipped';
        await sendEmail(params);
        return 'sent';
      },
    });
  } catch (error) {
    effects.email = 'failed';
    errors.push(error);
  }

  try {
    effects.telegram = await deliverOne({
      book,
      effect: 'telegram',
      rpc,
      send: async () => {
        if (!book.reference) return 'skipped';
        await sendTelegram(book.reference);
        return 'sent';
      },
    });
  } catch (error) {
    effects.telegram = 'failed';
    errors.push(error);
  }

  if (errors.length) {
    const failure = new Error('Paid order notifications failed.');
    failure.effects = effects;
    throw failure;
  }
  return effects;
}
