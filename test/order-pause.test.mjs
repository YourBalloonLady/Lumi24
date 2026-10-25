import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';

test('the site no longer ships the delivery pause notice or tick box', async () => {
  const files = await readdir(new URL('../public/', import.meta.url));
  assert.equal(files.includes('order-pause.js'), false);
  const checkout = await readFile(new URL('../public/checkout.html', import.meta.url), 'utf8');
  const nav = await readFile(new URL('../public/site-nav.js', import.meta.url), 'utf8');
  const home = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal(checkout.includes('order-pause.js'), false);
  assert.equal(checkout.includes('deliveryRestartAck'), false);
  assert.equal(checkout.includes('delivery_restart_acknowledged'), false);
  assert.equal(checkout.includes('Deliveries paused'), false);
  assert.equal(home.includes('order-pause.js'), false);
  assert.equal(nav.includes('showOrderPauseNotice'), false);
  assert.equal(nav.includes('MutationObserver'), false);
  assert.equal(nav.includes('lumina-order-pause'), false);
});

test('the paste script turns both pause checks off and leaves the column', async () => {
  const sql = await readFile(
    new URL('../supabase/migrations/20261025200000_stop_delivery_restart_ack.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /function public\.orders_are_paused/);
  assert.match(sql, /function public\.delivery_restart_ack_required/);
  assert.equal((sql.match(/select false;/g) || []).length, 2);
  assert.equal(sql.includes('drop column'), false);
  assert.equal(sql.includes('place_order'), true);
  assert.equal(sql.includes('create or replace function public.place_order'), false);
  assert.equal(sql.includes('pay_before_3pm'), false);
  assert.equal(sql.includes('customer_block'), false);
});
