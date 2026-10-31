/**
 * Headless Edge smoke test for the runtime i18n layer.
 *
 * Prerequisites: Microsoft Edge (or Chrome) installed. No npm dependencies.
 * Run with: npm run test:smoke
 *
 * EDGE_PATH can override the browser executable.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const indexUrl = pathToFileURL(path.join(root, 'index.html')).href;
// Keep the smoke run deterministic and past the fast-forward boot. Without an
// explicit seed the assertions can observe a different history on every run,
// and without an explicit boot the app may still be writing history when the
// first (or the "empty scan") assertion runs.
const appUrl = (() => {
  const u = new URL(indexUrl);
  u.searchParams.set('seed', 'i18n-smoke');
  u.searchParams.set('boot', '30');
  u.searchParams.set('director', '0');
  u.searchParams.set('notour', '1');
  return u.href;
})();
const withLang = lang => {
  const u = new URL(appUrl);
  u.searchParams.set('lang', lang);
  return u.href;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitJson(url, timeoutMs = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { last = e; }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}${last ? ': ' + last.message : ''}`);
}

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', e => { clearTimeout(timer); reject(new Error('CDP websocket error')); }, { once: true });
    });
    this.ws.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id == null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try { this.ws.close(); } catch { }
  }
}

function startBrowser(browser, port, profile) {
  return spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--window-size=1366,900',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    appUrl
  ], { stdio: 'ignore', windowsHide: true });
}

async function main() {
  const browser = findBrowser();
  if (!browser) throw new Error('Edge/Chrome not found; set EDGE_PATH');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kingdoms-i18n-smoke-'));
  const child = startBrowser(browser, port, profile);
  let cdp;
  const failures = [];
  const check = (ok, label, detail = '') => {
    if (ok) console.log(`  OK   ${label}`);
    else { failures.push(label + (detail ? ` :: ${detail}` : '')); console.log(`  FAIL ${label}${detail ? ' :: ' + detail : ''}`); }
  };
  const ev = async expression => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails.exception && res.exceptionDetails.exception.description;
      throw new Error(d || res.exceptionDetails.text || 'evaluate failed');
    }
    return res.result ? res.result.value : undefined;
  };
  const waitFor = async (expression, label, timeoutMs = 20000) => {
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeoutMs) {
      try {
        if (await ev(expression)) return true;
      } catch (e) { lastError = e; }
      await sleep(120);
    }
    throw new Error(`timeout waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
  };
  const waitBoot = () => waitFor("document.readyState==='complete' && !!(window.I18N && typeof sim!=='undefined' && sim) && !sim._booting && sim.tick>0 && document.querySelector('#stats') && document.querySelector('#stats').textContent.length>0", 'app boot', 30000);
  const setLang = async lang => {
    await ev(`I18N.setLang(${JSON.stringify(lang)})`);
    await waitFor(`I18N.lang===${JSON.stringify(lang)}`, `language ${lang}`);
    await sleep(180);
  };
  const nav = async url => {
    await cdp.send('Page.navigate', { url });
    await waitBoot();
    await sleep(180);
  };

  try {
    await waitJson(`http://127.0.0.1:${port}/json/version`);
    let targets = await waitJson(`http://127.0.0.1:${port}/json/list`);
    let page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url)) || targets.find(t => t.type === 'page');
    if (!page) {
      await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' });
      await sleep(300);
      targets = await waitJson(`http://127.0.0.1:${port}/json/list`);
      page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url)) || targets.find(t => t.type === 'page');
    }
    if (!page) throw new Error('no page target');
    cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await nav(appUrl);

    console.log('\nDefault language and core catalog');
    check(await ev("I18N.lang==='en'"), 'fresh profile starts in English');
    check(await ev("document.title==='Kingdoms Simulation'"), 'document title is English', await ev('document.title'));
    check(await ev("I18N.conflicts.length===0"), 'no duplicate translation-key conflicts');
    check(await ev("I18N.scan().length===0"), 'I18N.scan() has no untranslated prose', JSON.stringify(await ev('I18N.scan()')));
    check(await ev("I18N.scan().every(x=>!/Aygkız|Karoğlu|Kühnmann|Turdar|Bozoğlu|Yamanoğlu/.test(x))"), 'scan() filters proper-name false positives');
    const scanProbe = await ev(`(() => {
      const d = document.createElement('div');
      d.id = 'scanProbe';
      d.innerHTML = '<span>untranslated ASCII probe</span><i title="untranslated attr probe"></i>';
      const name = document.createElement('span');
      name.textContent = sim.tribes[0].name;
      d.appendChild(name);
      document.body.appendChild(d);
      const hits = I18N.scan();
      d.remove();
      return { text: hits.includes('untranslated ASCII probe'), attr: hits.includes('untranslated attr probe'), name: hits.includes(sim.tribes[0].name) };
    })()`);
    check(scanProbe.text, 'scan() covers ASCII-only text');
    check(scanProbe.attr, 'scan() covers attributes');
    check(!scanProbe.name, 'scan() does not flag proper names');
    const knownSource = await ev(`(() => {
      const d = document.createElement('span');
      d.textContent = 'Bilim';
      document.body.appendChild(d);
      const hit = I18N.scan().includes('Bilim');
      d.remove();
      return hit;
    })()`);
    check(knownSource, 'scan() catches a catalogued source string that is still rendered verbatim');
    const knownAttr = await ev(`(() => {
      const d = document.createElement('span');
      d.title = 'Bilim';
      document.body.appendChild(d);
      const hit = I18N.scan().includes('Bilim');
      d.remove();
      return hit;
    })()`);
    check(knownAttr, 'scan() catches a catalogued attribute that is still untranslated');
    const knownEvent = await ev(`(() => {
      const d = document.createElement('span');
      d.setAttribute('data-i18n-skip', '');
      d.setAttribute('data-i18n-source', 'Bilim');
      d.textContent = 'Bilim';
      document.body.appendChild(d);
      const hit = I18N.scan().includes('Bilim');
      d.remove();
      return hit;
    })()`);
    check(knownEvent, 'scan() validates data-i18n-source event text');

    console.log('\nRepresentative strings and plural forms');
    const pair = async (source, lang, expected, label) => {
      await setLang(lang);
      const got = await ev(`I18N.translate(${JSON.stringify(source)})`);
      check(got === expected, label, `got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
    };
    await pair('207 kişi · geçen yıl +12 doğum, −10 ölüm · İlkbahar', 'en', '207 people · last year +12 births, −10 deaths · Spring', 'plural stats line (EN)');
    await pair('1 kişi · geçen yıl +1 doğum, −0 ölüm · Sonbahar', 'en', '1 person · last year +1 birth, −0 deaths · Autumn', 'singular stats line (EN)');
    await pair('4 şehir · toprak 157 · Tarih Öncesi (2 buluş)', 'en', '4 cities · land: 157 · Prehistory (2 discoveries)', 'stats wording with land colon (EN)');
    await pair('4 şehir · toprak 157 · Tarih Öncesi (2 buluş)', 'zh', '4 座城市 · 领土：157 · 史前时代（2 项发现）', 'stats wording with land colon (ZH)');
    await pair('savaş kaydı', 'en', 'war record', 'war record singular');
    await pair('2 savaş kaydı', 'en', '2 war records', 'war record plural');
    await pair('soğukkanlı', 'en', 'level-headed', 'removed duplicate dynamic key keeps literal translation');
    await pair('yiyecek topluyor', 'en', 'gathering food', 'removed duplicate dynamic key keeps literal translation');
    await pair('sarayda krallığı yönetiyor', 'en', 'ruling the kingdom from the palace', 'dynamic-only activity phrase');
    await pair('barış şansı (yorgunluğa bağlı) · hazine −15', 'zh', '和平概率（取决于厌战度） · 国库 −15', 'ZH full-width punctuation spacing');
    await pair('diğer', 'en', 'other', 'event-kind fallback');
    await pair("Gununa Kaldvik, Thyrid Fjordal'ı devirerek intikamını aldı", 'en', 'Gununa Kaldvik defeated Thyrid Fjordal and took revenge', 'revenge prose removes Turkish accusative suffix');

    console.log('\nLive UI: English / Chinese / Turkish');
    await setLang('en');
    const statsEn = await ev("document.querySelector('#stats').textContent");
    check(/cities/.test(statsEn) && /land:/.test(statsEn) && !/şehir|toprak|çağ|nüfus/.test(statsEn), 'stats EN has no Turkish labels', statsEn.slice(0, 180));
    const watchEn = await ev("document.getElementById('watchBar').textContent");
    check(/Watch list is empty/.test(watchEn) && !/İzleme|kişinin kartında/.test(watchEn), 'watch bar is translated', watchEn.slice(0, 180));
    const ascii = await ev(`(() => {
      const out = {};
      for (const id of ['techBtn', 'cultBtn', 'histBtn']) out[id] = document.getElementById(id).textContent.trim();
      out.modes = [...document.querySelectorAll('#mapModes button')].map(b => b.textContent.trim());
      out.seedTitle = document.getElementById('seedIn').title;
      out.playTitle = document.getElementById('playBtn').title;
      return out;
    })()`);
    check(ascii.techBtn === '⚙ Science' && ascii.cultBtn === '◈ Culture' && ascii.histBtn === '📜 History', 'ASCII-only toolbar labels translated', JSON.stringify([ascii.techBtn, ascii.cultBtn, ascii.histBtn]));
    check(ascii.modes.join('|') === 'Political|Terrain|Food|Contentment|Relations', 'ASCII-only map-mode labels translated', ascii.modes.join('|'));
    check(ascii.seedTitle === 'Seed: same seed = same history', 'seed title translated', ascii.seedTitle);
    check(ascii.playTitle === 'Pause / play (Space)', 'play title translated', ascii.playTitle);

    const toastInfo = await ev(`(() => {
      const long = 'Long event '.repeat(120);
      const prevNoToast = settings.noToast;
      const prevToastLast = toastLast;
      let info = null;
      try {
        settings.noToast = false;
        toastLast = 0;
        toast(long, 'pol');
        const el = document.querySelector('#toasts .toast:last-child');
        const tx = el && el.querySelector('.tx');
        info = { len: long.length, title: tx && tx.title, text: tx && tx.textContent, clamp: tx && getComputedStyle(tx).webkitLineClamp };
        if (el) el.remove();
      } finally {
        settings.noToast = prevNoToast;
        toastLast = prevToastLast;
      }
      return info;
    })()`);
    check(toastInfo.text === toastInfo.title && toastInfo.title.length === toastInfo.len, 'long toast keeps full text and title', JSON.stringify({ len: toastInfo.len, title: toastInfo.title && toastInfo.title.length, text: toastInfo.text && toastInfo.text.length }));
    check(toastInfo.clamp === '3', 'long toast is clamped to three lines', String(toastInfo.clamp));

    await ev("openLegends('kisi')");
    await sleep(200);
    await ev("lgSetQ('a')");
    await sleep(160);
    const listCount = await ev("document.querySelectorAll('#histBody .lglist .lgitem').length");
    check(listCount > 0, 'history people list rendered', String(listCount));
    await ev("document.querySelector('#histBody .lglist').scrollTop=120");
    const scrollBefore = await ev("document.querySelector('#histBody .lglist').scrollTop");
    const qBefore = await ev("document.querySelector('#lgQ').value");
    await setLang('zh');
    const qAfter = await ev("document.querySelector('#lgQ').value");
    const scrollAfter = await ev("document.querySelector('#histBody .lglist').scrollTop");
    check(qAfter === qBefore, 'history search text survives language switch', `${JSON.stringify(qBefore)} -> ${JSON.stringify(qAfter)}`);
    check(scrollBefore > 0 && Math.abs(scrollAfter - scrollBefore) <= 10, 'history list scroll survives language switch', `${scrollBefore} -> ${scrollAfter}`);
    const histZh = await ev("document.querySelector('#histBody').textContent");
    check(/城市|人|年/.test(histZh) && !/şehir|toprak|olay|savaş|kişi/.test(histZh), 'history ZH has no Turkish labels', histZh.slice(0, 180));
    const histInfoZh = await ev("document.querySelector('#histInfo').textContent");
    check(/年|人|事件|王国/.test(histInfoZh) && !/yıl|kişi|olay|krallık/.test(histInfoZh), 'history header ZH has no Turkish labels', histInfoZh);

    await ev("LG.q='';LG.filt='hepsi';renderLegends()");
    await ev("openLegends('kral',sim.tribes.find(t=>!t._dead).id)");
    await sleep(200);
    const kdZh = await ev("document.querySelector('#lgDetail').textContent");
    check(/座城市/.test(kdZh) && /时代：/.test(kdZh) && !/şehir|çağ|savaş kaydı/.test(kdZh), 'kingdom detail ZH wording', kdZh.slice(0, 220));
    await setLang('en');
    const kdEn = await ev("document.querySelector('#lgDetail').textContent");
    check(/population:/.test(kdEn) && /peak population:/.test(kdEn) && /era:/.test(kdEn) && /cities/.test(kdEn) && !/nüfus|çağ|şehir/.test(kdEn), 'kingdom detail EN wording', kdEn.slice(0, 240));

    await ev("lgTab('olay')");
    await sleep(180);
    const eventCount = await ev("document.querySelectorAll('#histBody .lgul li').length");
    check(eventCount > 0, 'history event list rendered', String(eventCount));
    await setLang('zh');
    const eventsZh = await ev("document.querySelector('#histBody').textContent");
    check(/事件|年/.test(eventsZh) && !/olay|savaş|şehir/.test(eventsZh), 'history events ZH has no Turkish labels', eventsZh.slice(0, 200));
    const zhScan = await ev("I18N.scan()");
    check(zhScan.length === 0, 'I18N.scan() has no untranslated ZH prose', JSON.stringify(zhScan).slice(0, 300));
    await setLang('en');

    console.log('\nResponsive widths');
    for (const width of [1280, 1366, 1440]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(180);
      const overflow = await ev("document.documentElement.scrollWidth - window.innerWidth");
      check(overflow <= 1, 'no horizontal overflow at ' + width + 'px', String(overflow));
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(150);

    await setLang('tr');
    const statsTr = await ev("document.querySelector('#stats').textContent");
    check(/şehir/.test(statsTr) && /toprak/.test(statsTr), 'Turkish mode keeps source labels', statsTr.slice(0, 160));
    await setLang('en');
    await ev("document.getElementById('histOverlay').style.display='none'");

    console.log('\nLanguage menu keyboard and Escape behaviour');
    await ev("document.querySelector('#langBtn').click()");
    await sleep(80);
    check(await ev("document.querySelector('#langSwitch').classList.contains('open')"), 'menu opens');
    const focusLang = await ev("document.activeElement && document.activeElement.getAttribute('data-lang')");
    check(focusLang === 'en', 'opening menu focuses current language', String(focusLang));
    await ev("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))");
    const focusNext = await ev("document.activeElement && document.activeElement.getAttribute('data-lang')");
    check(focusNext === 'zh', 'ArrowDown moves to next language', String(focusNext));
    await ev("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))");
    const focusPrev = await ev("document.activeElement && document.activeElement.getAttribute('data-lang')");
    check(focusPrev === 'en', 'ArrowUp moves to previous language', String(focusPrev));
    await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await sleep(80);
    check(await ev("!document.querySelector('#langSwitch').classList.contains('open')"), 'Escape closes menu');
    check(await ev("document.activeElement && document.activeElement.id==='langBtn'"), 'Escape restores focus to language button');

    await ev("document.querySelector('#langBtn').click();document.querySelector('#langMenu [data-lang=\"zh\"]').click()");
    await sleep(180);
    check(await ev("I18N.lang==='zh'"), 'menu item switches to Chinese');
    check(await ev("document.activeElement && document.activeElement.id==='langBtn'"), 'choosing a language restores focus to button');
    await setLang('en');

    console.log('\nTour live re-translation');
    await ev("document.getElementById('tourBtn').click()");
    await sleep(180);
    const tourEn = await ev("document.getElementById('tour').innerText");
    check(/every figure is a life/i.test(tourEn), 'tour EN title', tourEn.slice(0, 100));
    await setLang('zh');
    const tourZh = await ev("document.getElementById('tour').innerText");
    check(/每个身影/.test(tourZh) && !/Her figür/.test(tourZh), 'tour ZH re-translates live', tourZh.slice(0, 100));
    await setLang('en');
    const tourScan = await ev('I18N.scan()');
    check(tourScan.length === 0, 'scan() validates visible tour content', JSON.stringify(tourScan));
    await ev("document.getElementById('tour').style.display='none'");

    console.log('\nTwo-stage Escape (language menu first, overlay second)');
    await ev("openLegends('olay');document.getElementById('langBtn').click()");
    await sleep(80);
    await ev("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await sleep(80);
    check(await ev("!document.querySelector('#langSwitch').classList.contains('open')"), 'first Escape closes language menu');
    check(await ev("document.getElementById('histOverlay').style.display==='block'"), 'first Escape leaves history overlay open');
    await ev("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await sleep(120);
    check(await ev("document.getElementById('histOverlay').style.display!=='block'"), 'second Escape closes history overlay');

    console.log('\nIdempotent init and ?lang persistence');
    check(await ev("(I18N.init(), I18N.lang==='en')"), 'I18N.init() is idempotent');
    await ev("localStorage.removeItem('krLang')");
    await nav(withLang('zh'));
    check(await ev("I18N.lang==='zh'"), '?lang=zh activates Chinese');
    check(await ev("localStorage.getItem('krLang')==='zh'"), '?lang=zh is persisted');
    await nav(appUrl);
    check(await ev("I18N.lang==='zh'"), 'saved Chinese survives a plain reload');
    await ev("localStorage.removeItem('krLang')");
    await nav(appUrl);
    check(await ev("I18N.lang==='en'"), 'cleared preference returns to English');

    await nav(withLang('zh'));
    await setLang('en');
    check(await ev("!location.search.includes('lang=')"), 'manual switch clears the ?lang deep link');
    check(await ev("localStorage.getItem('krLang')==='en'"), 'manual switch persists the new choice');
    await nav(appUrl);
    check(await ev("I18N.lang==='en'"), 'cleared deep link reloads the saved choice');

    if (failures.length) {
      console.error(`\n${failures.length} smoke assertion(s) failed:`);
      for (const f of failures) console.error(' - ' + f);
      process.exitCode = 1;
    } else {
      console.log('\nAll i18n smoke checks passed.');
    }
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch { }
    try { cdp && cdp.close(); } catch { }
    try { child.kill(); } catch { }
    await sleep(250);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { }
  }
}

main().catch(err => {
  console.error('smoke test failed:', err && err.stack || err);
  process.exit(1);
});
