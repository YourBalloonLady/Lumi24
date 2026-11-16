import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/black-friday.js', import.meta.url), 'utf8');
const context = { module: { exports: {} }, window: {}, document: undefined, setInterval() {}, Date };
vm.createContext(context);
vm.runInContext(source, context);
const bf = context.module.exports;

const sql = fs.readFileSync(
  new URL('../supabase/migrations/20261116170000_black_friday_bundles.sql', import.meta.url),
  'utf8'
);

test('the offer stays open through 23:59:59 UK on 27 November 2026 and then stops', () => {
  assert.equal(bf.offerOpen(Date.parse('2026-11-27T23:59:59Z')), true);
  assert.equal(bf.offerOpen(Date.parse('2026-11-28T00:00:00Z')), false);
  assert.equal(bf.offerOpen(Date.parse('2026-11-16T17:00:00Z')), true);
});

test('bundle lines keep their Black Friday price outside the 10% mix-and-match discount', () => {
  const summary = bf.priceSummary([
    { name: 'Weight Research Duo', price: 189, qty: 1, bundle: true },
    { name: 'Other', price: 10, qty: 1 },
    { name: 'Another', price: 20, qty: 1 },
    { name: 'Third', price: 30, qty: 1 }
  ]);
  assert.equal(summary.eligibleCount, 3);
  assert.equal(summary.discount, 6);
  assert.equal(summary.finalTotal, 243);
});

test('the seven promo prices match the requested savings', () => {
  const deals = [
    ['Weight Research Duo', 230, 189],
    ['Recovery Stack', 110, 89],
    ['Focus Trio', 150, 119],
    ['Longevity Trio', 150, 119],
    ['Retatrutide Power Duo', 250, 205],
    ['Growth Duo', 150, 125],
    ['Tirzepatide 60 Duo', 215, 179]
  ];
  assert.equal(
    String(bf.BUNDLES.map(bundle => bundle.name).join('|')),
    deals.map(deal => deal[0]).join('|')
  );
  for (const [name, rrp, price] of deals) {
    assert.equal(sql.includes(`'${name}'`), true);
    assert.match(sql, new RegExp(`${price}\\.00,\\s*${rrp}\\.00`));
    assert.equal(fs.existsSync(new URL(`../public${bf.imageFor(name)}`, import.meta.url)), true);
  }
});

test('the database script enforces the cutoff without replacing the outer checkout wrapper', () => {
  assert.match(sql, /2026-11-27 23:59:59\+00/);
  assert.match(sql, /create or replace function public\.place_order_before_pause_guard/);
  assert.doesNotMatch(sql, /create or replace function public\.place_order\(/);
  assert.match(sql, /This Black Friday bundle is no longer available/);
  assert.match(sql, /order_stock_demand/);
  assert.match(sql, /An included material in this bundle could not be restocked/);
  assert.doesNotMatch(sql, /customer_block|pay_before_3pm|stripe/i);
});
