(function () {
  var STRIPE_PAYMENT_URL = 'https://buy.stripe.com/dRm9AL7bO3Yh0IsgBs2880E';

  function forReference(reference) {
    var url = new URL(STRIPE_PAYMENT_URL);
    var clean = String(reference || '').trim().toUpperCase();
    if (/^LW[0-9A-F]{8}$/.test(clean)) {
      url.searchParams.set('client_reference_id', clean);
    }
    return url.toString();
  }

  window.LuminaStripePaymentLink = {
    url: STRIPE_PAYMENT_URL,
    forReference: forReference
  };
})();
