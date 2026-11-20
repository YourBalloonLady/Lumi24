import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/site-nav.js', import.meta.url), 'utf8');
const END = Date.parse('2026-11-24T23:59:59Z');

test('the dispatch notice stays up through 23:59 UK on 24 November 2026', () => {
  assert.match(source, /2026-11-24T23:59:59Z/);
  assert.match(source, /Orders will be sent from Tuesday 24 November\. We're sorry for any inconvenience\./);
  assert.equal(END >= Date.parse('2026-11-24T23:59:59Z'), true);
  assert.equal(Date.parse('2026-11-25T00:00:00Z') > END, true);
  assert.equal(Date.parse('2026-11-20T06:50:00Z') <= END, true);
});

test('the notice is a static banner and does not watch the page', () => {
  assert.match(source, /lumina-dispatch-notice/);
  assert.match(source, /clearInterval\(noticeTimer\)/);
  assert.doesNotMatch(source, /MutationObserver/);
  assert.doesNotMatch(source, /orders_are_paused|place_order/);
});
