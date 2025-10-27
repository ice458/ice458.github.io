(function(){
  // Minimal, no-dependency consent banner for EEA with two choices
  // Policy: default consent is already 'denied' via inline snippet before GTM
  // This script restores prior choice or shows a 2-button banner for EEA users.

  var STORAGE_KEY = 'consent.choice'; // 'granted' | 'denied'
  var BANNER_ID = 'consent-banner-eea';
  var STYLE_ID = 'consent-banner-style';

  function restoreConsentIfGranted() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === 'granted' && typeof gtag === 'function') {
        gtag('consent', 'update', {
          ad_storage: 'granted',
          analytics_storage: 'granted',
          ad_user_data: 'granted',
          ad_personalization: 'granted'
        });
      }
    } catch (e) {}
  }

  function ensureStyles(){
    if (document.getElementById(STYLE_ID)) return;
    var css = ''+
    '#'+BANNER_ID+'{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#111;color:#fff;'+
    'box-shadow:0 -2px 12px rgba(0,0,0,.3);padding:16px;display:flex;gap:16px;align-items:center;'+
    'font-family:system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;font-size:14px}'+
    '#'+BANNER_ID+' .consent-text{flex:1;line-height:1.5}'+
    '#'+BANNER_ID+' .consent-actions{display:flex;gap:8px;flex-wrap:wrap}'+
    '#'+BANNER_ID+' button{cursor:pointer;border:0;border-radius:6px;padding:10px 14px;font-weight:600}'+
    '#'+BANNER_ID+' .btn-accept{background:#22c55e;color:#08130a}'+
    '#'+BANNER_ID+' .btn-reject{background:#334155;color:#fff}'+
    '#'+BANNER_ID+' .consent-manage{margin-left:8px;color:#9aa4b2;text-decoration:underline;cursor:pointer}';

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildBanner(){
    if (document.getElementById(BANNER_ID)) return;
    ensureStyles();

    var wrap = document.createElement('div');
    wrap.id = BANNER_ID;
    wrap.setAttribute('role','dialog');
    wrap.setAttribute('aria-live','polite');
    wrap.setAttribute('aria-label','Cookie同意バナー');

    var text = document.createElement('div');
    text.className = 'consent-text';
    text.innerHTML = '本サイトは利便性向上および統計的なアクセス解析のためCookie等を使用します。'+
                     '「同意する」を選ぶと測定に必要な保存が有効になります。';

    var actions = document.createElement('div');
    actions.className = 'consent-actions';

    var acceptBtn = document.createElement('button');
    acceptBtn.className = 'btn-accept';
    acceptBtn.textContent = '同意する';
    acceptBtn.addEventListener('click', function(){
      try { localStorage.setItem(STORAGE_KEY,'granted'); } catch(e) {}
      if (typeof gtag === 'function') {
        gtag('consent','update',{
          ad_storage:'granted',
          analytics_storage:'granted',
          ad_user_data:'granted',
          ad_personalization:'granted'
        });
      }
      hideBanner();
    });

    var rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn-reject';
    rejectBtn.textContent = '拒否する';
    rejectBtn.addEventListener('click', function(){
      try { localStorage.setItem(STORAGE_KEY,'denied'); } catch(e) {}
      hideBanner();
    });

    actions.appendChild(acceptBtn);
    actions.appendChild(rejectBtn);

    wrap.appendChild(text);
    wrap.appendChild(actions);

    document.body.appendChild(wrap);
  }

  function hideBanner(){
    var el = document.getElementById(BANNER_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function showBanner(){
    // Prevent duplicate
    if (document.getElementById(BANNER_ID)) return;
    buildBanner();
  }

  function appendManageLink(){
    // Add a small "Cookie設定" link in footer when possible
    try {
      var footer = document.querySelector('footer, .site-footer');
      if (!footer) return;
      // avoid duplicates
      if (footer.querySelector('.consent-manage')) return;

      var link = document.createElement('a');
      link.href = 'javascript:void(0)';
      link.className = 'consent-manage';
      link.textContent = 'Cookie設定';
      link.addEventListener('click', function(){
        // Reset stored choice and show banner again
        try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
        showBanner();
      });

      // Append next to existing privacy link if present
      var pr = footer.querySelector('a[href$="privacy.html"]');
      if (pr && pr.parentNode && pr.parentNode.appendChild) {
        var sep = document.createTextNode(' | ');
        pr.parentNode.appendChild(sep);
        pr.parentNode.appendChild(link);
      } else {
        footer.appendChild(link);
      }
    } catch(e) {}
  }

  // Expose manual opener for GTM or other scripts
  window.showConsentPreferences = function(){
    try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
    showBanner();
  };

  // Init on DOM ready
  function onReady(){
    restoreConsentIfGranted();
    appendManageLink();

    var choice = null;
    try { choice = localStorage.getItem(STORAGE_KEY); } catch(e){}
    if (!choice) {
      showBanner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
