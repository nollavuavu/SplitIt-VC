// Checks the shell safety net: a throwing screen shows an error + Start over.
const { chromium } = require('playwright-core');
const path = require('path');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const p = await (await b.newContext({ viewport: { width: 360, height: 740 } })).newPage();
  await p.goto('file://' + path.resolve(__dirname, '../index.html'));
  await p.evaluate(() => { SplitIt.registerScreen('upload', () => { throw new Error('boom'); }); SplitIt.start(); });
  console.log(JSON.stringify(await p.locator('main').innerText()), await p.getByRole('button', { name: 'Start over' }).count());
  await b.close();
})();
