// Where does the upload error land in the 360x740 viewport (no scrolling)?
const { chromium } = require('playwright-core');
const path = require('path');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 360, height: 740 } })).newPage();
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.locator('.in-file').setInputFiles(path.resolve(__dirname, 'receipt.png'));
  await p.getByRole('button', { name: 'Read receipt' }).click();
  await p.waitForTimeout(500);
  console.log(JSON.stringify(await p.evaluate(() => ({ errTop: Math.round(document.querySelector('.in-error').getBoundingClientRect().top), barTop: Math.round(document.querySelector('.sticky-bar').getBoundingClientRect().top), scrollY }))));
  await p.screenshot({ path: 'upload-error-viewport-light.png' });
  await b.close();
})();
