# SplitIt

SplitIt splits a restaurant bill between friends. Take a photo of the receipt
(or type the items in), add the people, tap who had what, and SplitIt shows
what each person owes, with an optional tip. You can then copy a summary to
paste into a group chat. It is one HTML file: plain HTML, CSS and JavaScript,
with no frameworks, no build tools and no server.

## Run it

- Open `index.html` in a browser, or
- serve the folder and open http://localhost:8000:

      python3 -m http.server

The app saves your bill in the browser (localStorage key `splitit.v1`), so a
reload carries on where you were. "Start over" clears it.

## Files and who owns them

| File | Owner | What it does |
|------|-------|--------------|
| `engine.js` | Agent 1 | Pure logic: state helpers, splitting, totals, money formatting, `selfTest()` |
| `shell.js` | Leader | Holds the state, draws the header, shows one screen at a time |
| `input.js`, `input.css` | Agent 2 | Screens: upload (receipt reading), items, people |
| `ui.js`, `styles.css` | Agent 3 | Screens: assign, results; the shared look (CSS classes) |
| `index.html` | built | All of the above glued into one file by `qa/build.sh` |
| `CONTRACT.md` | Leader | The shared rules every file follows; read this first |
| `qa/` | Leader | Build script, browser tests, screenshots |

Edit the source files, not `index.html`, then rebuild:

    sh qa/build.sh

## Money rules (from CONTRACT.md)

- Money is ALWAYS an integer number of cents (12,50 € is `1250`). Never floats.
- Convert only at the edges: `parseMoneyInput` turns typed text into cents,
  `formatMoney` turns cents into text for the screen.
- An item is split evenly; leftover cents go one each to the first people
  in the people list.
- Tip = round(subtotal × tipPercent / 100), on the subtotal before tax.
- Tax and tip are shared in proportion to what each person ate, using the
  largest remainder method, so no cent is lost or invented.
- If every item is assigned, the person totals add up to the bill total
  exactly.

## Tests

- Engine self-test in the browser: open `index.html?test=1` and look at the
  console. Or in a terminal:

      node -e "require('./engine.js'); SplitIt.engine.selfTest()"

- Browser QA suite (needs Node and Google Chrome at `/usr/bin/google-chrome`):

      cd qa
      npm install
      node qa.js

  It prints PASS/FAIL lines, writes `qa/qa-report.txt` and saves screenshots
  in `qa/`. Set `BASE=http://localhost:8000` to test a served copy instead
  of the file. `qa/safety.js` checks that a crashing screen shows a
  "Start over" button.

## Receipt reading (Google Gemini)

Receipt photos are read by Google Gemini, but the page itself never holds a
key. It sends the photo to `/api/parse-receipt`, a small server function
(`netlify/functions/parse-receipt.mjs`) that adds the secret key and the
instructions for Gemini. Opened as a plain file (`file://`), or on a host
with no function, "Read receipt" says "Receipt reading isn't set up yet" and
you type the items by hand.

Where the key goes:

- **On Netlify:** set `GEMINI_API_KEY` under Site configuration >
  Environment variables. Optionally set `GEMINI_MODEL` too (the default is
  `gemini-3.5-flash`).
- **Local dev:** put the key alone in a file called `.gemini_key` in the repo
  root, next to `index.html` (the dev server `qa/dev-server.mjs` reads it from
  there and never prints it). Then run

      FUNCTION=on node qa/dev-server.mjs

  and open http://localhost:8765. You can also set `GEMINI_MODEL` before the
  command. Without `FUNCTION=on` the dev server acts like a plain static
  host with no receipt reader (that is what `npm test` uses).

`.gemini_key` is in `.gitignore`. **Never commit a key**, and never put it in
`index.html` or any other file the browser downloads.
