// QA harness for SplitIt: drives the real index.html in headless Chrome.
const { chromium } = require('playwright-core');
const path = require('path');
const URL = process.env.BASE ? process.env.BASE + '/index.html' : 'file://' + path.resolve(__dirname, '../index.html');
const KEY_URL = process.env.BASE ? process.env.BASE + '/qa/index-with-key.html' : 'file://' + path.resolve(__dirname, 'index-with-key.html');
const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const result = (name, ok, info) => log((ok ? 'PASS ' : 'FAIL ') + name + (info ? ' :: ' + info : ''));

async function newPage(browser, scheme) {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme: scheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.errors = [];
  page.on('console', m => { if (m.type() === 'error') page.errors.push('console.error: ' + m.text()); });
  page.on('pageerror', e => page.errors.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  return page;
}
const step = page => page.evaluate(() => JSON.parse(localStorage.getItem('splitit.v1') || '{}').step);
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('splitit.v1') || 'null'));

async function addItem(page, name, price) {
  await page.getByRole('button', { name: '+ Add item' }).click();
  const n = page.locator('.in-name').last();
  await n.pressSequentially(name);
  const focusedAfterName = await n.evaluate(e => document.activeElement === e);
  const p = page.locator('.in-price').last();
  await p.click(); await p.press('Control+A'); await p.pressSequentially(price);
  const focusedAfterPrice = await p.evaluate(e => document.activeElement === e);
  return focusedAfterName && focusedAfterPrice;
}
async function addPeople(page, names) {
  for (const nm of names) { const i = page.locator('.in-person-input'); await i.fill(nm); await i.press('Enter'); }
}
const card = (page, item) => page.locator('main .card').filter({ has: page.locator('.ui-item-name', { hasText: new RegExp('^(\\d+ × )?' + item + '$') }) });
const chip = (page, item, who) => card(page, item).getByRole('button', { name: who, exact: true });
async function totals(page) {
  return page.locator('.ui-person-head').evaluateAll(hs => hs.map(h => [h.children[0].textContent, h.children[1].textContent.replace(/\u00a0/g, ' ')]));
}
async function layoutAudit(page, label) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const small = [];
    document.querySelectorAll('button, input, select, textarea, label.btn, a').forEach(e => {
      if (e.type === 'file' || e.offsetParent === null) return;
      const b = e.getBoundingClientRect();
      if (b.height < 44 || b.width < 44) small.push(`${e.tagName.toLowerCase()}.${e.className.replace(/ /g, '.')} "${(e.textContent || e.placeholder || '').trim().slice(0, 20)}" ${Math.round(b.width)}x${Math.round(b.height)}`);
    });
    const smallFont = [];
    document.querySelectorAll('input, select, textarea').forEach(e => {
      if (e.type !== 'file' && parseFloat(getComputedStyle(e).fontSize) < 16) smallFont.push(e.className);
    });
    // Content hidden behind sticky bar when scrolled to bottom?
    window.scrollTo(0, doc.scrollHeight);
    const bar = document.querySelector('.sticky-bar');
    let covered = [];
    if (bar) {
      const top = bar.getBoundingClientRect().top;
      document.querySelectorAll('main *').forEach(e => {
        if (bar.contains(e) || e.children.length) return;
        const b = e.getBoundingClientRect();
        if (b.height && b.bottom > top + 1 && b.top < window.innerHeight) covered.push((e.className || e.tagName) + ' "' + e.textContent.trim().slice(0, 20) + '"');
      });
    }
    window.scrollTo(0, 0);
    return { hscroll: doc.scrollWidth > doc.clientWidth, scrollWidth: doc.scrollWidth, small, smallFont, covered, barH: bar ? Math.round(bar.getBoundingClientRect().height) : 0 };
  });
  log(`  layout[${label}] hscroll=${r.hscroll}(${r.scrollWidth}) barH=${r.barH} small=${JSON.stringify(r.small)} fontLt16=${JSON.stringify(r.smallFont)} hiddenUnderBar=${JSON.stringify(r.covered)}`);
  return r;
}
async function contrastAudit(page, label) {
  const r = await page.evaluate(() => {
    function rgb(s) { const m = s.match(/[\d.]+/g).map(Number); return m; }
    function lum(c) { const a = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; }
    function bg(e) { while (e) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length < 4 || c[3] > 0) return c; e = e.parentElement; } return [255, 255, 255]; }
    const worst = {};
    document.querySelectorAll('body *').forEach(e => {
      if (!e.childNodes.length || ![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
      if (e.offsetParent === null && getComputedStyle(e).position !== 'fixed') return;
      const f = rgb(getComputedStyle(e).color), b = bg(e);
      const L1 = lum(f), L2 = lum(b); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const k = e.tagName.toLowerCase() + '.' + e.className;
      if (!(k in worst) || ratio < worst[k]) worst[k] = Math.round(ratio * 10) / 10;
    });
    return Object.entries(worst).filter(([, v]) => v < 4.5);
  });
  log(`  contrast[${label}] below 4.5:1: ${JSON.stringify(r)}`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  // ---------- Globals check ----------
  {
    const page = await newPage(browser, 'light');
    require('fs').writeFileSync(path.resolve(__dirname,'blank.html'),'<!doctype html><html><body></body></html>');
    await page.goto(URL.replace(/index\.html$/, 'qa/blank.html').replace(/^file:.*/, 'file://' + path.resolve(__dirname,'blank.html')));
    const base = await page.evaluate(() => Object.getOwnPropertyNames(window));
    await page.goto(URL);
    const after = await page.evaluate(() => Object.getOwnPropertyNames(window));
    const leaked = after.filter(k => !base.includes(k));
    result('globals: only SplitIt added', leaked.length === 1 && leaked[0] === 'SplitIt', JSON.stringify(leaked));
    const keys = await page.evaluate(() => Object.keys(SplitIt).sort().join(','));
    log('  SplitIt keys: ' + keys);
    await page.context().close();
  }

  // ---------- ?test=1 ----------
  {
    const page = await newPage(browser, 'light');
    const lines = [];
    page.on('console', m => lines.push(m.text()));
    await page.goto(URL + '?test=1');
    await page.waitForTimeout(300);
    log('selfTest output (?test=1):'); lines.forEach(l => log('  ' + l));
    result('selfTest via ?test=1', lines.some(l => /15 passed, 0 failed/.test(l)));
    await page.context().close();
  }

  for (const scheme of ['light', 'dark']) {
    log(`\n===== ${scheme} =====`);
    const page = await newPage(browser, scheme);
    await page.goto(URL);
    await page.evaluate(() => localStorage.clear()); await page.reload();
    await layoutAudit(page, 'upload'); await contrastAudit(page, 'upload');
    const hdr = await page.evaluate(() => { const h = document.querySelector('#app > header'); return Math.round(h.firstChild.getBoundingClientRect().left); });
    result('shell header text is padded from the edge', hdr >= 8, 'left=' + hdr + 'px');
    result('upload: no Back button', await page.getByRole('button', { name: 'Back' }).count() === 0);

    // ---- A: golden test ----
    await page.getByRole('button', { name: 'Enter manually' }).click();
    result('B: manual path shows empty items screen, Next disabled', (await page.locator('.in-empty').count()) === 1 && await page.getByRole('button', { name: 'Next' }).isDisabled());
    let focusOk = true;
    for (const [n, p] of [['Pizza', '12,50'], ['Pasta', '11,90'], ['Salad', '9,00'], ['Nachos', '7,00']]) focusOk = (await addItem(page, n, p)) && focusOk;
    result('items: typing keeps focus (name+price)', focusOk);
    log('  items subtotal: ' + (await page.locator('.in-subtotal').textContent()).replace(/\u00a0/g, ' '));
    await layoutAudit(page, 'items'); await contrastAudit(page, 'items');
    await page.screenshot({ path: `items-${scheme}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Next' }).click();
    await addPeople(page, ['Aino', 'Bo', 'Cleo']);
    await layoutAudit(page, 'people');
    await page.screenshot({ path: `people-${scheme}.png`, fullPage: true });
    // Back/Next data retention: people -> items -> people
    await page.getByRole('button', { name: 'Back' }).click();
    const itemsBack = await page.locator('.in-name').evaluateAll(es => es.map(e => e.value).join(','));
    await page.getByRole('button', { name: 'Next' }).click();
    const peopleBack = await page.locator('.in-chip-name').allTextContents();
    result('nav: people->items->people keeps data', itemsBack === 'Pizza,Pasta,Salad,Nachos' && peopleBack.join(',') === 'Aino,Bo,Cleo', itemsBack + ' | ' + peopleBack);
    await page.getByRole('button', { name: 'Next' }).click();
    result('assign: reached', await step(page) === 'assign');
    log('  assign Next label before: ' + await page.locator('.sticky-bar .btn-primary').textContent());
    await chip(page, 'Pizza', 'Aino').click();
    await chip(page, 'Pasta', 'Bo').click();
    await chip(page, 'Salad', 'Cleo').click();
    await chip(page, 'Nachos', 'Everyone').click();
    const nachosAssigned = (await saved(page)).items.find(i => i.name === 'Nachos').assignedTo.length;
    result('assign: "Everyone" chip assigns all 3 to Nachos', nachosAssigned === 3, 'assignedTo.length=' + nachosAssigned);
    await chip(page, 'Nachos', 'Everyone').click();
    const offCount = (await saved(page)).items.find(i => i.name === 'Nachos').assignedTo.length;
    await chip(page, 'Nachos', 'Everyone').click();
    const onAgain = (await saved(page)).items.find(i => i.name === 'Nachos').assignedTo.length;
    result('assign: Everyone toggles off then on again', offCount === 0 && onAgain === 3, `off=${offCount} on=${onAgain}`);
    log('  Nachos note: ' + (await card(page, 'Nachos').locator('.muted').textContent()).replace(/\u00a0/g, ' '));
    log('  assign Next label after: ' + await page.locator('.sticky-bar .btn-primary').textContent());
    await layoutAudit(page, 'assign'); await contrastAudit(page, 'assign');
    await page.screenshot({ path: `assign-${scheme}.png`, fullPage: true });
    await page.locator('.sticky-bar .btn-primary').click();
    await page.getByRole('button', { name: '10 %' }).click();
    const t = await totals(page);
    const grand = (await page.locator('.ui-spread', { hasText: 'Bill total' }).locator('.ui-amount').textContent()).replace(/\u00a0/g, ' ');
    result('A: golden totals Aino 16,33 / Bo 15,65 / Cleo 12,46, total 44,44', JSON.stringify(t) === JSON.stringify([['Aino', '16,33 €'], ['Bo', '15,65 €'], ['Cleo', '12,46 €']]) && grand === '44,44 €', JSON.stringify(t) + ' total=' + grand);
    // lines order = items order
    await page.locator('.ui-person-head').first().click();
    const ainoLines = await page.locator('.ui-breakdown .ui-spread > span:first-child').allTextContents();
    result('results: Aino lines in items[] order', ainoLines.join(',') === 'Pizza,Nachos,Tax,Tip', ainoLines.join(','));
    // custom tip keeps focus and updates live
    await page.getByRole('button', { name: 'Custom' }).click();
    const ti = page.locator('input[placeholder="e.g. 12.5"]');
    await ti.click(); await ti.press('Control+A'); await ti.pressSequentially('12,5');
    const tipFocus = await ti.evaluate(e => document.activeElement === e);
    const t125 = (await totals(page)).map(x => x[1]).join(' / ');
    result('results: custom tip 12,5 keeps focus, totals live', tipFocus && (await saved(page)).tipPercent === 12.5, t125);
    await page.getByRole('button', { name: '10 %' }).click();
    // payment link silent + survives Back/Next via shell internal state
    const pl = page.locator('input[type=url]');
    await pl.pressSequentially('https://pay.example/x');
    const plFocus = await pl.evaluate(e => document.activeElement === e);
    await page.getByRole('button', { name: 'Back' }).click();
    const backStep = await step(page);
    await page.locator('.sticky-bar .btn-primary').click();
    const plAfter = await page.locator('input[type=url]').inputValue();
    result('results: payment link silent (focus kept) and survives Back->Next', plFocus && backStep === 'assign' && plAfter === 'https://pay.example/x', `focus=${plFocus} back=${backStep} value=${plAfter}`);
    await layoutAudit(page, 'results'); await contrastAudit(page, 'results');
    await page.locator('.ui-person-head').first().click();
    await page.screenshot({ path: `results-${scheme}.png`, fullPage: true });
    // Copy: clipboard rejecting -> textarea fallback; clipboard missing.
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
    await page.getByRole('button', { name: 'Copy summary' }).click();
    await page.waitForTimeout(200);
    log('  copy (writeText rejects): status="' + await page.locator('[aria-live]').textContent() + '"');
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
    await page.getByRole('button', { name: 'Copy summary' }).click();
    await page.waitForTimeout(200);
    log('  copy (no clipboard API): status="' + await page.locator('[aria-live]').textContent() + '"');
    const summary = await page.evaluate(() => SplitIt.engine.buildSummaryText(JSON.parse(localStorage.getItem('splitit.v1'))));
    log('  summary text: ' + JSON.stringify(summary));

    // ---- D: reload mid-flow ----
    await page.reload();
    const d = await saved(page);
    const dTitle = await page.locator('h1.title').textContent();
    result('D: reload resumes on results with data', dTitle === 'Who pays what' && d.items.length === 4 && d.people.length === 3 && (await totals(page)).length === 3, 'title=' + dTitle + ' step=' + (d && d.step) + ' items=' + (d && d.items.length) + ' errors=' + JSON.stringify(page.errors));
    await page.getByRole('button', { name: 'Back' }).click(); await page.reload();
    result('D: reload resumes on assign', (await page.locator('h1.title').textContent()) === 'Who had what?');

    // ---- F: remove a person who had items ----
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Remove Bo' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    const pastaWarn = await card(page, 'Pasta').evaluate(e => e.classList.contains('warn'));
    const nachosNote = (await card(page, 'Nachos').locator('.muted').textContent()).replace(/\u00a0/g, ' ');
    log('  F assign Next label: ' + await page.locator('.sticky-bar .btn-primary').textContent() + ' | nachos: ' + nachosNote);
    await page.locator('.sticky-bar .btn-primary').click();
    const warns = await page.locator('.ui-warning').allTextContents();
    result('F: Pasta unassigned (.warn) and results warning shown', pastaWarn && warns.some(w => /1 item unassigned/.test(w)), JSON.stringify(warns) + ' totals=' + JSON.stringify(await totals(page)));
    await page.screenshot({ path: `results-unassigned-${scheme}.png`, fullPage: true });

    // ---- Start over ----
    await page.getByRole('button', { name: 'Start over' }).click();
    const so = await saved(page);
    result('results: Start over -> upload with fresh state', (await page.locator('h1.title').textContent()) === 'Scan your receipt' && so.items.length === 0 && so.people.length === 0 && so.tipPercent === 0 && so.paymentLink === '');
    log('  errors: ' + JSON.stringify(page.errors));
    await page.context().close();
  }

  // ---- E: one person ----
  {
    const page = await newPage(browser, 'light');
    await page.goto(URL); await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.getByRole('button', { name: 'Enter manually' }).click();
    await addItem(page, 'Soup', '9,90'); await addItem(page, 'Beer', '7,15');
    await page.getByRole('button', { name: 'Next' }).click();
    await addPeople(page, ['Solo']);
    await page.getByRole('button', { name: 'Next' }).click();
    await chip(page, 'Soup', 'Solo').click(); await chip(page, 'Beer', 'Everyone').click();
    await page.locator('.sticky-bar .btn-primary').click();
    await page.getByRole('button', { name: '15 %' }).click();
    const t = await totals(page);
    result('E: one person 17,05 + 15% tip (2,56) = 19,61', t.length === 1 && t[0][1] === '19,61 €', JSON.stringify(t));
    log('  errors: ' + JSON.stringify(page.errors));
    await page.context().close();
  }

  // ---- C: parse fails ----
  for (const [label, url, file, expect] of [
    ['no key + real image', URL, 'receipt.png', /Receipt reading isn't set up yet/],
    ['no key + non-image file', URL, 'notimage.txt', /not an image/],
    ['key set, stub endpoint', KEY_URL, 'receipt.png', /not connected yet/]]) {
    const page = await newPage(browser, 'light');
    await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.locator('.in-file').setInputFiles(path.resolve(__dirname, file));
    await page.getByRole('button', { name: 'Read receipt' }).click();
    await page.waitForFunction(() => document.querySelector('.in-error') && document.querySelector('.in-error').textContent !== '', null, { timeout: 5000 }).catch(() => {});
    const err = await page.locator('.in-error').textContent();
    const errVisible = await page.locator('.in-error').isVisible();
    const manual = await page.getByRole('button', { name: 'Enter manually' }).isEnabled();
    const stillUpload = await step(page);
    result(`C (${label}): error shown + manual entry offered`, expect.test(err) && errVisible && manual, JSON.stringify(err));
    if (label === 'no key + real image') {
      await layoutAudit(page, 'upload+preview+error');
      await page.screenshot({ path: 'upload-error-light.png', fullPage: true });
      await page.getByRole('button', { name: 'Enter manually' }).click();
      result('C: Enter manually after error reaches items', (await page.locator('h1.title').textContent()) === 'Check the items');
    }
    log('  errors: ' + JSON.stringify(page.errors));
    await page.context().close();
  }

  // ---- Second receipt replaces items (parseReceipt stubbed in the page) ----
  {
    const page = await newPage(browser, 'light');
    await page.goto(URL); await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.evaluate(() => {
      const answers = [
        { items: [{ name: 'Soup', qty: 1, priceCents: 990 }, { name: 'Bread', qty: 2, priceCents: 450 }, { name: 'Tea', qty: 1, priceCents: 350 }], taxCents: 0, currency: 'EUR' },
        { items: [{ name: 'Burger', qty: 1, priceCents: 1590 }], taxCents: 0, currency: 'EUR' }];
      let call = 0;
      SplitIt.parseReceipt = () => Promise.resolve(answers[Math.min(call++, 1)]);
    });
    await page.locator('.in-file').setInputFiles(path.resolve(__dirname, 'receipt.png'));
    await page.getByRole('button', { name: 'Read receipt' }).click();
    await page.waitForSelector('.in-items');
    const first = (await saved(page)).items.map(i => i.name).join(',');
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Read receipt' }).click();
    await page.waitForSelector('.in-items');
    const second = (await saved(page)).items.map(i => i.name).join(',');
    const shown = await page.locator('.in-name').evaluateAll(es => es.map(e => e.value).join(','));
    result('upload: second receipt replaces items', first === 'Soup,Bread,Tea' && second === 'Burger' && shown === 'Burger', `first=${first} second=${second} shown=${shown}`);
    // Start over must forget the photo (input.js local memory).
    await page.getByRole('button', { name: 'Next' }).click();
    await addPeople(page, ['Solo']);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.locator('.sticky-bar .btn-primary').click();
    await page.getByRole('button', { name: 'Start over' }).click();
    const fresh = await page.evaluate(() => ({ label: document.querySelector('.in-pick').firstChild.textContent, preview: document.querySelector('.in-preview').hidden, readDisabled: document.querySelector('.in-read').disabled }));
    result('Start over forgets the old photo', fresh.label === 'Take or choose photo' && fresh.preview && fresh.readDisabled, JSON.stringify(fresh));
    log('  errors: ' + JSON.stringify(page.errors));
    await page.context().close();
  }

  // ---- Corrupt localStorage + edge cases ----
  {
    const page = await newPage(browser, 'light');
    await page.goto(URL);
    for (const bad of ['{not json', '{"step":"results","items":"x","people":[]}', '{"step":"nope","items":[],"people":[]}', 'null']) {
      await page.evaluate(b => localStorage.setItem('splitit.v1', b), bad);
      await page.reload();
      result('corrupt storage ' + JSON.stringify(bad) + ' -> upload, no crash', (await page.locator('h1.title').textContent()) === 'Scan your receipt' && page.errors.length === 0);
    }
    // results with no items / no people
    await page.evaluate(() => localStorage.setItem('splitit.v1', JSON.stringify({ step: 'results', items: [], people: [], taxCents: 0, tipPercent: 0, currency: 'EUR', paymentLink: '' })));
    await page.reload(); await page.waitForSelector('.ui-warning');
    log('  results empty warnings: ' + JSON.stringify(await page.locator('.ui-warning').allTextContents()));
    await page.evaluate(() => localStorage.setItem('splitit.v1', JSON.stringify({ step: 'assign', items: [{ id: 'i_1', name: 'X', qty: 1, priceCents: 100, assignedTo: [] }], people: [], taxCents: 0, tipPercent: 0, currency: 'EUR', paymentLink: '' })));
    await page.reload(); await page.waitForSelector('h1.title');
    log('  assign no-people texts: ' + JSON.stringify(await page.locator('main p').allTextContents()));
    // XSS check: names with markup render as text
    await page.evaluate(() => localStorage.setItem('splitit.v1', JSON.stringify({ step: 'results', items: [{ id: 'i_1', name: '<img src=x onerror=window.__x=1>', qty: 1, priceCents: 100, assignedTo: ['p_1'] }], people: [{ id: 'p_1', name: '<b>B</b>' }], taxCents: 0, tipPercent: 0, currency: 'EUR', paymentLink: '' })));
    await page.reload(); await page.locator('.ui-person-head').click();
    result('xss: markup in names is shown as text', await page.evaluate(() => !window.__x && !document.querySelector('main img, main b')));
    log('  errors: ' + JSON.stringify(page.errors));
    await page.context().close();
  }
  await browser.close();
  require('fs').writeFileSync(path.resolve(__dirname, 'qa-report.txt'), out.join('\n') + '\n');
})().catch(e => { console.error(e); process.exit(1); });
