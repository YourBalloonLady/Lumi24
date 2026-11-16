(function () {
  var OFFER_ENDS_AT = Date.parse('2026-11-27T23:59:59Z');
  var BUNDLES = [
    { name: 'Weight Research Duo', image: '/black-friday/bf-weight-research-duo.png', rrp: 230, price: 189, contents: ['Tirzepatide 40mg Pen', 'Cagrilintide 10mg Pen'] },
    { name: 'Recovery Stack', image: '/black-friday/bf-recovery-stack.png', rrp: 110, price: 89, contents: ['BPC-157 + TB500 10mg Pen', 'GHK-CU 100mg Pen'] },
    { name: 'Focus Trio', image: '/black-friday/bf-focus-trio.png', rrp: 150, price: 119, contents: ['Selank 10mg Pen', 'Semax 10mg Pen', 'Nad+1000mg Pen'] },
    { name: 'Longevity Trio', image: '/black-friday/bf-longevity-trio.png', rrp: 150, price: 119, contents: ['Epithalon 10mg Pen', 'Nad+1000mg Pen', 'SS-31 Pen'] },
    { name: 'Retatrutide Power Duo', image: '/black-friday/bf-retatrutide-power-duo.png', rrp: 250, price: 205, contents: ['Retatrutide 60mg Pen', 'MOTS-C 40mg Pen'] },
    { name: 'Growth Duo', image: '/black-friday/bf-growth-duo.png', rrp: 150, price: 125, contents: ['CJC-1295 (WO/DAC) 5mg + Ipamorelin 5mg Pen', 'Klow Blend 80mg Pen'] },
    { name: 'Tirzepatide 60 Duo', image: '/black-friday/bf-tirzepatide-60-duo.png', rrp: 215, price: 179, contents: ['Tirzepatide 60mg Pen', 'SLU-PP-332 Pen'] }
  ];

  function offerOpen(now) {
    return (typeof now === 'number' ? now : Date.now()) <= OFFER_ENDS_AT;
  }

  function bundleContents(product) {
    var raw = product && product.bundle_contents;
    return Array.isArray(raw) ? raw.filter(function (part) {
      return part && (part.product_id || part.id);
    }) : [];
  }

  function isBundleItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.bundle === true) return true;
    if (bundleContents(item).length > 0) return true;
    return String(item.type || '').toLowerCase() === 'black-friday';
  }

  function priceSummary(items) {
    var rows = (Array.isArray(items) ? items : []).map(function (item) {
      return {
        qty: Math.max(0, Number(item.qty != null ? item.qty : item.quantity) || 0),
        price: Number(item.price || 0),
        bundle: isBundleItem(item)
      };
    });
    var eligible = rows.filter(function (row) { return !row.bundle; });
    var bundles = rows.filter(function (row) { return row.bundle; });
    var eligibleCount = eligible.reduce(function (sum, row) { return sum + row.qty; }, 0);
    var eligibleSubtotal = eligible.reduce(function (sum, row) { return sum + (row.price * row.qty); }, 0);
    var bundleSubtotal = bundles.reduce(function (sum, row) { return sum + (row.price * row.qty); }, 0);
    var discount = eligibleCount >= 3 ? Math.round(eligibleSubtotal * 10) / 100 : 0;
    return {
      itemCount: rows.reduce(function (sum, row) { return sum + row.qty; }, 0),
      eligibleCount: eligibleCount,
      discount: discount,
      baseTotal: eligibleSubtotal + bundleSubtotal,
      finalTotal: eligibleSubtotal - discount + bundleSubtotal
    };
  }

  function imageFor(name) {
    var match = BUNDLES.find(function (bundle) { return bundle.name === name; });
    return match ? match.image : '';
  }

  function hideOffer() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-bf-nav], #black-friday, #black-friday-home').forEach(function (element) {
      element.hidden = true;
    });
    document.querySelectorAll('#lumina-nav-panel a[href$="#black-friday"]').forEach(function (link) {
      link.remove();
    });
  }

  function showNavigation() {
    if (typeof document === 'undefined' || !offerOpen()) return;
    document.querySelectorAll('[data-bf-nav]').forEach(function (element) {
      element.hidden = false;
    });
  }

  function reveal() {
    if (!offerOpen()) {
      hideOffer();
      return false;
    }
    showNavigation();
    return true;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      if (!offerOpen()) hideOffer();
    });
    setInterval(function () {
      if (!offerOpen()) hideOffer();
    }, 30000);
  }

  var api = {
    OFFER_ENDS_AT: OFFER_ENDS_AT,
    BUNDLES: BUNDLES,
    offerOpen: offerOpen,
    bundleContents: bundleContents,
    isBundleItem: isBundleItem,
    priceSummary: priceSummary,
    imageFor: imageFor,
    hideOffer: hideOffer,
    showNavigation: showNavigation,
    reveal: reveal
  };

  if (typeof window !== 'undefined') window.LuminaBlackFriday = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
