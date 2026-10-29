/*
 * engine.js - SplitIt engine (Agent 1)
 *
 * Pure logic only: no DOM, no fetch, no timers.
 * Everything lives on globalThis.SplitIt.engine, so this file also runs in Node:
 *   node -e "require('./engine.js'); SplitIt.engine.selfTest()"
 *
 * Money rule: every amount is an INTEGER number of cents. We only turn cents
 * into text in formatMoney / formatPlainAmount, and text into cents in
 * parseMoneyInput.
 *
 * State rule: we never change a state object. Every helper builds and
 * returns a new one.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "splitit.v1";
  var STEPS = ["upload", "items", "people", "assign", "results"];
  var uidCounter = 0;

  /* ---------- Small helpers ---------- */

  // Returns true if value is a whole number that is 0 or more.
  function isNonNegativeInt(value) {
    return Number.isInteger(value) && value >= 0;
  }

  // Makes a shallow copy of an item, including a copy of its assignedTo list.
  function copyItem(item) {
    return {
      id: item.id,
      name: item.name,
      qty: item.qty,
      priceCents: item.priceCents,
      assignedTo: item.assignedTo.slice()
    };
  }

  // Makes a new state object with the given fields replaced.
  function withChanges(state, changes) {
    var next = {};
    var key;
    for (key in state) {
      if (Object.prototype.hasOwnProperty.call(state, key)) next[key] = state[key];
    }
    for (key in changes) {
      if (Object.prototype.hasOwnProperty.call(changes, key)) next[key] = changes[key];
    }
    return next;
  }

  // Makes sure tipPercent is a number between 0 and 100. Anything else becomes 0.
  function cleanTipPercent(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    if (n > 100) return 100;
    return n;
  }

  // Returns the localStorage object, or null when there is none (Node, privacy mode).
  function getStorage() {
    try {
      if (typeof localStorage !== "undefined" && localStorage) return localStorage;
    } catch (e) {
      // Some browsers throw just for touching localStorage when it is blocked.
    }
    return null;
  }

  /* ---------- IDs and state ---------- */

  // Makes a short unique id like "i_k3j2h1".
  function uid(prefix) {
    uidCounter = uidCounter + 1;
    var randomPart = Math.random().toString(36).slice(2, 7);
    var counterPart = uidCounter.toString(36);
    return (prefix || "id") + "_" + randomPart + counterPart;
  }

  // Returns a brand new, empty state.
  function createInitialState() {
    return {
      step: "upload",
      currency: "EUR",
      items: [],
      people: [],
      taxCents: 0,
      tipPercent: 0,
      paymentLink: ""
    };
  }

  /* ---------- Storage ---------- */

  // Checks one saved item and returns a clean copy, or null if it is broken.
  function cleanLoadedItem(raw) {
    if (!raw || typeof raw.id !== "string" || !isNonNegativeInt(raw.priceCents)) return null;
    var assigned = Array.isArray(raw.assignedTo) ? raw.assignedTo.filter(function (id) {
      return typeof id === "string";
    }) : [];
    return {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "",
      qty: isNonNegativeInt(raw.qty) ? raw.qty : 1,
      priceCents: raw.priceCents,
      assignedTo: assigned
    };
  }

  // Checks one saved person and returns a clean copy, or null if it is broken.
  function cleanLoadedPerson(raw) {
    if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") return null;
    return { id: raw.id, name: raw.name };
  }

  // Reads the saved state. Returns null if nothing is saved or it is corrupt.
  function loadState() {
    var storage = getStorage();
    if (!storage) return null;
    try {
      var text = storage.getItem(STORAGE_KEY);
      if (!text) return null;
      var raw = JSON.parse(text);
      if (!raw || typeof raw !== "object") return null;
      if (!Array.isArray(raw.items) || !Array.isArray(raw.people)) return null;

      var items = raw.items.map(cleanLoadedItem);
      var people = raw.people.map(cleanLoadedPerson);
      if (items.indexOf(null) !== -1 || people.indexOf(null) !== -1) return null;

      var state = createInitialState();
      state.step = STEPS.indexOf(raw.step) !== -1 ? raw.step : "upload";
      state.currency = typeof raw.currency === "string" && raw.currency ? raw.currency : "EUR";
      state.items = items;
      state.people = people;
      state.taxCents = isNonNegativeInt(raw.taxCents) ? raw.taxCents : 0;
      state.tipPercent = cleanTipPercent(raw.tipPercent);
      state.paymentLink = typeof raw.paymentLink === "string" ? raw.paymentLink : "";
      return state;
    } catch (e) {
      return null; // Broken JSON counts as "nothing saved".
    }
  }

  // Saves the state. Does nothing if storage is unavailable or full.
  function saveState(state) {
    var storage = getStorage();
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // Storage full or blocked: the app keeps working, it just won't remember.
    }
  }

  // Deletes the saved state.
  function clearState() {
    var storage = getStorage();
    if (!storage) return;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (e) {
      // Nothing to do.
    }
  }

  /* ---------- Money in and out ---------- */

  // Turns cents into a localized string such as "12,50 €".
  function formatMoney(cents, currency) {
    var code = currency || "EUR";
    var amount = cents / 100; // Only place we divide: turning cents into display text.
    try {
      return new Intl.NumberFormat("fi-FI", { style: "currency", currency: code }).format(amount);
    } catch (e) {
      return formatPlainAmount(cents) + " " + code; // Unknown currency code.
    }
  }

  // Turns cents into plain text like "44,44" using whole-number math only.
  function formatPlainAmount(cents) {
    var sign = cents < 0 ? "-" : "";
    var abs = Math.abs(cents);
    var euros = Math.floor(abs / 100);
    var rest = abs % 100;
    var restText = rest < 10 ? "0" + rest : String(rest);
    return sign + euros + "," + restText;
  }

  // Turns typed text into cents. "12.5", "12,50", " 12 " all work.
  // Returns null for anything that is not a plain non-negative amount.
  function parseMoneyInput(text) {
    if (typeof text !== "string" && typeof text !== "number") return null;
    var clean = String(text).trim();
    var match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(clean);
    if (!match) return null;

    var whole = parseInt(match[1], 10);
    var decimals = match[2] || "";
    if (decimals.length === 1) decimals = decimals + "0"; // "5" means 50 cents.
    var fraction = decimals ? parseInt(decimals, 10) : 0;

    var cents = whole * 100 + fraction;
    if (!Number.isSafeInteger(cents)) return null;
    return cents;
  }

  /* ---------- Items ---------- */

  // Adds a new item and returns the new state.
  function addItem(state, fields) {
    var f = fields || {};
    var item = {
      id: uid("i"),
      name: typeof f.name === "string" ? f.name.trim() : "",
      qty: isNonNegativeInt(f.qty) && f.qty > 0 ? f.qty : 1,
      priceCents: isNonNegativeInt(f.priceCents) ? f.priceCents : 0,
      assignedTo: []
    };
    return withChanges(state, { items: state.items.concat([item]) });
  }

  // Changes name, qty or priceCents of one item. Bad values are ignored.
  function updateItem(state, itemId, patch) {
    var p = patch || {};
    var items = state.items.map(function (item) {
      if (item.id !== itemId) return item;
      var next = copyItem(item);
      if (typeof p.name === "string") next.name = p.name;
      if (isNonNegativeInt(p.qty) && p.qty > 0) next.qty = p.qty;
      if (isNonNegativeInt(p.priceCents)) next.priceCents = p.priceCents;
      return next;
    });
    return withChanges(state, { items: items });
  }

  // Removes one item.
  function removeItem(state, itemId) {
    var items = state.items.filter(function (item) {
      return item.id !== itemId;
    });
    return withChanges(state, { items: items });
  }

  /* ---------- People ---------- */

  // Adds a person. Empty names are rejected (the same state comes back).
  function addPerson(state, name) {
    var clean = typeof name === "string" ? name.trim() : "";
    if (clean === "") return state;
    var person = { id: uid("p"), name: clean };
    return withChanges(state, { people: state.people.concat([person]) });
  }

  // Removes a person and takes them off every item they were assigned to.
  function removePerson(state, personId) {
    var people = state.people.filter(function (person) {
      return person.id !== personId;
    });
    var items = state.items.map(function (item) {
      if (item.assignedTo.indexOf(personId) === -1) return item;
      var next = copyItem(item);
      next.assignedTo = next.assignedTo.filter(function (id) {
        return id !== personId;
      });
      return next;
    });
    return withChanges(state, { people: people, items: items });
  }

  // Puts a person on an item, or takes them off if they were already on it.
  function toggleAssignment(state, itemId, personId) {
    var personExists = state.people.some(function (p) {
      return p.id === personId;
    });
    if (!personExists) return state;

    var items = state.items.map(function (item) {
      if (item.id !== itemId) return item;
      var next = copyItem(item);
      var at = next.assignedTo.indexOf(personId);
      if (at === -1) next.assignedTo.push(personId);
      else next.assignedTo.splice(at, 1);
      return next;
    });
    return withChanges(state, { items: items });
  }

  /* ---------- Splitting math ---------- */

  // Splits amountCents evenly into `count` parts.
  // Leftover cents go one each to the first parts. Example: 100 / 3 -> [34, 33, 33].
  function splitEvenly(amountCents, count) {
    var base = Math.floor(amountCents / count);
    var leftover = amountCents - base * count;
    var parts = [];
    for (var i = 0; i < count; i++) {
      parts.push(i < leftover ? base + 1 : base);
    }
    return parts;
  }

  // Splits amountCents in proportion to weights using the largest remainder method.
  // Everyone first gets the rounded-down share. The cents still left over go one
  // each to the biggest remainders; ties go to whoever comes first.
  // Uses whole numbers only, so no cent is lost or invented.
  function splitByWeight(amountCents, weights) {
    var totalWeight = 0;
    var i;
    for (i = 0; i < weights.length; i++) totalWeight += weights[i];
    if (weights.length === 0) return [];
    if (totalWeight === 0) return splitEvenly(amountCents, weights.length);

    var shares = [];
    var remainders = [];
    var given = 0;
    for (i = 0; i < weights.length; i++) {
      var product = amountCents * weights[i];
      var share = Math.floor(product / totalWeight);
      shares.push(share);
      remainders.push({ index: i, rest: product - share * totalWeight });
      given += share;
    }

    // Biggest remainder first; on a tie, keep people[] order.
    remainders.sort(function (a, b) {
      if (b.rest !== a.rest) return b.rest - a.rest;
      return a.index - b.index;
    });

    var left = amountCents - given;
    for (i = 0; i < left; i++) {
      shares[remainders[i].index] += 1;
    }
    return shares;
  }

  // Returns the ids on an item that belong to real people, in people[] order.
  function validAssignees(item, people) {
    return people
      .filter(function (person) {
        return item.assignedTo.indexOf(person.id) !== -1;
      })
      .map(function (person) {
        return person.id;
      });
  }

  // Works out what everyone owes. Never throws.
  function computeTotals(state) {
    var s = state || {};
    var items = Array.isArray(s.items) ? s.items : [];
    var people = Array.isArray(s.people) ? s.people : [];
    var taxCents = isNonNegativeInt(s.taxCents) ? s.taxCents : 0;
    var tipPercent = cleanTipPercent(s.tipPercent);
    var warnings = [];

    // 1. Subtotal of every item on the bill.
    var subtotalCents = 0;
    items.forEach(function (item) {
      if (isNonNegativeInt(item.priceCents)) subtotalCents += item.priceCents;
    });

    // 2. Tip is on the subtotal, before tax.
    var tipCents = Math.round((subtotalCents * tipPercent) / 100);
    var totalCents = subtotalCents + taxCents + tipCents;

    // 3. One empty row per person.
    var perPerson = people.map(function (person) {
      return {
        personId: person.id, name: person.name,
        itemsCents: 0, taxCents: 0, tipCents: 0, totalCents: 0, lines: []
      };
    });
    var rowById = {};
    perPerson.forEach(function (row) {
      rowById[row.personId] = row;
    });

    // 4. Split each item between its assigned people.
    var unassignedItemIds = [];
    items.forEach(function (item) {
      var price = isNonNegativeInt(item.priceCents) ? item.priceCents : 0;
      var ids = Array.isArray(item.assignedTo) ? validAssignees(item, people) : [];
      if (ids.length === 0) {
        unassignedItemIds.push(item.id);
        return;
      }
      var parts = splitEvenly(price, ids.length);
      ids.forEach(function (id, index) {
        var row = rowById[id];
        row.itemsCents += parts[index];
        row.lines.push({ itemId: item.id, name: item.name, shareCents: parts[index] });
      });
    });

    // 5. Share tax and tip in proportion to what each person ate.
    if (perPerson.length > 0) {
      var weights = perPerson.map(function (row) {
        return row.itemsCents;
      });
      var taxShares = splitByWeight(taxCents, weights);
      var tipShares = splitByWeight(tipCents, weights);
      perPerson.forEach(function (row, index) {
        row.taxCents = taxShares[index];
        row.tipCents = tipShares[index];
        row.totalCents = row.itemsCents + row.taxCents + row.tipCents;
      });
    }

    // 6. Warnings.
    if (people.length === 0) warnings.push("No people added yet");
    if (items.length === 0) warnings.push("No items on the bill yet");
    if (items.length > 0 && people.length > 0 && unassignedItemIds.length > 0) {
      var n = unassignedItemIds.length;
      warnings.push(n + (n === 1 ? " item unassigned" : " items unassigned"));
    }

    return {
      subtotalCents: subtotalCents,
      taxCents: taxCents,
      tipCents: tipCents,
      totalCents: totalCents,
      unassignedItemIds: unassignedItemIds,
      perPerson: perPerson,
      warnings: warnings
    };
  }

  /* ---------- Summary text ---------- */

  // Turns a percent like 12.5 into "12,5" to match the money format.
  function formatPercent(value) {
    return String(value).replace(".", ",");
  }

  // Builds plain text that can be pasted into a group chat.
  function buildSummaryText(state, totals) {
    var t = totals || computeTotals(state);
    var currency = (state && state.currency) || "EUR";
    var lines = [];

    lines.push("SplitIt - total " + formatPlainAmount(t.totalCents) + " " + currency);
    t.perPerson.forEach(function (row) {
      lines.push(row.name + ": " + formatPlainAmount(row.totalCents) + " " + currency);
    });

    var tip = cleanTipPercent(state && state.tipPercent);
    if (tip > 0) lines.push("(tip " + formatPercent(tip) + "% included)");

    var link = state && typeof state.paymentLink === "string" ? state.paymentLink.trim() : "";
    if (link !== "") lines.push("Pay here: " + link);

    t.warnings.forEach(function (warning) {
      lines.push("Warning: " + warning);
    });

    return lines.join("\n");
  }

  /* ---------- Self test ---------- */

  // Tiny repeatable random number generator, so test runs are the same every time.
  function makeRandom(seed) {
    var value = seed;
    return function (min, max) {
      value = (value * 1103515245 + 12345) % 2147483648;
      return min + (value % (max - min + 1));
    };
  }

  // Builds the golden test bill from the contract.
  function buildGoldenState() {
    var s = createInitialState();
    s = addPerson(s, "Aino");
    s = addPerson(s, "Bo");
    s = addPerson(s, "Cleo");
    s = withChanges(s, { tipPercent: 10 });
    var ids = s.people.map(function (p) { return p.id; });

    s = addItem(s, { name: "Pizza", qty: 1, priceCents: 1250 });
    s = addItem(s, { name: "Pasta", qty: 1, priceCents: 1190 });
    s = addItem(s, { name: "Salad", qty: 1, priceCents: 900 });
    s = addItem(s, { name: "Nachos", qty: 1, priceCents: 700 });
    var it = s.items;
    s = toggleAssignment(s, it[0].id, ids[0]);
    s = toggleAssignment(s, it[1].id, ids[1]);
    s = toggleAssignment(s, it[2].id, ids[2]);
    s = toggleAssignment(s, it[3].id, ids[0]);
    s = toggleAssignment(s, it[3].id, ids[1]);
    s = toggleAssignment(s, it[3].id, ids[2]);
    return s;
  }

  // Finds a person's share of one item in a totals row.
  function shareOf(row, itemName) {
    for (var i = 0; i < row.lines.length; i++) {
      if (row.lines[i].name === itemName) return row.lines[i].shareCents;
    }
    return null;
  }

  // Builds one random bill where every item is assigned to at least one person.
  function buildRandomState(rand) {
    var s = createInitialState();
    var peopleCount = rand(1, 6);
    var itemCount = rand(1, 10);
    for (var p = 0; p < peopleCount; p++) s = addPerson(s, "P" + p);
    for (var i = 0; i < itemCount; i++) {
      s = addItem(s, { name: "Item" + i, qty: 1, priceCents: rand(0, 5000) });
    }
    s.items.forEach(function (item) {
      var picked = 0;
      s.people.forEach(function (person) {
        if (rand(0, 1) === 1) {
          s = toggleAssignment(s, item.id, person.id);
          picked++;
        }
      });
      if (picked === 0) s = toggleAssignment(s, item.id, s.people[0].id);
    });
    // Tip like 12.5%: a whole number of tenths between 0 and 100.
    return withChanges(s, { taxCents: rand(0, 2000), tipPercent: rand(0, 1000) / 10 });
  }

  // Runs every check, logs PASS/FAIL for each, and returns the counts.
  function selfTest() {
    var passed = 0;
    var failed = 0;

    function check(label, ok) {
      if (ok) passed++;
      else failed++;
      console.log((ok ? "PASS " : "FAIL ") + label);
    }

    // 1. Golden test.
    var g = buildGoldenState();
    var gt = computeTotals(g);
    var rows = gt.perPerson;
    check("golden: nachos shares 234/233/233",
      shareOf(rows[0], "Nachos") === 234 && shareOf(rows[1], "Nachos") === 233 && shareOf(rows[2], "Nachos") === 233);
    check("golden: subtotal 4040", gt.subtotalCents === 4040);
    check("golden: tip 404", gt.tipCents === 404);
    check("golden: total 4444", gt.totalCents === 4444);
    check("golden: Aino 1633, Bo 1565, Cleo 1246",
      rows[0].totalCents === 1633 && rows[1].totalCents === 1565 && rows[2].totalCents === 1246);
    check("golden: person totals sum to 4444",
      rows[0].totalCents + rows[1].totalCents + rows[2].totalCents === 4444);
    check("golden: no warnings", gt.warnings.length === 0);
    var expectedText = "SplitIt - total 44,44 EUR\nAino: 16,33 EUR\nBo: 15,65 EUR\nCleo: 12,46 EUR\n(tip 10% included)";
    check("golden: summary text", buildSummaryText(g, gt) === expectedText);

    // 2. 100 cents between 3 people.
    var parts = splitEvenly(100, 3);
    check("100 cents / 3 people = 34/33/33", parts[0] === 34 && parts[1] === 33 && parts[2] === 33);

    // 3. Property test: 200 random bills, the per-person totals must add up exactly.
    var rand = makeRandom(42);
    var badBills = 0;
    for (var n = 0; n < 200; n++) {
      var rt = computeTotals(buildRandomState(rand));
      var sum = 0;
      rt.perPerson.forEach(function (row) { sum += row.totalCents; });
      if (sum !== rt.totalCents || rt.unassignedItemIds.length !== 0) badBills++;
    }
    check("property: 200 random bills, sum(perPerson) === total", badBills === 0);

    // 4. Edge cases: must not throw and must warn.
    var empty = createInitialState();
    var noPeople = addItem(empty, { name: "Soup", qty: 1, priceCents: 500 });
    var unassigned = addPerson(addItem(addItem(empty, { name: "A", priceCents: 100 }), { name: "B", priceCents: 200 }), "Aino");
    var cases = [
      { label: "no people, no items", state: empty },
      { label: "items but no people", state: noPeople },
      { label: "unassigned items", state: unassigned }
    ];
    cases.forEach(function (c) {
      var ok = false;
      try {
        var t = computeTotals(c.state);
        buildSummaryText(c.state, t);
        ok = t.warnings.length > 0;
      } catch (e) {
        ok = false;
      }
      check("edge: " + c.label + " does not throw and warns", ok);
    });
    var ut = computeTotals(unassigned);
    check("edge: unassigned summary shows 'Warning: 2 items unassigned'",
      buildSummaryText(unassigned, ut).indexOf("Warning: 2 items unassigned") !== -1);

    // Extra: money parsing.
    check("parseMoneyInput: '12.5' '12,50' ' 12 ' 'abc'",
      parseMoneyInput("12.5") === 1250 && parseMoneyInput("12,50") === 1250 &&
      parseMoneyInput(" 12 ") === 1200 && parseMoneyInput("abc") === null);

    console.log("SplitIt selfTest: " + passed + " passed, " + failed + " failed");
    return { passed: passed, failed: failed };
  }

  /* ---------- Export ---------- */

  globalThis.SplitIt = globalThis.SplitIt || {};
  globalThis.SplitIt.engine = {
    uid: uid,
    createInitialState: createInitialState,
    loadState: loadState,
    saveState: saveState,
    clearState: clearState,
    formatMoney: formatMoney,
    parseMoneyInput: parseMoneyInput,
    addItem: addItem,
    updateItem: updateItem,
    removeItem: removeItem,
    addPerson: addPerson,
    removePerson: removePerson,
    toggleAssignment: toggleAssignment,
    computeTotals: computeTotals,
    buildSummaryText: buildSummaryText,
    selfTest: selfTest
  };
})();
