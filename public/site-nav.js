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

  const analyticsSession = analyticsSessionId();
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
        p_event_data: detail && typeof detail === 'object' ? detail : {}
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
    if (event.key === 'Escape') {
      setOpen(false);
      button.focus();
    }
  });
  document.addEventListener('click', event => {
    const tracked = event.target.closest('[data-track]');
    if (tracked) window.luminaTrack(tracked.dataset.track, { page: page });
  });

  root.append(panel, button);
  document.body.appendChild(root);
})();
