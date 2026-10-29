SPLITIT: SHARED CONTRACT (every agent gets this; it overrides everything else)

PROJECT
SplitIt is a mobile-first web app that splits a restaurant bill from a receipt photo. Final deliverable is ONE index.html: HTML + CSS + vanilla JS. No frameworks, no build step, no backend, no CDN. The owner is a first-year CS student who knows some C, so code must be readable, commented in plain English, and made of small plain functions. No clever tricks.

GLOBAL RULES
1. Money is ALWAYS integer cents. Never floats for money. Convert only at the UI edge (parseMoneyInput in, formatMoney out).
2. One global namespace: globalThis.SplitIt. No other globals.
3. Text from the user or from a receipt goes into the page with textContent, never innerHTML.
4. Default currency EUR. Finnish receipts already include VAT and nobody tips, so taxCents and tipPercent both default to 0 and are optional.
5. You write ONLY the files you own. Never edit another agent's file. If you need a change from someone, tell the leader and the leader relays it.
6. The contract wins. If you think it's wrong, tell the leader. Don't quietly deviate.

STATE (single source of truth, plain JSON)
  {
    step: "upload",    // "upload" | "items" | "people" | "assign" | "results"
    currency: "EUR",
    items:  [ { id, name, qty, priceCents, assignedTo: [personId, ...] } ],
    people: [ { id, name } ],
    taxCents: 0,
    tipPercent: 0,     // 0-100, decimals allowed
    paymentLink: ""
  }
priceCents is the TOTAL for that line (qty is informational only). Empty assignedTo = unassigned. State is never mutated; engine helpers return a new state.

FLOW (each screen owns its own Back/Next buttons)
  upload -> items -> people -> assign -> results
  upload has no Back. results has Back (to assign) and "Start over".

SHELL API (leader writes shell.js)
  SplitIt.registerScreen(stepName, function (rootEl, ctx) { ... })
  ctx = { state, setState(newState, opts), goTo(step), engine }
  - A screen function fills rootEl and attaches its own listeners. It never touches anything outside rootEl.
  - setState saves to localStorage and re-renders the current screen. Pass { silent: true } to save WITHOUT re-rendering. Use that for typing in text inputs, otherwise inputs lose focus on every keystroke.
  - goTo(step) sets state.step and re-renders.
  - SplitIt.start() boots the app: loadState() or createInitialState(), then renders state.step.

ENGINE API (Agent 1, file engine.js, pure logic, no DOM, no fetch)
  uid(prefix)                                  -> "i_k3j2h1"
  createInitialState()                         -> fresh state
  loadState() / saveState(state) / clearState()   // localStorage key "splitit.v1"; loadState returns null if missing or corrupt
  formatMoney(cents, currency)                 -> localized string via Intl.NumberFormat
  parseMoneyInput(text)                        -> integer cents, or null if invalid ("12.5", "12,50", " 12 " all work)
  addItem(state, {name, qty, priceCents})      -> new state
  updateItem(state, itemId, patch)             -> new state
  removeItem(state, itemId)                    -> new state
  addPerson(state, name)                       -> new state (trim; reject empty)
  removePerson(state, personId)                -> new state (also removes the id from every item's assignedTo)
  toggleAssignment(state, itemId, personId)    -> new state
  computeTotals(state)                         -> see below
  buildSummaryText(state, totals)              -> plain text for a group chat
  selfTest()                                   -> logs PASS/FAIL per check to console

computeTotals returns:
  { subtotalCents, taxCents, tipCents, totalCents,
    unassignedItemIds: [],
    perPerson: [ { personId, name, itemsCents, taxCents, tipCents, totalCents,
                   lines: [ { itemId, name, shareCents } ] } ],
    warnings: [ "human readable string", ... ] }

Rules:
- An item is split evenly between its assigned people. Leftover cents go one each to the first people in people[] order (deterministic).
- tipCents = round(subtotalCents * tipPercent / 100). Tip is on the subtotal, before tax.
- Tax and tip are each distributed across people in proportion to their itemsCents using the largest remainder method (ties broken by people[] order). No cent lost or invented.
- INVARIANT: if every item is assigned, sum(perPerson.totalCents) === totalCents EXACTLY.
- Unassigned items are excluded from perPerson and flagged in warnings.
- Zero people or zero items: return zeros plus a warning. Never throw.

RECEIPT PARSING API (Agent 2, file input.js)
  SplitIt.parseReceipt(imageFile) -> Promise<{ items: [{name, qty, priceCents}], taxCents, currency }>
  Rejects with an Error that has a human-readable message on any failure.

SHARED CSS CLASSES (Agent 3 defines them in styles.css; everyone may use them)
  .screen .title .stack .row .card .btn .btn-primary .btn-ghost .chip .chip.on .input .sticky-bar .warn .muted
  Agent 2 may add its own classes but they must start with ".in-". Agent 3 may add private classes in styles.css prefixed ".ui-" (leader decision). Nobody else adds CSS.
  LEADER DECISIONS: each render gets a fresh ctx; silent setState still updates the shell's state, so goTo builds on the latest state. tipPercent is clamped to 0-100 by the UI. perPerson.lines are in items[] order.

FILES AND MERGE ORDER
  engine.js (A1), shell.js (leader), input.js + input.css (A2), ui.js + styles.css (A3)
  index.html = <style> styles.css + input.css </style>, then <script> engine, shell, input, ui </script>, then SplitIt.start().
  If URL has ?test=1, run SplitIt.engine.selfTest() on load.

GOLDEN TEST (engine must pass this exactly)
  People in order: Aino, Bo, Cleo. tax 0, tip 10%.
  Items: Pizza 1250 -> Aino. Pasta 1190 -> Bo. Salad 900 -> Cleo. Nachos 700 -> all three.
  Expected: Nachos shares 234 / 233 / 233. subtotal 4040, tip 404, total 4444.
  Per person totals: Aino 1633, Bo 1565, Cleo 1246. Sum = 4444.

LEADER DECISIONS (round 1 review)
- shell.js owns the .screen wrapper. Screen functions must NOT add .screen themselves (use .stack inside rootEl).
- Assignment changes go only through engine.toggleAssignment. updateItem does not accept assignedTo.
- parseReceipt with no API key REJECTS with a readable Error (no mock receipt in the shipped build), so manual entry is offered.
- The header (#app > header) is styled by Agent 3 in styles.css.
- Receipt discounts: RECEIPT_PROMPT tells the model to subtract a discount line from the item directly above it. Prices are never negative. Payment, change and VAT-summary lines are ignored.
