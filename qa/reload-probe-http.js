// Probe: is saved state lost when the page reloads right after a write?
const { chromium } = require('playwright-core');
const path = require('path');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const delay of [0, 100, 1500]) {
    let lost = 0;
    for (let i = 0; i < 25; i++) {
      const c = await b.newContext(); const p = await c.newPage();
      await p.goto(process.env.U);
      await p.getByRole('button', { name: 'Enter manually' }).click();
      const before = await p.evaluate(() => localStorage.getItem('splitit.v1') !== null);
      if (delay) await p.waitForTimeout(delay);
      await p.reload();
      const after = await p.evaluate(() => localStorage.getItem('splitit.v1') !== null);
      if (before && !after) lost++;
      await c.close();
    }
    console.log(`delay ${delay}ms: state lost on ${lost}/25 reloads`);
  }
  await b.close();
})();
