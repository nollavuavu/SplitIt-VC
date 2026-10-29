// Live test: the normal keyless index.html reads real receipt photos through
// our server (/api/parse-receipt), which calls Gemini with the secret key.
// Start the dev server with the reader on, then run this:
//   FUNCTION=on node qa/dev-server.mjs
//   BASE=http://localhost:8765 ONLY=receipt1 node qa/live-gemini.js
// Quota is low: use ONLY=... to read one receipt at a time.
// Never logs request headers or bodies, so the key stays out of the output.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:8765';
const OUT = path.resolve(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

// Receipts to read: qa/receipt-fi.jpg plus every qa/receipts/*.jpg with an .expected.json.
function receiptList() {
  const list = [{ file: path.resolve(__dirname, 'receipt-fi.jpg'), expected: {
    items: [['Margherita pizza', 1, 1450], ['Lohikeitto', 1, 1690], ['Valkosipulileipä', 2, 980], ['Olut 0,5 l', 2, 1500], ['Tiramisu', 1, 850]].map(([name, qty, priceCents]) => ({ name, qty, priceCents })),
    receiptTotalCents: 6470 } }];
  const dir = path.resolve(__dirname, 'receipts');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort()) {
      const exp = path.join(dir, f.replace(/\.jpg$/, '.expected.json'));
      if (!fs.existsSync(exp)) continue;
      const expected = JSON.parse(fs.readFileSync(exp, 'utf8'));
      list.push({ file: path.join(dir, f), expected });
    }
  }
  // ONLY=receipt3 runs just the receipts whose file name contains that text.
  return process.env.ONLY ? list.filter(r => path.basename(r.file).includes(process.env.ONLY)) : list;
}

async function readOne(page, file, net) {
  await page.goto(BASE + '/index.html');
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.locator('.in-file').setInputFiles(file);
  // Quota is low, so try at most twice (TRIES=3 for more).
  const tries = Number(process.env.TRIES || 2);
  for (let attempt = 1; attempt <= tries; attempt++) {
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Read receipt' }).click();
    await Promise.race([
      page.waitForSelector('.in-items', { timeout: 90000 }),
      page.waitForFunction(() => { const e = document.querySelector('.in-error'); return e && e.textContent; }, null, { timeout: 90000 })
    ]).catch(() => {});
    const ms = Date.now() - t0;
    if (await page.locator('.in-items').count()) return { ok: true, ms, attempt };
    const err = await page.locator('.in-error').textContent();
    if (!/busy|too many/i.test(err) || attempt === tries) return { ok: false, ms, attempt, err };
    // Gemini said "busy" (wait 5 s) or "too many requests" (wait 60 s), then try again.
    await page.waitForTimeout(/too many/i.test(err) ? 60000 : 5000);
  }
}

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await (await b.newContext({ viewport: { width: 360, height: 740 } })).newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const net = [];
  // Record the receipt-reader calls (method and status only), and flag any
  // call straight to Gemini: the browser must never make one.
  page.on('response', r => {
    const u = r.url();
    if (u.includes('/api/parse-receipt')) net.push({ method: r.request().method(), status: r.status() });
    if (u.includes('generativelanguage')) net.push({ directGeminiCall: true });
  });
  page.on('requestfailed', r => { if (r.url().includes('/api/parse-receipt')) net.push({ failed: r.failure() && r.failure().errorText }); });

  const summary = [];
  for (const { file, expected } of receiptList()) {
    const name = path.basename(file);
    const r = await readOne(page, file, net);
    console.log(`\n== ${name}: ${r.ok ? 'read OK' : 'FAILED'} in ${r.ms} ms (attempt ${r.attempt})${r.err ? ' :: ' + r.err : ''}`);
    if (!r.ok) { summary.push([name, 'FAIL', r.err]); continue; }
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('splitit.v1')));
    const shown = await page.locator('.in-item').evaluateAll(rs => rs.map(x => [x.querySelector('.in-name').value, x.querySelector('.in-qty').value, x.querySelector('.in-price').value]));
    const got = st.items.map(i => ({ name: i.name, qty: i.qty, priceCents: i.priceCents }));
    const sum = got.reduce((a, i) => a + i.priceCents, 0);
    console.log('  got     :', JSON.stringify(got.map(i => [i.name, i.qty, i.priceCents])), 'tax', st.taxCents, st.currency);
    console.log('  expected:', JSON.stringify(expected.items.map(i => [i.name, i.qty, i.priceCents])));
    console.log('  shown   :', JSON.stringify(shown));
    console.log('  sum', sum, 'receipt total', expected.receiptTotalCents);
    const pricesMatch = JSON.stringify(got.map(i => i.priceCents)) === JSON.stringify(expected.items.map(i => i.priceCents));
    const qtyMatch = JSON.stringify(got.map(i => i.qty)) === JSON.stringify(expected.items.map(i => i.qty));
    const namesMatch = got.every((g, k) => expected.items[k] && g.name.toLowerCase().includes(expected.items[k].name.toLowerCase().split(' ')[0]));
    const shownMatch = shown.every((s, k) => s[0] === got[k].name && Math.round(parseFloat(s[2]) * 100) === got[k].priceCents);
    const next = page.getByRole('button', { name: 'Next' });
    const nextEnabled = !(await next.isDisabled());
    await page.screenshot({ path: path.join(OUT, 'gemini-' + name.replace(/\.jpg$/, '.png')), fullPage: true });
    if (nextEnabled) await next.click();
    const afterNext = await page.locator('h1.title').textContent();
    console.log(`  prices ${pricesMatch} qty ${qtyMatch} names ${namesMatch} uiMatchesState ${shownMatch} sum==total ${sum === expected.receiptTotalCents} tax0 ${st.taxCents === 0} Next->${afterNext}`);
    summary.push([name, pricesMatch && qtyMatch && namesMatch && shownMatch && sum === expected.receiptTotalCents && afterNext === "Who's splitting?" ? 'PASS' : 'MISMATCH']);
  }

  console.log('reader network:', JSON.stringify(net));
  console.log('console errors:', JSON.stringify(errors));
  console.log('SUMMARY', JSON.stringify(summary));
  await b.close();
})();
