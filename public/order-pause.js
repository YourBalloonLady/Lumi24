(function () {
  // Canonical ordering pause. Keep the SQL migration in sync with these instants.
  // Active from 16:00 UK time on Friday 16 October 2026
  // until 00:00 UK time on Monday 26 October 2026.
  // 16 October is still BST (UTC+1). 26 October 00:00 is GMT (UTC+0).
  const timeZone = 'Europe/London';
  const config = {
    timeZone: timeZone,
    orderingStartsAt: { year: 2026, month: 10, day: 16, hour: 16, minute: 0 },
    orderingEndsAt: { year: 2026, month: 10, day: 26, hour: 0, minute: 0 },
    beforeTitle: 'Orders close at 4pm on Friday 16th October',
    beforeText: 'Orders are paused from 4pm on Friday 16th October and reopen on Monday 26th October.',
    duringTitle: 'Orders paused until Monday 26th October',
    duringText: 'Orders are paused until Monday 26th October.',
    checkoutMessage: 'Orders are paused until Monday 26th October'
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

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function formatRemaining(milliseconds) {
    const total = Math.max(0, Math.floor(milliseconds / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const clock = pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
    return days > 0 ? days + 'd ' + clock : clock;
  }

  const orderingStartsAtMs = zonedWallTimeToUtc(config.orderingStartsAt);
  const orderingEndsAtMs = zonedWallTimeToUtc(config.orderingEndsAt);

  function instantOf(now) {
    return now instanceof Date ? now : new Date(now || Date.now());
  }

  function isOrderingPaused(now) {
    const time = instantOf(now).getTime();
    return time >= orderingStartsAtMs && time < orderingEndsAtMs;
  }

  function isNoticeDue(now) {
    return instantOf(now).getTime() < orderingEndsAtMs;
  }

  function describe(now) {
    const time = instantOf(now).getTime();
    const paused = time >= orderingStartsAtMs && time < orderingEndsAtMs;
    const upcoming = time < orderingStartsAtMs;
    const countdown = formatRemaining((paused ? orderingEndsAtMs : orderingStartsAtMs) - time);
    const countdownLabel = paused ? 'Orders reopen in' : 'Orders close in';
    return {
      visible: time < orderingEndsAtMs,
      paused: paused,
      upcoming: upcoming,
      title: paused ? config.duringTitle : config.beforeTitle,
      text: paused ? config.duringText : config.beforeText,
      countdownLabel: countdownLabel,
      countdown: countdown,
      countdownText: countdownLabel + ' ' + countdown,
      checkoutMessage: config.checkoutMessage
    };
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
      note.id = control.id ? control.id + '-pause-note' : 'order-pause-note-' + noteSerial;
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

  function paintBanner(banner, state) {
    const text = banner.querySelector('.lumina-order-pause-banner-text');
    if (text) text.textContent = state.countdownText;
  }

  function makeBanner() {
    const banner = document.createElement('div');
    banner.className = 'lumina-order-pause-banner';
    banner.setAttribute('role', 'status');
    const text = document.createElement('div');
    text.className = 'lumina-order-pause-banner-text';
    banner.appendChild(text);
    paintBanner(banner, describe(new Date()));
    return banner;
  }

  function ensureFormBanner(form) {
    const existing = form.querySelector(':scope > .lumina-order-pause-banner');
    if (existing) return existing;
    const banner = makeBanner();
    form.insertAdjacentElement('afterbegin', banner);
    return banner;
  }

  function ensureControlBanner(control) {
    const previous = control.previousElementSibling;
    if (previous && previous.classList.contains('lumina-order-pause-banner')) return previous;
    const banner = makeBanner();
    control.insertAdjacentElement('beforebegin', banner);
    return banner;
  }

  function mountBanners() {
    if (!document.body || !describe(new Date()).visible) return;
    const form = document.getElementById('addressForm');
    if (form) ensureFormBanner(form);
    document.querySelectorAll('button, a').forEach(function (control) {
      if (!isOrderControl(control)) return;
      if (form && form.contains(control)) return;
      ensureControlBanner(control);
    });
  }

  function refreshCountdowns() {
    const state = describe(new Date());
    document.querySelectorAll('.lumina-order-pause-banner').forEach(function (banner) {
      paintBanner(banner, state);
    });
    if (state.paused) apply(document);
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

  const initial = describe(new Date());
  window.LuminaOrderPause = {
    config: config,
    orderingStartsAtMs: orderingStartsAtMs,
    orderingEndsAtMs: orderingEndsAtMs,
    isOrderingPaused: isOrderingPaused,
    isNoticeDue: isNoticeDue,
    describe: describe,
    formatRemaining: formatRemaining,
    noticeText: initial.text,
    checkoutMessage: config.checkoutMessage,
    apply: apply,
    refreshCountdowns: refreshCountdowns
  };

  if (typeof document === 'undefined' || !document.documentElement) return;

  const style = document.createElement('style');
  style.id = 'lumina-order-pause-controls';
  style.textContent = '.lumina-order-pause-note{margin:10px 0 0;padding:8px 12px;border-radius:12px;background:#ecfdf5;color:#14532d;font:700 .92rem/1.4 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}.lumina-order-pause-banner{margin:0 0 12px;padding:8px 12px;border-radius:12px;background:#ecfdf5;color:#14532d;border:1px solid rgba(22,163,74,.18);font:700 .92rem/1.35 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}.lumina-order-pause-banner-text{font-variant-numeric:tabular-nums;letter-spacing:.02em}#addressForm > .lumina-order-pause-banner{margin-bottom:18px}button[data-order-pause-locked="1"],a[data-order-pause-locked="1"]{cursor:not-allowed;opacity:.6}';
  document.head.appendChild(style);

  function boot() {
    if (!document.body || !isNoticeDue()) return;
    mountBanners();
    if (isOrderingPaused()) apply(document);
    const observer = new MutationObserver(function () {
      mountBanners();
      if (isOrderingPaused()) apply(document);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'hidden', 'disabled', 'onclick'] });
    document.addEventListener('click', blockActivation, true);
    document.addEventListener('submit', blockSubmit, true);
    window.setInterval(refreshCountdowns, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
