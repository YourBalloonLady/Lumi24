(function () {
  // Deliveries restart at 00:00 UK on Monday 26 October 2026.
  // Ordering and payment stay open. 26 October 00:00 is GMT (UTC+0).
  const timeZone = 'Europe/London';
  const config = {
    timeZone: timeZone,
    deliveriesRestartAt: { year: 2026, month: 10, day: 26, hour: 0, minute: 0 },
    title: 'Deliveries paused until Monday 26th October',
    text: 'Deliveries paused until Monday 26th October. You can still order now and we\'ll dispatch from the 26th.',
    countdownLabel: 'Deliveries restart in',
    acknowledgementLabel: 'I understand that orders placed now will be dispatched when deliveries restart on Monday 26th October.'
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

  const deliveriesRestartAtMs = zonedWallTimeToUtc(config.deliveriesRestartAt);

  function instantOf(now) {
    return now instanceof Date ? now : new Date(now || Date.now());
  }

  function acknowledgementRequired(now) {
    return instantOf(now).getTime() < deliveriesRestartAtMs;
  }

  function isNoticeDue(now) {
    return acknowledgementRequired(now);
  }

  function describe(now) {
    const time = instantOf(now).getTime();
    const required = time < deliveriesRestartAtMs;
    const countdown = formatRemaining(deliveriesRestartAtMs - time);
    return {
      visible: required,
      paused: false,
      acknowledgementRequired: required,
      acknowledgementLabel: config.acknowledgementLabel,
      title: config.title,
      text: config.text,
      countdownLabel: config.countdownLabel,
      countdown: countdown,
      countdownText: config.countdownLabel + ' ' + countdown,
      checkoutMessage: config.text
    };
  }

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function paintBanner(banner, state) {
    setText(banner.querySelector('.lumina-order-pause-banner-text'), state.text);
    setText(banner.querySelector('.lumina-order-pause-banner-clock'), state.countdownText);
    banner.hidden = !state.visible;
  }

  function makeBanner() {
    const banner = document.createElement('div');
    banner.className = 'lumina-order-pause-banner';
    banner.setAttribute('role', 'status');
    const text = document.createElement('div');
    text.className = 'lumina-order-pause-banner-text';
    const clock = document.createElement('div');
    clock.className = 'lumina-order-pause-banner-clock';
    banner.append(text, clock);
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

  function isCheckoutControl(element) {
    if (!element || element.nodeType !== 1) return false;
    const onclick = element.getAttribute('onclick') || '';
    if (onclick.includes('goToCheckout')) return true;
    const label = (element.textContent || '').replace(/\s+/g, ' ').trim();
    return label === 'Proceed to Checkout' || label === 'Continue to checkout';
  }

  function ensureControlBanner(control) {
    const previous = control.previousElementSibling;
    if (previous && previous.classList.contains('lumina-order-pause-banner')) return previous;
    const banner = makeBanner();
    control.insertAdjacentElement('beforebegin', banner);
    return banner;
  }

  function mountBanners() {
    if (!document.body) return;
    const form = document.getElementById('addressForm');
    if (form) ensureFormBanner(form);
    document.querySelectorAll('button, a').forEach(function (control) {
      if (!isCheckoutControl(control)) return;
      if (form && form.contains(control)) return;
      ensureControlBanner(control);
    });
  }

  function syncAcknowledgement(state) {
    const row = document.getElementById('deliveryRestartAckRow');
    const box = document.getElementById('deliveryRestartAck');
    if (!row || !box) return;
    const required = state.acknowledgementRequired;
    row.hidden = !required;
    box.required = required;
    if (!required) box.checked = false;
    const button = document.querySelector('#addressForm button[type="submit"]');
    if (!button || button.dataset.cartInvalid === '1') return;
    if (required && !box.checked) {
      button.disabled = true;
      button.dataset.deliveryAckLock = '1';
    } else if (button.dataset.deliveryAckLock === '1') {
      button.disabled = false;
      delete button.dataset.deliveryAckLock;
    }
  }

  function refreshCountdowns() {
    const state = describe(new Date());
    document.querySelectorAll('.lumina-order-pause-banner').forEach(function (banner) {
      paintBanner(banner, state);
    });
    syncAcknowledgement(state);
  }

  const initial = describe(new Date());
  window.LuminaOrderPause = {
    config: config,
    deliveriesRestartAtMs: deliveriesRestartAtMs,
    orderingEndsAtMs: deliveriesRestartAtMs,
    isOrderingPaused: function () { return false; },
    isNoticeDue: isNoticeDue,
    acknowledgementRequired: acknowledgementRequired,
    describe: describe,
    formatRemaining: formatRemaining,
    noticeText: initial.text,
    checkoutMessage: config.text,
    refreshCountdowns: refreshCountdowns
  };

  if (typeof document === 'undefined' || !document.documentElement) return;

  const style = document.createElement('style');
  style.id = 'lumina-order-pause-controls';
  style.textContent = '.lumina-order-pause-banner{margin:0 0 12px;padding:10px 12px;border-radius:12px;background:#ecfdf5;color:#14532d;border:1px solid rgba(22,163,74,.18);font:700 .92rem/1.4 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center}.lumina-order-pause-banner-clock{margin-top:4px;font-variant-numeric:tabular-nums;letter-spacing:.02em}#addressForm > .lumina-order-pause-banner{margin-bottom:18px}#deliveryRestartAckRow{padding:10px 12px;border-radius:12px;background:#ecfdf5;border:1px solid rgba(22,163,74,.18)}';
  document.head.appendChild(style);

  function boot() {
    if (!document.body) return;
    mountBanners();
    const box = document.getElementById('deliveryRestartAck');
    if (box) box.addEventListener('change', refreshCountdowns);
    refreshCountdowns();
    window.setInterval(refreshCountdowns, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
