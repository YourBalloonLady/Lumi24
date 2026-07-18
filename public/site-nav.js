(function () {
  window.dataLayer = window.dataLayer || [];
  window.luminaTrack = window.luminaTrack || function (eventName, detail) {
    const event = { event: eventName, ...(detail || {}) };
    window.dataLayer.push(event);
    window.dispatchEvent(new CustomEvent('lumina:analytics', { detail: event }));
  };

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
        ['product-bundles.html', 'Bundles'],
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
    #lumina-quick-nav.lumina-admin-nav{left:auto;right:18px;bottom:72px}
    #lumina-nav-toggle{display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:12px 17px;background:#111827;color:#fff;font-weight:800;box-shadow:0 12px 34px rgba(15,23,42,.28);cursor:pointer}
    #lumina-nav-toggle:hover{background:#000;transform:translateY(-1px)}
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
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'lumina-quick-nav';
  if (isAdminArea) root.classList.add('lumina-admin-nav');
  const button = document.createElement('button');
  button.id = 'lumina-nav-toggle';
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'lumina-nav-panel');
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
