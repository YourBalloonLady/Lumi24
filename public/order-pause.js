(function () {
  // Canonical ordering pause. Keep the SQL migration in sync with these instants.
  // Active from 08:00 UK time on Monday 19 October 2026
  // until 00:00 UK time on Monday 26 October 2026.
  const timeZone = 'Europe/London';
  const config = {
    timeZone: timeZone,
    orderingStartsAt: { year: 2026, month: 10, day: 19, hour: 8, minute: 0 },
    orderingEndsAt: { year: 2026, month: 10, day: 26, hour: 0, minute: 0 },
    noticeLastDay: '2026-10-26',
    checkoutMessage: 'Orders are paused until Monday 26th October',
    noticeText: 'Please note: all orders will be paused for one week from 8am on Monday 19th October. Ordering will reopen on Monday 26th October. Thank you for your patience!'
  };

  function zonedWallTimeToUtc(parts) {
    const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(new Date(utcGuess));
    const value = type => Number(formatted.find(part => part.type === type).value);
    const zonedAsUtc = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second')
    );
    return utcGuess - (zonedAsUtc - utcGuess);
  }

  const orderingStartsAtMs = zonedWallTimeToUtc(config.orderingStartsAt);
  const orderingEndsAtMs = zonedWallTimeToUtc(config.orderingEndsAt);

  function isOrderingPaused(now) {
    const instant = now instanceof Date ? now : new Date(now || Date.now());
    const time = instant.getTime();
    return time >= orderingStartsAtMs && time < orderingEndsAtMs;
  }

  function londonCalendarDate(now) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now instanceof Date ? now : new Date(now));
    const value = type => parts.find(part => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  function isNoticeDue(now) {
    return londonCalendarDate(now || new Date()) <= config.noticeLastDay;
  }

  function isOrderControl(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.id === 'stripe-payment-link' || element.id === 'checkout-button') return true;
    if (element.matches('#addressForm button[type="submit"]')) return true;
    const onclick = element.getAttribute('onclick') || '';
    if (onclick.includes('goToCheckout')) return true;
    const label = (element.textContent || '').replace(/\s+/g, ' ').trim();
    return label === 'Proceed to Checkout'
      || label === 'Continue to checkout'
      || label.startsWith('Confirm order')
      || label.includes('secure card payment');
  }

  function ensureNote(control) {
    const next = control.nextElementSibling;
    if (next && next.classList.contains('lumina-order-pause-note')) return next;
    const note = document.createElement('p');
    note.className = 'lumina-order-pause-note';
    note.textContent = config.checkoutMessage;
    control.insertAdjacentElement('afterend', note);
    return note;
  }

  let applying = false;
  let noteSerial = 0;

  function lockControl(control) {
    if (!isOrderControl(control)) return;
    if (control.tagName === 'BUTTON') {
      if (!control.disabled) control.disabled = true;
    } else if (control.getAttribute('href') !== '#orders-paused') {
      control.setAttribute('href', '#orders-paused');
      control.setAttribute('tabindex', '-1');
    }
    if (control.getAttribute('aria-disabled') !== 'true') control.setAttribute('aria-disabled', 'true');
    if (!control.getAttribute('title')) control.setAttribute('title', config.checkoutMessage);
    control.dataset.orderPauseLocked = '1';
    const note = ensureNote(control);
    if (!note.id) {
      noteSerial += 1;
      note.id = control.id ? `${control.id}-pause-note` : `order-pause-note-${noteSerial}`;
    }
    if (control.getAttribute('aria-describedby') !== note.id) {
      control.setAttribute('aria-describedby', note.id);
    }
  }

  function apply(root) {
    if (applying || !isOrderingPaused()) return;
    applying = true;
    try {
      const scope = root && root.querySelectorAll ? root : document;
      scope.querySelectorAll('button, a').forEach(lockControl);
    } finally {
      applying = false;
    }
  }

  function blockActivation(event) {
    if (!isOrderingPaused()) return;
    const control = event.target && event.target.closest
      ? event.target.closest('button, a')
      : null;
    if (!isOrderControl(control)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    lockControl(control);
  }

  function blockSubmit(event) {
    if (!isOrderingPaused()) return;
    const form = event.target;
    if (!form || form.id !== 'addressForm') return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const button = form.querySelector('button[type="submit"]');
    if (button) lockControl(button);
    const status = document.getElementById('checkout-status');
    if (status) {
      status.textContent = config.checkoutMessage;
      status.className = 'small text-danger mt-2';
    }
  }

  window.LuminaOrderPause = {
    config: config,
    orderingStartsAtMs: orderingStartsAtMs,
    orderingEndsAtMs: orderingEndsAtMs,
    isOrderingPaused: isOrderingPaused,
    isNoticeDue: isNoticeDue,
    noticeText: config.noticeText,
    checkoutMessage: config.checkoutMessage,
    apply: apply
  };

  if (typeof document === 'undefined' || !document.documentElement) return;

  const style = document.createElement('style');
  style.id = 'lumina-order-pause-controls';
  style.textContent = '.lumina-order-pause-note{margin:10px 0 0;padding:8px 12px;border-radius:12px;background:#ecfdf5;color:#14532d;font:700 .92rem/1.4 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}button[data-order-pause-locked="1"],a[data-order-pause-locked="1"]{cursor:not-allowed;opacity:.6}';
  document.head.appendChild(style);

  function boot() {
    if (!isOrderingPaused() || !document.body) return;
    apply(document);
    const observer = new MutationObserver(function () {
      apply(document);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'hidden', 'disabled', 'onclick'] });
    document.addEventListener('click', blockActivation, true);
    document.addEventListener('submit', blockSubmit, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
