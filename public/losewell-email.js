(function () {
  var REDEEM = 'https://losewell.co.uk/redeem';
  var POSTER = 'https://www.lumi24.org/losewell-email-poster.png';
  var HEADLINE = "You don't have to do this alone";
  var BODY = "Your Lumi24 order includes complimentary lifetime access to LoseWell — our companion app built to support you through a healthier way of losing weight, with simple daily guidance to help you stay on track.";
  var INSTRUCTION = "Sign up or sign in with this email address and enter your code to unlock complimentary lifetime access — no card or subscription required.";

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function codeFrom(orderOrCode) {
    if (orderOrCode && typeof orderOrCode === 'object') {
      return String(orderOrCode.details && orderOrCode.details.meta && orderOrCode.details.meta.losewell_code || '').trim();
    }
    return String(orderOrCode || '').trim();
  }

  function sectionText(orderOrCode) {
    var accessCode = codeFrom(orderOrCode);
    if (!accessCode) return '';
    return [
      HEADLINE,
      '',
      BODY,
      '',
      'Personal access code: ' + accessCode,
      'Start your journey here: ' + REDEEM,
      INSTRUCTION,
      POSTER
    ].join('\n');
  }

  function sectionHtml(orderOrCode) {
    var accessCode = codeFrom(orderOrCode);
    if (!accessCode) return '';
    return [
      '<div style="margin-top:28px;padding:20px;border:1px solid #e2e8f0;border-radius:16px;background:#0b1220;color:#ffffff;font-family:Inter,Arial,sans-serif;">',
      '<p style="margin:0 0 8px;font-size:22px;font-weight:800;">' + HEADLINE + '</p>',
      '<p style="margin:0 0 14px;color:#e2e8f0;line-height:1.5;">' + BODY + '</p>',
      '<p style="margin:0 0 8px;">Personal access code: <strong style="letter-spacing:.04em;">' + escapeHtml(accessCode) + '</strong></p>',
      '<p style="margin:0 0 8px;">Start your journey here: <a href="' + REDEEM + '" style="color:#7dd3fc;">' + REDEEM + '</a></p>',
      '<p style="margin:0 0 14px;color:#e2e8f0;">' + INSTRUCTION + '</p>',
      '<img src="' + POSTER + '" alt="Complimentary LoseWell access included with your Lumi24 order" width="560" style="max-width:100%;height:auto;border-radius:12px;">',
      '</div>'
    ].join('');
  }

  function emailParams(orderOrCode) {
    var accessCode = codeFrom(orderOrCode);
    return {
      losewell_code: accessCode,
      losewell_redeem_url: REDEEM,
      losewell_poster_url: POSTER,
      losewell_section_text: sectionText(accessCode),
      losewell_section_html: sectionHtml(accessCode)
    };
  }

  window.LuminaLoseWell = {
    redeemUrl: REDEEM,
    posterUrl: POSTER,
    sectionText: sectionText,
    sectionHtml: sectionHtml,
    emailParams: emailParams
  };
})();
