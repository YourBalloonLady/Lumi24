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

  // 24 November 2026 is GMT, so 23:59 UK is 23:59:59Z. The notice is
  // information only: it never disables checkout. Text is written once.
  const DISPATCH_NOTICE_ENDS_AT = Date.parse('2026-11-24T23:59:59Z');
  const DISPATCH_NOTICE_TEXT = "Orders will be sent from Tuesday 24 November. We're sorry for any inconvenience.";

  function dispatchNoticeOpen(now) {
    return (typeof now === 'number' ? now : Date.now()) <= DISPATCH_NOTICE_ENDS_AT;
  }

  function removeDispatchNotice() {
    const notice = document.getElementById('lumina-dispatch-notice');
    if (notice) notice.remove();
  }

  if (dispatchNoticeOpen() && !document.getElementById('lumina-dispatch-notice')) {
    const noticeStyle = document.createElement('style');
    noticeStyle.textContent = '#lumina-dispatch-notice{position:relative;z-index:1;margin:0;padding:10px 16px;background:#0b1220;color:#fff;text-align:center;font:600 .92rem/1.45 Inter,system-ui,-apple-system,sans-serif}#lumina-dispatch-notice[hidden]{display:none!important}@media(max-width:600px){#lumina-dispatch-notice{padding:10px 12px;font-size:.84rem}}';
    document.head.appendChild(noticeStyle);
    const notice = document.createElement('p');
    notice.id = 'lumina-dispatch-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = DISPATCH_NOTICE_TEXT;
    const offer = document.getElementById('lumina-site-offer');
    if (offer) offer.insertAdjacentElement('beforebegin', notice);
    else document.body.prepend(notice);
    const noticeTimer = setInterval(() => {
      if (dispatchNoticeOpen()) return;
      clearInterval(noticeTimer);
      removeDispatchNotice();
    }, 30000);
  }

  const BF_MIX_ENDS_AT = Date.parse('2026-11-27T23:59:59Z');

  function bfMixOpen(now) {
    return (typeof now === 'number' ? now : Date.now()) <= BF_MIX_ENDS_AT;
  }

  function bfMixPad(value) {
    return value < 10 ? `0${value}` : String(value);
  }

  function bfMixRemaining(now) {
    const remaining = BF_MIX_ENDS_AT - (typeof now === 'number' ? now : Date.now());
    if (remaining < 0) return 'Ended';
    const total = Math.floor(remaining / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${days}d ${bfMixPad(hours)}:${bfMixPad(minutes)}:${bfMixPad(seconds)}`;
  }

  function removeBfMixBanner() {
    const banner = document.getElementById('lumina-bf-mix');
    if (banner) banner.remove();
    const offer = document.getElementById('lumina-site-offer');
    if (offer) offer.hidden = false;
  }

  if (!isAdminPath && bfMixOpen() && !document.getElementById('lumina-bf-mix')) {
    const offer = document.getElementById('lumina-site-offer');
    if (offer) offer.hidden = true;
    const mixStyle = document.createElement('style');
    mixStyle.textContent = `
      #lumina-bf-mix{position:relative;z-index:1;margin:0;padding:12px;background:#f8fafc}
      #lumina-bf-mix a{display:grid;grid-template-columns:112px minmax(0,1fr) 190px;gap:14px;align-items:center;max-width:1120px;margin:0 auto;padding:14px;border-radius:22px;background:#140b2e;color:#fff;text-decoration:none;box-shadow:0 0 0 3px #ff7a18,0 0 0 6px #ff2f86}
      #lumina-bf-mix .bf-mix-logo{background:#fff;border-radius:16px;min-height:108px;display:flex;align-items:center;justify-content:center;padding:10px}
      #lumina-bf-mix .bf-mix-logo img{width:100%;height:auto;max-height:92px;object-fit:contain}
      #lumina-bf-mix .bf-mix-pills{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      #lumina-bf-mix .bf-pill{display:inline-flex;align-items:center;border-radius:999px;padding:6px 12px;font:800 .72rem/1 Inter,system-ui,sans-serif;letter-spacing:.04em}
      #lumina-bf-mix .bf-pill-hot{background:linear-gradient(90deg,#ff7a18,#ff2f86);color:#fff}
      #lumina-bf-mix .bf-pill-end{background:#241447;color:#fff;border:1px solid rgba(255,255,255,.18);font-variant-numeric:tabular-nums;min-width:18ch}#lumina-bf-mix .bf-count{margin-left:.35em}
      #lumina-bf-mix .bf-off{margin:8px 0 6px;font:900 clamp(2rem,5vw,3.3rem)/.9 Inter,system-ui,sans-serif;letter-spacing:-.03em}
      #lumina-bf-mix .bf-any{display:inline-block;margin:0 0 8px;padding:8px 14px;border-radius:12px;background:linear-gradient(90deg,#ff7a18,#ff3d8a);font:900 .95rem/1 Inter,system-ui,sans-serif;letter-spacing:.04em}
      #lumina-bf-mix .bf-note{margin:0;color:#e2e8f0;font:600 .92rem/1.35 Inter,system-ui,sans-serif}
      #lumina-bf-mix .bf-fine{margin:8px 0 0;color:#cbd5e1;font:700 .62rem/1.3 Inter,system-ui,sans-serif;letter-spacing:.04em}
      #lumina-bf-mix .bf-side{border:2px solid #ff4d8d;border-radius:16px;padding:12px;text-align:center;background:rgba(20,8,48,.55)}
      #lumina-bf-mix .bf-side strong{display:block;font-size:1.05rem}
      #lumina-bf-mix .bf-side span{display:block;margin-top:4px;color:#e2e8f0;font-size:.82rem}
      #lumina-bf-mix .bf-shop{margin-top:10px!important;border-radius:999px;padding:8px 12px;background:linear-gradient(90deg,#ff7a18,#ff2f86);color:#fff!important;font-weight:800}
      @media(max-width:760px){#lumina-bf-mix{padding:8px}#lumina-bf-mix a{grid-template-columns:72px minmax(0,1fr);gap:10px;padding:10px}#lumina-bf-mix .bf-side{grid-column:1 / -1}#lumina-bf-mix .bf-mix-logo{min-height:72px}#lumina-bf-mix .bf-fine{font-size:.58rem}}
      @media(prefers-reduced-motion:reduce){#lumina-bf-mix *{animation:none!important;transition:none!important}}
    `;
    document.head.appendChild(mixStyle);
    const banner = document.createElement('aside');
    banner.id = 'lumina-bf-mix';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Black Friday offer');
    banner.innerHTML = `
      <a href="/products.html">
        <div class="bf-mix-logo"><img src="/Lumina-logo.png" alt="Lumina"></div>
        <div>
          <div class="bf-mix-pills">
            <span class="bf-pill bf-pill-hot">BLACK FRIDAY</span>
            <span class="bf-pill bf-pill-end">ENDS IN <span class="bf-count" data-bf-mix-countdown>--d --:--:--</span></span>
          </div>
          <div class="bf-off">15% OFF</div>
          <div class="bf-any">ANY TWO PRODUCTS</div>
          <p class="bf-note">Pick any two items across the range and save 15% automatically.</p>
          <p class="bf-fine">LUMI24.ORG · VALID UNTIL FRIDAY 27 NOVEMBER 2026 AT MIDNIGHT · FOR RESEARCH USE ONLY</p>
        </div>
        <div class="bf-side">
          <strong>Mix &amp; Match</strong>
          <span>Applied at checkout</span>
          <span class="bf-shop">SHOP LUMI24.ORG</span>
        </div>
      </a>`;
    if (offer) offer.insertAdjacentElement('afterend', banner);
    else document.body.prepend(banner);
    const paintMix = () => {
      const node = document.querySelector('[data-bf-mix-countdown]');
      const text = bfMixRemaining(Date.now());
      if (node && node.textContent !== text) node.textContent = text;
      if (!bfMixOpen()) {
        clearInterval(mixTimer);
        removeBfMixBanner();
      }
    };
    paintMix();
    const mixTimer = setInterval(paintMix, 1000);
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
    .bf-nav-link{box-shadow:inset 0 -2px 0 #c9a227;animation:bf-nav-glow 2.8s ease-in-out infinite}
    @keyframes bf-nav-glow{0%,100%{box-shadow:inset 0 -2px 0 #c9a227}50%{box-shadow:inset 0 -2px 0 #b91c1c}}
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

  const blackFridayEndsAt = Date.parse('2026-11-27T23:59:59Z');
  if (!isAdminArea && Date.now() <= blackFridayEndsAt && !panel.querySelector('a[href="/products.html#black-friday"]')) {
    const link = document.createElement('a');
    link.href = '/products.html#black-friday';
    link.className = 'bf-nav-link';
    link.textContent = 'Black Friday';
    const arrow = document.createElement('span');
    arrow.textContent = '→';
    arrow.setAttribute('aria-hidden', 'true');
    link.appendChild(arrow);
    const productsLink = panel.querySelector('a[href="/products.html"]');
    if (productsLink) productsLink.insertAdjacentElement('afterend', link);
  }

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
    setOpen(false);
    button.focus();
  });
  document.addEventListener('click', event => {
    const tracked = event.target.closest('[data-track]');
    if (tracked) window.luminaTrack(tracked.dataset.track, { page: page });
  });

  root.append(panel, button);
  document.body.appendChild(root);

})();
