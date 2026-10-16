import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const END = Date.parse('2026-10-26T00:00:00.000Z');
const LABEL = 'I understand that orders placed now will be dispatched when deliveries restart on Monday 26th October.';

async function pauseApi() {
  const code = await readFile(new URL('../public/order-pause.js', import.meta.url), 'utf8');
  const context = {
    console,
    Date,
    Intl,
    setInterval,
    clearInterval,
    document: {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.LuminaOrderPause;
}

test('ordering stays open and the delivery notice ends at midnight UK on 26 October', async () => {
  const pause = await pauseApi();
  assert.equal(pause.deliveriesRestartAtMs, END);
  assert.equal(pause.isOrderingPaused(new Date('2026-10-16T15:00:00.000Z')), false);
  assert.equal(pause.isOrderingPaused(new Date('2026-10-19T07:00:00.000Z')), false);
  assert.equal(pause.isOrderingPaused(new Date('2026-10-25T23:59:59.000Z')), false);
  assert.equal(pause.acknowledgementRequired(new Date('2026-10-16T15:05:00.000Z')), true);
  assert.equal(pause.acknowledgementRequired(new Date('2026-10-25T23:59:59.000Z')), true);
  assert.equal(pause.acknowledgementRequired(new Date('2026-10-26T00:00:00.000Z')), false);
  assert.equal(pause.isNoticeDue(new Date('2026-10-26T00:00:00.000Z')), false);
});

test('the notice says deliveries restart and the countdown runs to 26 October', async () => {
  const pause = await pauseApi();
  const during = pause.describe(new Date('2026-10-16T15:05:00.000Z'));
  assert.equal(during.paused, false);
  assert.equal(during.title, 'Deliveries paused until Monday 26th October');
  assert.equal(during.text, 'Deliveries paused until Monday 26th October. You can still order now and we\'ll dispatch from the 26th.');
  assert.equal(during.countdownText, 'Deliveries restart in 9d 08:55:00');
  assert.equal(during.acknowledgementLabel, LABEL);
  assert.equal(during.text.includes('Orders are paused'), false);
  assert.equal(during.text.includes('today'), false);

  const finished = pause.describe(new Date('2026-10-26T00:00:00.000Z'));
  assert.equal(finished.visible, false);
  assert.equal(finished.acknowledgementRequired, false);
  assert.equal(pause.formatRemaining(0), '00:00:00');
});

test('checkout keeps the tick box and the database reopens ordering', async () => {
  const checkout = await readFile(new URL('../public/checkout.html', import.meta.url), 'utf8');
  const home = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const products = await readFile(new URL('../public/products.html', import.meta.url), 'utf8');
  const sql = await readFile(
    new URL('../supabase/migrations/20261016160000_reopen_orders_delivery_ack.sql', import.meta.url),
    'utf8',
  );
  const reminder = await readFile(
    new URL('../supabase/functions/send-pay-before-3pm/index.ts', import.meta.url),
    'utf8',
  );
  assert.match(checkout, /id="deliveryRestartAck"/);
  assert.match(checkout, /I understand that orders placed now will be dispatched when deliveries restart on Monday 26th October\./);
  assert.match(checkout, /delivery_restart_acknowledged: details\.deliveryRestartAcknowledged === true/);
  assert.equal(checkout.includes('isOrderingPaused'), false);
  assert.equal(home.includes('isOrderingPaused'), false);
  assert.equal(products.includes('isOrderingPaused'), false);
  assert.match(sql, /select false/);
  assert.match(sql, /delivery_restart_acknowledged/);
  assert.match(sql, /2026-10-26 00:00:00/);
  assert.equal(sql.includes('if public.orders_are_paused()'), false);
  assert.equal(reminder.includes('orders_are_paused'), false);
  const pauseSource = await readFile(new URL('../public/order-pause.js', import.meta.url), 'utf8');
  const nav = await readFile(new URL('../public/site-nav.js', import.meta.url), 'utf8');
  assert.equal(pauseSource.includes('MutationObserver'), false);
  assert.equal(nav.includes('MutationObserver'), false);
});
