import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const START = Date.parse('2026-10-16T15:00:00.000Z');
const END = Date.parse('2026-10-26T00:00:00.000Z');

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

test('the pause runs from 16:00 UK on 16 October until midnight UK on 26 October', async () => {
  const pause = await pauseApi();
  assert.equal(pause.orderingStartsAtMs, START);
  assert.equal(pause.orderingEndsAtMs, END);
  assert.equal(pause.isOrderingPaused(new Date('2026-10-16T14:59:59.000Z')), false);
  assert.equal(pause.isOrderingPaused(new Date('2026-10-16T15:00:00.000Z')), true);
  assert.equal(pause.isOrderingPaused(new Date('2026-10-19T07:00:00.000Z')), true);
  assert.equal(pause.isOrderingPaused(new Date('2026-10-25T23:59:59.000Z')), true);
  assert.equal(pause.isOrderingPaused(new Date('2026-10-26T00:00:00.000Z')), false);
  assert.equal(pause.isNoticeDue(new Date('2026-10-16T10:00:00.000Z')), true);
  assert.equal(pause.isNoticeDue(new Date('2026-10-26T00:00:00.000Z')), false);
});

test('the notice uses the dates and the countdown switches at 4pm UK', async () => {
  const pause = await pauseApi();
  const before = pause.describe(new Date('2026-10-16T09:47:30.000Z'));
  assert.equal(before.paused, false);
  assert.equal(before.title, 'Orders close at 4pm on Friday 16th October');
  assert.equal(before.text, 'Orders are paused from 4pm on Friday 16th October and reopen on Monday 26th October.');
  assert.equal(before.countdownText, 'Orders close in 05:12:30');
  assert.equal(before.text.includes('today'), false);
  assert.equal(before.text.includes('19th'), false);
  assert.equal(before.text.includes('8am'), false);

  const during = pause.describe(new Date('2026-10-16T15:00:00.000Z'));
  assert.equal(during.paused, true);
  assert.equal(during.text, 'Orders are paused until Monday 26th October.');
  assert.equal(during.countdownText, 'Orders reopen in 9d 09:00:00');
  assert.equal(during.checkoutMessage, 'Orders are paused until Monday 26th October');
  assert.equal(pause.formatRemaining(0), '00:00:00');
  assert.equal(pause.formatRemaining(-1000), '00:00:00');
});

test('the database window and the 3pm reminder use the same pause function', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/20261016103000_pause_orders_from_16_oct_2026.sql', import.meta.url),
    'utf8',
  );
  const reminder = await readFile(
    new URL('../supabase/migrations/20261013130000_pay_before_3pm_reminder.sql', import.meta.url),
    'utf8',
  );
  const nav = await readFile(new URL('../public/site-nav.js', import.meta.url), 'utf8');
  assert.match(sql, /2026-10-16 16:00:00/);
  assert.match(sql, /2026-10-26 00:00:00/);
  assert.equal(sql.includes('create or replace function public.place_order'), false);
  assert.match(reminder, /orders_are_paused\(\)/);
  assert.match(nav, /lumina-order-pause-clock/);
  assert.match(nav, /pauseConfig\.describe/);
});
