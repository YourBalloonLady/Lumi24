(function () {
  const ANALYTICS_ENDPOINT = 'https://qketnqhfjfxbqiuqevnh.supabase.co/rest/v1/rpc/track_site_event';
  const ANALYTICS_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZXRucWhmamZ4YnFpdXFldm5oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2NjkzMzAsImV4cCI6MjA4MDI0NTMzMH0.JIrgLIwWIA5Gwu9K4BsgS0Y_jyax2G6irqkaf35aPys';

  function newSessionId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
      const random = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
      const value = character === 'x' ? random : (random & 3) | 8;
      return value.toString(16);
    });
  }

  function analyticsSessionId() {
    try {
      const key = 'lumina_analytics_session';
      let id = sessionStorage.getItem(key);
      if (!id) {
        id = newSessionId();
        sessionStorage.setItem(key, id);
      }
      return id;
    } catch (_) {
      return newSessionId();
    }
  }

  function referrerHost() {
    if (!document.referrer) return '';
    try {
      const host = new URL(document.referrer).hostname;
      return host === window.location.hostname ? '' : host.slice(0, 253);
    } catch (_) {
      return '';
    }
  }

  function trafficContext() {
    const key = 'lumina_analytics_attribution';
    try {
      const params = new URLSearchParams(window.location.search);
      const tagged = {
        source: params.get('utm_source') || '',
        medium: params.get('utm_medium') || '',
        campaign: params.get('utm_campaign') || '',
        content: params.get('utm_content') || '',
        term: params.get('utm_term') || ''
      };
      const hasTags = Object.values(tagged).some(Boolean);
      if (hasTags) {
        sessionStorage.setItem(key, JSON.stringify(tagged));
        return tagged;
      }
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (saved && typeof saved === 'object') return saved;
      const source = referrerHost();
      return {
        source: source || 'direct',
        medium: source ? 'referral' : 'direct',
        campaign: '',
        content: '',
        term: ''
      };
    } catch (_) {
      return { source: referrerHost() || 'direct', medium: referrerHost() ? 'referral' : 'direct', campaign: '', content: '', term: '' };
    }
  }

  const analyticsSession = analyticsSessionId();
  const attribution = trafficContext();
  function recordSiteEvent(eventName, detail) {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
    if (/^\/(admin(?:-analytics)?|analytics)\.html$/.test(window.location.pathname)) return;
    fetch(ANALYTICS_ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: ANALYTICS_KEY,
        Authorization: `Bearer ${ANALYTICS_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_session_id: analyticsSession,
        p_event_name: String(eventName || '').slice(0, 64),
        p_page_path: window.location.pathname.slice(0, 300),
        p_referrer_host: referrerHost(),
        p_event_data: {
          ...(detail && typeof detail === 'object' ? detail : {}),
          traffic_source: attribution.source,
          traffic_medium: attribution.medium,
          traffic_campaign: attribution.campaign,
          traffic_content: attribution.content,
          traffic_term: attribution.term
        }
      })
    }).catch(() => {});
  }

  window.dataLayer = window.dataLayer || [];
  window.luminaTrack = window.luminaTrack || function (eventName, detail) {
    const standardEvents = {
      product_view: 'view_item',
      product_detail_view: 'view_item',
      product_group_view: 'view_item_list',
      bundle_view: 'view_item',
      checkout_begin_click: 'begin_checkout',
      checkout_started: 'begin_checkout',
      order_created: 'purchase'
    };
    const event = { event: standardEvents[eventName] || eventName, original_event: eventName, ...(detail || {}) };
    window.dataLayer.push(event);
    window.dispatchEvent(new CustomEvent('lumina:analytics', { detail: event }));
    recordSiteEvent(event.original_event, detail);
  };

  recordSiteEvent('page_view');

  const isAdminPath = /^\/(admin(?:-analytics)?|analytics)(?:\.html)?$/.test(window.location.pathname);
  if (!isAdminPath && !document.getElementById('lumina-site-offer')) {
    const offerStyle = document.createElement('style');
    offerStyle.textContent = '#lumina-site-offer{position:relative;z-index:1100;padding:9px 16px;background:linear-gradient(90deg,#052e16,#15803d);color:#fff;text-align:center;font:800 .86rem/1.35 Inter,system-ui,-apple-system,sans-serif;letter-spacing:.01em}#lumina-site-offer span{color:#bbf7d0}@media(max-width:600px){#lumina-site-offer{padding:9px 12px;font-size:.78rem}}';
    document.head.appendChild(offerStyle);
    const offerBanner = document.createElement('div');
    offerBanner.id = 'lumina-site-offer';
    offerBanner.setAttribute('role', 'status');
    offerBanner.innerHTML = 'Mix & match any 3+ products — <span>save 10% automatically</span>';
    document.body.prepend(offerBanner);
  }

  if (document.getElementById('lumina-quick-nav')) return;

  const page = window.location.pathname.split('/').pop() || 'index.html';
  const adminPages = new Set(['admin.html', 'admin-analytics.html', 'analytics.html']);
  const isAdminArea = adminPages.has(page);
  const links = isAdminArea
    ? [
        ['admin.html', 'Orders'],
        ['admin-analytics.html', 'Admin Analytics'],
        ['analytics.html', 'Sales Analytics'],
        ['products.html', 'Products'],
        ['reviews.html', 'Customer Reviews'],
        ['account.html', 'My Account'],
        ['index.html', 'Store Home']
      ]
    : [
        ['index.html', 'Home'],
        ['products.html', 'Products'],
        ['peptides.html', 'Research Guides'],
        ['calculator.html', 'Calculator'],
        ['reviews.html', 'Reviews'],
        ['faq.html', 'FAQ'],
        ['about.html', 'About Lumina'],
        ['contact.html', 'Contact'],
        ['account.html', 'My Account']
      ];

  const style = document.createElement('style');
  style.textContent = `
    #lumina-quick-nav{position:fixed;left:18px;bottom:18px;z-index:2147483000;font-family:Inter,system-ui,-apple-system,sans-serif}
    #lumina-skip-link{position:fixed;left:12px;top:12px;z-index:2147483647;padding:11px 16px;border-radius:10px;background:#111827;color:#fff!important;font-weight:800;text-decoration:none;transform:translateY(-160%)}
    #lumina-skip-link:focus{transform:translateY(0);outline:3px solid #4ade80;outline-offset:2px}
    #lumina-quick-nav.lumina-admin-nav{left:auto;right:18px;bottom:72px}
    #lumina-nav-toggle{display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:12px 17px;background:#111827;color:#fff;font-weight:800;box-shadow:0 12px 34px rgba(15,23,42,.28);cursor:pointer}
    #lumina-nav-toggle:hover{background:#000;transform:translateY(-1px)}
    #lumina-nav-toggle:focus-visible,#lumina-nav-panel a:focus-visible{outline:3px solid #4ade80;outline-offset:3px}
    #lumina-nav-panel{position:absolute;left:0;bottom:56px;width:min(290px,calc(100vw - 36px));padding:10px;background:#fff;border:1px solid #e5e7eb;border-radius:18px;box-shadow:0 18px 50px rgba(15,23,42,.24)}
    .lumina-admin-nav #lumina-nav-panel{left:auto;right:0}
    #lumina-nav-panel[hidden]{display:none}
    #lumina-nav-panel strong{display:block;padding:8px 10px 10px;color:#111827;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}
    #lumina-nav-panel a{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:11px;color:#1f2937!important;text-decoration:none!important;font-size:.94rem;font-weight:650}
    #lumina-nav-panel a:hover{background:#f3f4f6;color:#000!important}
    #lumina-nav-panel a[aria-current="page"]{background:#111827;color:#fff!important}
    #lumina-nav-panel a span{opacity:.65}
    @media(max-width:600px){#lumina-quick-nav{left:12px;bottom:12px}#lumina-quick-nav.lumina-admin-nav{left:auto;right:12px;bottom:64px}#lumina-nav-toggle{padding:11px 15px}}
    @media print{#lumina-quick-nav{display:none!important}}
    @media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
  `;
  document.head.appendChild(style);

  const main = document.querySelector('main') || document.querySelector('[role="main"]');
  if (main) {
    if (!main.id) main.id = 'main-content';
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    const skip = document.createElement('a');
    skip.id = 'lumina-skip-link';
    skip.href = `#${main.id}`;
    skip.textContent = 'Skip to main content';
    document.body.prepend(skip);
  }

  const root = document.createElement('div');
  root.id = 'lumina-quick-nav';
  if (isAdminArea) root.classList.add('lumina-admin-nav');
  const button = document.createElement('button');
  button.id = 'lumina-nav-toggle';
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'lumina-nav-panel');
  button.setAttribute('aria-label', 'Open site navigation');
  button.innerHTML = '<span aria-hidden="true">☰</span> Menu';

  const panel = document.createElement('nav');
  panel.id = 'lumina-nav-panel';
  panel.setAttribute('aria-label', 'Quick navigation');
  panel.hidden = true;
  const heading = document.createElement('strong');
  heading.textContent = isAdminArea ? 'Admin navigation' : 'Lumina navigation';
  panel.appendChild(heading);

  links.forEach(([href, label]) => {
    const link = document.createElement('a');
    link.href = `/${href}`;
    link.textContent = label;
    if (page === href) link.setAttribute('aria-current', 'page');
    const arrow = document.createElement('span');
    arrow.textContent = '→';
    arrow.setAttribute('aria-hidden', 'true');
    link.appendChild(arrow);
    panel.appendChild(link);
  });

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close site navigation' : 'Open site navigation');
  }

  button.addEventListener('click', () => setOpen(panel.hidden));
  document.addEventListener('click', event => {
    if (!root.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (document.getElementById('lumina-order-pause')) return;
    setOpen(false);
    button.focus();
  });
  document.addEventListener('click', event => {
    const tracked = event.target.closest('[data-track]');
    if (tracked) window.luminaTrack(tracked.dataset.track, { page: page });
  });

  root.append(panel, button);
  document.body.appendChild(root);

  function showOrderPauseNotice() {
    const pauseConfig = window.LuminaOrderPause;
    if (!document.body || document.getElementById('lumina-order-pause') || !pauseConfig) return;
    if (!pauseConfig.isNoticeDue(new Date())) return;

    const storageKey = 'lumina_order_pause_dismissed';
    try {
      if (sessionStorage.getItem(storageKey) === '1') return;
    } catch (_) {}

    const style = document.createElement('style');
    style.id = 'lumina-order-pause-style';
    style.textContent = `
      #lumina-order-pause,#lumina-order-pause *{box-sizing:border-box}
      #lumina-order-pause{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:rgba(15,23,42,.58);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #lumina-order-pause-dialog{width:min(460px,100%);max-height:min(640px,calc(100dvh - 32px));overflow:auto;background:#fff;color:#0f172a;border:1px solid rgba(148,163,184,.22);border-radius:22px;box-shadow:0 24px 60px rgba(15,23,42,.24);outline:none}
      #lumina-order-pause-dialog:focus-visible{outline:3px solid #4ade80;outline-offset:3px}
      .lumina-order-pause-accent{height:6px;background:linear-gradient(90deg,#22c55e,#16a34a)}
      .lumina-order-pause-body{position:relative;padding:22px 24px 24px}
      .lumina-order-pause-logo{display:block;height:46px;width:auto;max-width:calc(100% - 56px);object-fit:contain;object-position:left center}
      .lumina-order-pause-kicker{display:inline-flex;align-items:center;gap:8px;margin:16px 0 0;padding:6px 12px;border-radius:999px;background:rgba(34,197,94,.1);color:#15803d;font-size:.78rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
      .lumina-order-pause-kicker span{width:8px;height:8px;border-radius:50%;background:#22c55e}
      #lumina-order-pause-title{margin:12px 36px 0 0;font-size:1.45rem;line-height:1.2;font-weight:850;letter-spacing:-.03em}
      #lumina-order-pause-text{margin:12px 0 0;color:#1e293b;font-size:1rem;line-height:1.6}
      .lumina-order-pause-close{position:absolute;top:12px;right:12px;display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:1px solid rgba(148,163,184,.45);border-radius:999px;background:#fff;color:#0f172a;font-size:1.6rem;line-height:1;cursor:pointer}
      .lumina-order-pause-close:hover{background:#f3f4f6}
      .lumina-order-pause-confirm{display:block;width:100%;min-height:48px;margin-top:20px;padding:12px 20px;border:0;border-radius:999px;background:#15803d;color:#fff;font:800 1rem/1.2 Inter,system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 12px 24px rgba(21,128,61,.2)}
      .lumina-order-pause-confirm:hover{background:#166534}
      .lumina-order-pause-close:focus-visible,.lumina-order-pause-confirm:focus-visible{outline:3px solid #4ade80;outline-offset:3px}
      @media(max-width:600px){
        #lumina-order-pause-title{font-size:1.28rem}
        .lumina-order-pause-body{padding:18px 16px 18px}
        .lumina-order-pause-logo{height:40px}
      }
      @media(forced-colors:active){
        #lumina-order-pause-dialog{border:2px solid CanvasText}
        .lumina-order-pause-confirm,.lumina-order-pause-close{border:2px solid ButtonText}
      }
      @media print{#lumina-order-pause{display:none!important}}
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'lumina-order-pause';

    const dialog = document.createElement('div');
    dialog.id = 'lumina-order-pause-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'lumina-order-pause-title');
    dialog.setAttribute('aria-describedby', 'lumina-order-pause-text');
    dialog.tabIndex = -1;

    const accent = document.createElement('div');
    accent.className = 'lumina-order-pause-accent';
    accent.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'lumina-order-pause-body';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'lumina-order-pause-close';
    closeButton.setAttribute('aria-label', 'Close order notice');
    const closeGlyph = document.createElement('span');
    closeGlyph.setAttribute('aria-hidden', 'true');
    closeGlyph.textContent = '\u00d7';
    closeButton.appendChild(closeGlyph);

    const logo = document.createElement('img');
    logo.className = 'lumina-order-pause-logo';
    logo.src = '/Lumina-logo.png';
    logo.alt = '';
    logo.width = 92;
    logo.height = 46;

    const kicker = document.createElement('p');
    kicker.className = 'lumina-order-pause-kicker';
    const dot = document.createElement('span');
    dot.setAttribute('aria-hidden', 'true');
    kicker.append(dot, document.createTextNode('Order update'));

    const title = document.createElement('h2');
    title.id = 'lumina-order-pause-title';
    title.textContent = 'Orders paused for one week';

    const text = document.createElement('p');
    text.id = 'lumina-order-pause-text';
    text.textContent = pauseConfig.noticeText;

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'lumina-order-pause-confirm';
    confirmButton.textContent = 'Close';

    body.append(closeButton, logo, kicker, title, text, confirmButton);
    dialog.append(accent, body);
    overlay.appendChild(dialog);

    const previouslyFocused = document.activeElement;
    const scrollY = window.scrollY;
    const previousBodyStyle = {
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      right: document.body.style.right,
      width: document.body.style.width,
      overflow: document.body.style.overflow
    };
    const madeInert = [];
    let closed = false;

    function restorePage() {
      madeInert.forEach(element => element.removeAttribute('inert'));
      document.body.style.position = previousBodyStyle.position;
      document.body.style.top = previousBodyStyle.top;
      document.body.style.left = previousBodyStyle.left;
      document.body.style.right = previousBodyStyle.right;
      document.body.style.width = previousBodyStyle.width;
      document.body.style.overflow = previousBodyStyle.overflow;
      window.scrollTo(0, scrollY);
    }

    function dismiss() {
      if (closed) return;
      closed = true;
      try {
        sessionStorage.setItem(storageKey, '1');
      } catch (_) {}
      document.removeEventListener('keydown', onKeydown, true);
      restorePage();
      overlay.remove();
      if (previouslyFocused && previouslyFocused.isConnected && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true });
      }
    }

    function focusable() {
      return [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.disabled && element.getAttribute('aria-hidden') !== 'true');
    }

    function onKeydown(event) {
      if (!overlay.isConnected) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === dialog || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    closeButton.addEventListener('click', dismiss);
    confirmButton.addEventListener('click', dismiss);
    dialog.addEventListener('click', event => event.stopPropagation());
    overlay.addEventListener('click', dismiss);

    document.body.appendChild(overlay);
    [...document.body.children].forEach(element => {
      if (element === overlay || element.hasAttribute('inert')) return;
      element.setAttribute('inert', '');
      madeInert.push(element);
    });
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeydown, true);
    dialog.focus({ preventScroll: true });
  }

  showOrderPauseNotice();
})();
