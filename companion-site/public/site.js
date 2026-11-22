// The landing page.
//
// It explains what the companion is and gets it onto the home screen. The interface itself
// lives at /app/, which is what the manifest's start_url and the home-screen icon open.
// iOS ignores start_url and opens the address the icon was added from, so a standalone
// launch here is forwarded to /app/ instead.

(function site() {
  'use strict';

  const standalone = Boolean(window.navigator.standalone)
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  if (standalone && location.pathname === '/') {
    location.replace(`/app/${location.search}${location.hash}`);
    return;
  }

  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const mobile = ios || android || /Mobi/i.test(ua);

  const installButton = document.getElementById('install-button');
  const installNote = document.getElementById('install-note');
  const openLinks = [
    document.getElementById('top-open'),
    document.getElementById('hero-open'),
  ].filter(Boolean);

  // The PC's Settings card copies a link with ?pc= for PCs that predate the code lookup,
  // and a scanned QR can carry ?code=. Keep both when handing over to the interface.
  const params = new URLSearchParams(location.search);
  const pc = validPc(params.get('pc'));
  const code = (params.get('code') || '').replace(/\D/g, '').slice(0, 6);
  const query = [];
  if (pc) {
    query.push(`pc=${encodeURIComponent(pc)}`);
    // Remembered here as well, so the icon opened from the home screen (which starts at
    // /app/ without a query) still knows the address on an older PC.
    try { localStorage.setItem('rc-companion-pc', pc); } catch (error) { /* private mode */ }
  }
  if (code) query.push(`code=${encodeURIComponent(code)}`);
  if (query.length) {
    for (const link of openLinks) link.href = `/app/?${query.join('&')}`;
  }

  let paired = false;
  try { paired = Boolean(localStorage.getItem('rc-companion-token')); } catch (error) { /* private mode */ }
  const heroOpen = document.getElementById('hero-open');
  if (paired && heroOpen) heroOpen.textContent = 'Open your apps';

  function validPc(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
    try {
      const url = new URL(text);
      if (url.protocol !== 'https:') return '';
      if (!/(^|\.)ts\.net$/i.test(url.hostname)) return '';
      return url.origin;
    } catch (error) {
      return '';
    }
  }

  // ---------------------------------------------------------------- install ---

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    if (installButton) installButton.textContent = 'Install the companion';
    maybeBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideBanner();
    if (installButton) installButton.textContent = 'Installed';
    if (installNote) installNote.textContent = 'Installed. Open RunContainer from your home screen and enter the code from the PC.';
  });

  if (installButton) {
    installButton.addEventListener('click', () => { startInstall(); });
  }

  async function startInstall() {
    if (standalone) {
      location.href = '/app/';
      return;
    }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (error) { /* dismissed */ }
      deferredPrompt = null;
      return;
    }
    openSheet();
  }

  // ---------------------------------------------------------------- banner ---

  const BANNER_KEY = 'rc-site-install-dismissed';
  const banner = document.getElementById('install-banner');
  let bannerDismissed = false;
  try { bannerDismissed = localStorage.getItem(BANNER_KEY) === '1'; } catch (error) { /* private mode */ }

  function maybeBanner() {
    if (!banner || standalone || bannerDismissed || !mobile || !banner.hidden) return;
    banner.hidden = false;
  }

  function hideBanner() {
    if (banner) banner.hidden = true;
  }

  if (mobile && !standalone && !bannerDismissed) {
    setTimeout(maybeBanner, 2200);
  }

  const bannerInstall = document.getElementById('banner-install');
  if (bannerInstall) bannerInstall.addEventListener('click', () => { startInstall(); });

  const bannerClose = document.getElementById('banner-close');
  if (bannerClose) {
    bannerClose.addEventListener('click', () => {
      bannerDismissed = true;
      hideBanner();
      try { localStorage.setItem(BANNER_KEY, '1'); } catch (error) { /* private mode */ }
    });
  }

  // ----------------------------------------------------------------- sheet ---

  const sheet = document.getElementById('install-sheet');
  const sheetBody = document.getElementById('sheet-body');
  const sheetTitle = document.getElementById('sheet-title');

  function openSheet() {
    if (!sheet || !sheetBody) return;
    const steps = [];
    if (ios) {
      if (sheetTitle) sheetTitle.textContent = 'Add RunContainer to your home screen';
      if (/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua)) {
        steps.push('On iPhone, Add to Home Screen only works in <strong>Safari</strong>. Open this page there first.');
      }
      steps.push('Tap the <strong>Share</strong> button in the toolbar — the square with the arrow. On iPad it is at the top.');
      steps.push('Scroll down and choose <strong>Add to Home Screen</strong>.');
      steps.push('Tap <strong>Add</strong>. Then open <strong>RunContainer</strong> from your home screen and enter the code from the PC.');
    } else if (android) {
      if (sheetTitle) sheetTitle.textContent = 'Add RunContainer to your home screen';
      steps.push('Tap the <strong>&#8942;</strong> menu in the top-right of Chrome.');
      steps.push('Choose <strong>Install app</strong> (or <strong>Add to Home screen</strong>).');
      steps.push('Tap <strong>Install</strong>. Then open <strong>RunContainer</strong> from your home screen and enter the code from the PC.');
    } else {
      if (sheetTitle) sheetTitle.textContent = 'Put the companion on your phone';
      steps.push('On an <strong>iPhone</strong>, open this page in Safari and use <strong>Share → Add to Home Screen</strong>.');
      steps.push('On <strong>Android</strong>, open it in Chrome and use <strong>&#8942; → Install app</strong>.');
      steps.push('On a computer, just open the companion — it runs in a browser tab.');
    }
    sheetBody.innerHTML = `<ol>${steps.map((step) => `<li>${step}</li>`).join('')}</ol>`;
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    document.getElementById('sheet-done')?.focus();
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.hidden = true;
    document.body.style.overflow = '';
  }

  if (sheet) {
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) closeSheet();
    });
  }

  document.getElementById('sheet-close')?.addEventListener('click', closeSheet);
  document.getElementById('sheet-done')?.addEventListener('click', closeSheet);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sheet && !sheet.hidden) closeSheet();
  });
}());
