globalThis.SplitIt = globalThis.SplitIt || {};

/*
  ui.js (Agent 3): the "assign" and "results" screens.

  How it works, in short:
  - The shell calls our screen function with (rootEl, ctx) every time it
    re-renders. We empty rootEl and build the screen again from ctx.state.
  - All logic (splitting, totals, formatting) lives in ctx.engine. This file
    only builds the page and reacts to taps.
  - Text that came from the user (names, items) is always set with
    textContent, never innerHTML.
  - Money is integer cents. We only turn it into a string with
    engine.formatMoney(cents, state.currency) right before showing it.
*/
(function () {
  "use strict";

  var SplitIt = globalThis.SplitIt;

  /* ------------------------------------------------------------------ */
  /* UI-only memory. This is not part of the saved app state; it just    */
  /* remembers things like "which person cards are open" across renders. */
  /* ------------------------------------------------------------------ */
  var expandedPersonIds = {};   // personId -> true when that card is open
  var customTipOpen = false;    // true after the user taps the "Custom" tip chip

  var PRESET_TIPS = [0, 5, 10, 15];

  /* ------------------------------------------------------------------ */
  /* Small DOM helpers                                                   */
  /* ------------------------------------------------------------------ */

  // Create an element with an optional class name and optional text.
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // Create a <button type="button"> that calls onClick when tapped.
  function button(className, text, onClick) {
    var b = el("button", className, text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  // Remove everything inside a node.
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // A line with a label on the left and an amount on the right.
  function spreadLine(leftText, rightText, className) {
    var line = el("div", "ui-spread" + (className ? " " + className : ""));
    line.appendChild(el("span", "", leftText));
    line.appendChild(el("span", "ui-amount", rightText));
    return line;
  }

  /* ================================================================== */
  /* ASSIGN SCREEN                                                       */
  /* ================================================================== */

  function renderAssign(rootEl, ctx) {
    var state = ctx.state;
    clear(rootEl);

    // The shell already wraps us in <main class="screen">, so we use .stack.
    var screen = el("div", "stack");
    screen.appendChild(el("h1", "title", "Who had what?"));

    if (state.people.length === 0) {
      screen.appendChild(el("p", "muted warn ui-warning", "Add some people first."));
    }
    if (state.items.length === 0) {
      screen.appendChild(el("p", "muted", "No items on the bill yet."));
    }

    var list = el("div", "stack");
    for (var i = 0; i < state.items.length; i++) {
      list.appendChild(buildItemCard(state.items[i], state, ctx));
    }
    screen.appendChild(list);

    screen.appendChild(buildAssignBar(state, ctx));
    rootEl.appendChild(screen);
  }

  // One card per item: name, price, a chip per person, an "Everyone" chip,
  // and a "split N ways" note when 2+ people share it.
  function buildItemCard(item, state, ctx) {
    var engine = ctx.engine;
    var isUnassigned = item.assignedTo.length === 0;
    var card = el("div", isUnassigned ? "card warn stack" : "card stack");

    var nameText = item.name;
    if (item.qty && item.qty > 1) nameText = item.qty + " × " + item.name;
    var head = el("div", "ui-spread");
    head.appendChild(el("span", "ui-item-name", nameText));
    head.appendChild(el("span", "ui-amount", engine.formatMoney(item.priceCents, state.currency)));
    card.appendChild(head);

    var chips = el("div", "row");
    for (var p = 0; p < state.people.length; p++) {
      chips.appendChild(buildPersonChip(item, state.people[p], ctx));
    }
    if (state.people.length > 0) {
      chips.appendChild(buildEveryoneChip(item, state, ctx));
    }
    card.appendChild(chips);

    card.appendChild(el("div", "muted", splitNote(item, state, engine)));
    return card;
  }

  // Chip for one person. Tapping it toggles that person on this item.
  function buildPersonChip(item, person, ctx) {
    var isOn = item.assignedTo.indexOf(person.id) !== -1;
    var chip = button(isOn ? "chip on" : "chip", person.name, function () {
      ctx.setState(ctx.engine.toggleAssignment(ctx.state, item.id, person.id));
    });
    chip.setAttribute("aria-pressed", isOn ? "true" : "false");
    return chip;
  }

  // "Everyone" chip: puts all people on the item. If all are already on it,
  // it clears the item instead. Assignments only change through
  // engine.toggleAssignment, so we toggle exactly the people that need it:
  //   - turning everyone ON:  toggle each person who is currently off
  //   - turning everyone OFF: toggle each person who is currently on
  function buildEveryoneChip(item, state, ctx) {
    var everyoneOn = allPeopleAssigned(item, state.people);
    var chip = button(everyoneOn ? "chip on" : "chip", "Everyone", function () {
      var s = ctx.state;   // fresh for this render (the shell gives a new ctx each time)
      for (var i = 0; i < s.people.length; i++) {
        var personId = s.people[i].id;
        var isOn = item.assignedTo.indexOf(personId) !== -1;
        var needsToggle = everyoneOn ? isOn : !isOn;
        if (needsToggle) s = ctx.engine.toggleAssignment(s, item.id, personId);
      }
      ctx.setState(s);
    });
    chip.setAttribute("aria-pressed", everyoneOn ? "true" : "false");
    return chip;
  }

  function allPeopleAssigned(item, people) {
    if (people.length === 0) return false;
    for (var i = 0; i < people.length; i++) {
      if (item.assignedTo.indexOf(people[i].id) === -1) return false;
    }
    return true;
  }

  // Text under the chips: "Not assigned yet", "Aino pays", or
  // "split 3 ways: about 2,33 € each".
  function splitNote(item, state, engine) {
    var n = item.assignedTo.length;
    if (n === 0) return "Not assigned yet: tap who had it.";
    if (n === 1) return "One person pays all of it.";
    var share = Math.floor(item.priceCents / n);           // even share in whole cents
    var hasRemainder = item.priceCents % n !== 0;           // some people pay 1 cent more
    return "split " + n + " ways: " + (hasRemainder ? "about " : "") +
      engine.formatMoney(share, state.currency) + " each";
  }

  // Sticky bottom bar: Back (to people) and Next (to results).
  // Next is always allowed, but tells you how many items have nobody.
  function buildAssignBar(state, ctx) {
    var unassigned = 0;
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].assignedTo.length === 0) unassigned++;
    }
    var bar = el("div", "sticky-bar");
    bar.appendChild(button("btn btn-ghost", "Back", function () { ctx.goTo("people"); }));
    var nextLabel = "Next";
    if (unassigned > 0) nextLabel = "Next (" + unassigned + " unassigned)";
    bar.appendChild(button("btn btn-primary", nextLabel, function () { ctx.goTo("results"); }));
    return bar;
  }

  /* ================================================================== */
  /* RESULTS SCREEN                                                      */
  /* ================================================================== */

  function renderResults(rootEl, ctx) {
    var engine = ctx.engine;
    // "current" holds the latest state. Silent setState calls (typing) do not
    // re-render, so we keep our own copy up to date here.
    var current = { state: ctx.state };
    clear(rootEl);

    var screen = el("div", "stack");   // the shell already adds .screen around us
    screen.appendChild(el("h1", "title", "Who pays what"));

    // Warnings go at the very top. They and the person cards are rebuilt on
    // their own without touching the tip input, so the input keeps focus.
    var warningsArea = el("div", "stack");
    var totalsArea = el("div", "stack");

    function refreshTotals() {
      var totals = engine.computeTotals(current.state);
      buildWarnings(warningsArea, totals);
      buildTotalsArea(totalsArea, current.state, engine, totals);
    }

    // Save a new state without re-rendering, then update the totals by hand.
    function saveSilently(newState) {
      current.state = newState;
      ctx.setState(newState, { silent: true });
      refreshTotals();
    }

    screen.appendChild(warningsArea);
    screen.appendChild(buildTipSection(current, ctx, saveSilently));
    screen.appendChild(totalsArea);
    screen.appendChild(buildPaymentSection(current, ctx, saveSilently));
    screen.appendChild(buildCopySection(current, engine));
    refreshTotals();

    screen.appendChild(buildResultsBar(ctx));
    rootEl.appendChild(screen);
  }

  /* ---------- Tip ---------- */

  // Tip chips 0 / 5 / 10 / 15 / Custom, plus a number input for Custom.
  function buildTipSection(current, ctx, saveSilently) {
    var section = el("div", "card stack");
    section.appendChild(el("div", "ui-label", "Tip"));

    var tip = current.state.tipPercent;
    var isPreset = PRESET_TIPS.indexOf(tip) !== -1;
    var showCustom = customTipOpen || !isPreset;

    var chips = el("div", "row");
    for (var i = 0; i < PRESET_TIPS.length; i++) {
      chips.appendChild(buildTipChip(PRESET_TIPS[i], !showCustom && tip === PRESET_TIPS[i], current, ctx));
    }
    chips.appendChild(button(showCustom ? "chip on" : "chip", "Custom", function () {
      customTipOpen = true;
      ctx.setState(current.state);   // re-render to show the input
    }));
    section.appendChild(chips);

    if (showCustom) {
      section.appendChild(buildCustomTipInput(current, saveSilently));
    }
    return section;
  }

  // Preset chip: sets tipPercent and re-renders (no input to lose focus here).
  // We read current.state (not ctx.state) so silent edits, like a typed
  // payment link, are not thrown away.
  function buildTipChip(percent, isOn, current, ctx) {
    return button(isOn ? "chip on" : "chip", percent + " %", function () {
      customTipOpen = false;
      ctx.setState(copyWith(current.state, { tipPercent: percent }));
    });
  }

  // Custom tip input. While typing we save silently and only redraw the
  // totals, so the input never loses focus.
  function buildCustomTipInput(current, saveSilently) {
    var label = el("label", "stack");
    label.appendChild(el("span", "muted", "Custom tip (%)"));
    var input = el("input", "input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "e.g. 12.5";
    input.value = String(current.state.tipPercent);
    input.addEventListener("input", function () {
      var percent = parsePercent(input.value);
      if (percent === null) return;   // ignore half-typed or bad values
      saveSilently(copyWith(current.state, { tipPercent: percent }));
    });
    label.appendChild(input);
    return label;
  }

  // Turn "12,5" or "12.5" into 12.5. Returns null if not a number in 0..100.
  // Empty input counts as 0.
  function parsePercent(text) {
    var cleaned = String(text).trim().replace(",", ".");
    if (cleaned === "") return 0;
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    var value = Number(cleaned);
    if (value < 0 || value > 100) return null;
    return value;
  }

  // Make a shallow copy of state with some fields changed (state is never mutated).
  function copyWith(state, patch) {
    var copy = {};
    var key;
    for (key in state) if (Object.prototype.hasOwnProperty.call(state, key)) copy[key] = state[key];
    for (key in patch) if (Object.prototype.hasOwnProperty.call(patch, key)) copy[key] = patch[key];
    return copy;
  }

  /* ---------- Warnings (top of screen) ---------- */

  // One warning box per message from computeTotals. Hidden when there are none.
  function buildWarnings(area, totals) {
    clear(area);
    area.hidden = totals.warnings.length === 0;
    for (var w = 0; w < totals.warnings.length; w++) {
      area.appendChild(el("div", "warn ui-warning", totals.warnings[w]));
    }
  }

  /* ---------- Totals: one card per person + bill total ---------- */

  // totals is optional; if missing we compute it here.
  function buildTotalsArea(area, state, engine, totals) {
    clear(area);
    if (!totals) totals = engine.computeTotals(state);

    for (var i = 0; i < totals.perPerson.length; i++) {
      area.appendChild(buildPersonCard(totals.perPerson[i], state, area, engine));
    }

    var grand = el("div", "card stack");
    grand.appendChild(spreadLine("Subtotal", engine.formatMoney(totals.subtotalCents, state.currency), "muted"));
    if (totals.taxCents) grand.appendChild(spreadLine("Tax", engine.formatMoney(totals.taxCents, state.currency), "muted"));
    if (totals.tipCents) grand.appendChild(spreadLine("Tip", engine.formatMoney(totals.tipCents, state.currency), "muted"));
    grand.appendChild(spreadLine("Bill total", engine.formatMoney(totals.totalCents, state.currency), "ui-label"));
    area.appendChild(grand);
  }

  // Person card: name and big total. Tap to open/close the breakdown.
  function buildPersonCard(person, state, area, engine) {
    var isOpen = expandedPersonIds[person.personId] === true;
    var card = el("div", "card");
    card.setAttribute("data-person-id", person.personId);

    var head = el("button", "ui-person-head ui-spread");
    head.type = "button";
    head.setAttribute("aria-expanded", isOpen ? "true" : "false");
    head.appendChild(el("span", "ui-item-name", person.name));
    head.appendChild(el("span", "ui-amount ui-big", engine.formatMoney(person.totalCents, state.currency)));
    head.addEventListener("click", function () {
      expandedPersonIds[person.personId] = !isOpen;
      buildTotalsArea(area, state, engine);   // redraw only the totals
    });
    card.appendChild(head);

    if (isOpen) card.appendChild(buildBreakdown(person, state, engine));
    return card;
  }

  // The opened part of a person card: one line per item share, then tax and tip.
  function buildBreakdown(person, state, engine) {
    var box = el("div", "ui-breakdown stack");
    for (var i = 0; i < person.lines.length; i++) {
      var line = person.lines[i];
      box.appendChild(spreadLine(line.name, engine.formatMoney(line.shareCents, state.currency)));
    }
    box.appendChild(spreadLine("Tax", engine.formatMoney(person.taxCents, state.currency), "muted"));
    box.appendChild(spreadLine("Tip", engine.formatMoney(person.tipCents, state.currency), "muted"));
    return box;
  }

  /* ---------- Payment link ---------- */

  function buildPaymentSection(current, ctx, saveSilently) {
    var label = el("label", "card stack");
    label.appendChild(el("span", "ui-label", "Payment link (optional)"));
    var input = el("input", "input");
    input.type = "url";
    input.placeholder = "https://...";
    input.value = current.state.paymentLink || "";
    input.addEventListener("input", function () {
      // Silent save: no re-render, so typing keeps focus.
      current.state = copyWith(current.state, { paymentLink: input.value });
      ctx.setState(current.state, { silent: true });
    });
    label.appendChild(input);
    return label;
  }

  /* ---------- Copy summary ---------- */

  function buildCopySection(current, engine) {
    var row = el("div", "row");
    var status = el("span", "muted", "");
    status.setAttribute("aria-live", "polite");
    row.appendChild(button("btn btn-primary", "Copy summary", function () {
      var state = current.state;
      var text = engine.buildSummaryText(state, engine.computeTotals(state));
      copyText(text, function (ok) {
        status.textContent = ok ? "Copied" : "Could not copy";
        setTimeout(function () { status.textContent = ""; }, 2000);
      });
    }));
    row.appendChild(status);
    return row;
  }

  // Copy text to the clipboard. Tries the modern API first, then falls back
  // to the old "select a hidden textarea and execCommand('copy')" trick.
  // done(true/false) is called once at the end.
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(copyWithTextarea(text)); }
      );
      return;
    }
    done(copyWithTextarea(text));
  }

  function copyWithTextarea(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  /* ---------- Bottom bar ---------- */

  function buildResultsBar(ctx) {
    var bar = el("div", "sticky-bar");
    bar.appendChild(button("btn btn-ghost", "Back", function () { ctx.goTo("assign"); }));
    bar.appendChild(button("btn btn-ghost", "Start over", function () {
      if (!confirm("Start over? This clears the whole bill.")) return;
      expandedPersonIds = {};
      customTipOpen = false;
      ctx.engine.clearState();
      ctx.setState(ctx.engine.createInitialState(), { silent: true });
      ctx.goTo("upload");
    }));
    return bar;
  }

  /* ------------------------------------------------------------------ */
  /* Register both screens with the shell                                */
  /* ------------------------------------------------------------------ */
  SplitIt.registerScreen("assign", renderAssign);
  SplitIt.registerScreen("results", renderResults);

  /* ------------------------------------------------------------------ */
  /* Offline support: register the service worker (sw.js)                */
  /* ------------------------------------------------------------------ */

  // Browsers only allow service workers on https:// pages, plus localhost
  // for testing. Opening index.html as a file:// skips this, which is fine:
  // the app still works, it just isn't installable or offline-ready.
  function canUseServiceWorker() {
    if (!("serviceWorker" in navigator)) return false;
    if (location.protocol === "https:") return true;
    return location.hostname === "localhost" || location.hostname === "127.0.0.1";
  }

  function registerServiceWorker() {
    if (!canUseServiceWorker()) return;
    // Wait until the page has loaded so the first visit stays fast.
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function (err) {
        console.warn("SplitIt: offline mode unavailable:", err && err.message ? err.message : err);
      });
    });
  }

  registerServiceWorker();
})();
