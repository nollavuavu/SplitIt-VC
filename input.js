/* =====================================================================
   input.js  (Agent 2: input flow)
   Screens: "upload", "items", "people"  +  SplitIt.parseReceipt(file)

   Everything sits inside one function wrapper (an IIFE) so this file adds
   no globals except what it puts on globalThis.SplitIt.
   ===================================================================== */
(function () {
  "use strict";

  /* -------------------------------------------------------------------
     SETTINGS: receipt reading uses Google Gemini.
     ------------------------------------------------------------------- */

  // TODO: paste your Gemini API key between the quotes to turn on receipt
  // reading (get one at https://aistudio.google.com/apikey).
  // WARNING: this whole app is one HTML file, so ANYONE who has the file can
  // read the key. Only paste it into a private copy; never share or commit it.
  // While it is EMPTY, "Read receipt" shows a friendly message and the user
  // types the items by hand (no network is used).
  const API_KEY = '';

  // The Gemini model and web address we send the photo to.
  const GEMINI_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

  // The instruction we send to the vision model together with the photo.
  // It must answer with ONLY a JSON object in exactly this shape.
  const RECEIPT_PROMPT =
    'You are reading a photo of a restaurant receipt. ' +
    'Reply with ONLY a JSON object, no explanation and no markdown, in exactly this shape: ' +
    '{"items":[{"name":string,"qty":number,"price":number}],"tax":number|null,"currency":string}. ' +
    'Rules: one entry per purchased line. "price" is the LINE TOTAL exactly as printed on that line ' +
    '(not the unit price), as a plain number like 12.50. "qty" is the quantity on that line, 1 if none is shown. ' +
    'Do NOT include subtotal, total, VAT summary, tip, change, card or cash payment lines as items. ' +
    '"tax" is a separately added tax amount only if the receipt adds tax on top of the items; ' +
    'if prices already include VAT (as in Finland) use null. ' +
    '"currency" is the ISO 4217 code such as "EUR". If unsure of the currency, use "EUR".';

  /* ------------------------------------------------------------------- */

  const SplitIt = (globalThis.SplitIt = globalThis.SplitIt || {});

  // Settings for shrinking the photo before upload.
  const MAX_IMAGE_EDGE = 1600; // pixels, longest side
  const JPEG_QUALITY = 0.8;

  /* =====================================================================
     PART 1: RECEIPT PARSING
     ===================================================================== */

  // Load an image File into an <img> element.
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That file could not be opened as an image. Try another photo.'));
      };
      img.src = url;
    });
  }

  // Shrink the image so its longest side is at most MAX_IMAGE_EDGE,
  // save it as JPEG, and return only the base64 part (no "data:" prefix).
  async function imageToBase64Jpeg(file) {
    const img = await loadImage(file);
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    const longest = Math.max(width, height);
    if (longest > MAX_IMAGE_EDGE) {
      const scale = MAX_IMAGE_EDGE / longest;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff'; // white behind transparent PNGs
    g.fillRect(0, 0, width, height);
    g.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  }

  /* ---------------------------------------------------------------
     callVisionAPI(base64): ask Gemini to read the receipt photo.
     How it works:
       1. We POST one message to Gemini with two parts: our instructions
          (RECEIPT_PROMPT) and the photo as base64 JPEG.
       2. We ask for a JSON reply (responseMimeType) and temperature 0,
          so the same photo gives the same answer.
       3. Gemini puts its answer text in candidates[0].content.parts[0].text.
          We return that text; parseModelText() checks it afterwards.
     --------------------------------------------------------------- */
  async function callVisionAPI(base64) {
    const body = {
      contents: [{
        parts: [
          { text: RECEIPT_PROMPT },
          { inline_data: { mime_type: 'image/jpeg', data: base64 } }
        ]
      }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 }
    };

    let res;
    try {
      res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
        body: JSON.stringify(body)
      });
    } catch (e) {
      // fetch only fails like this when there is no connection at all.
      throw new Error("Couldn't reach the receipt reader. Check your connection or enter items manually.");
    }

    if (!res.ok) {
      throw new Error(friendlyHttpError(res.status));
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error("The receipt reader sent a broken answer. Try again or enter items manually.");
    }
    return getReplyText(data);
  }

  // Turn an HTTP status code from Gemini into a message a person understands.
  function friendlyHttpError(status) {
    if (status === 400 || status === 401 || status === 403) {
      return 'The receipt reader refused the request (' + status + '). Check the API key, or enter items manually.';
    }
    if (status === 429) {
      return 'The receipt reader is busy right now (too many requests). Wait a minute or enter items manually.';
    }
    return 'The receipt reader answered with an error (' + status + '). Try again or enter items manually.';
  }

  // Dig the answer text out of Gemini's reply, or throw if it isn't there
  // (for example when Gemini blocked the image).
  function getReplyText(data) {
    const candidate = data && data.candidates && data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const text = parts && parts[0] && parts[0].text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error("The receipt reader didn't send back any items. Try a clearer photo or enter items manually.");
    }
    return text;
  }

  // Remove ``` or ```json fences and keep only the {...} part.
  function cleanModelText(text) {
    let s = String(text).replace(/```(?:json)?/gi, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first !== -1 && last > first) {
      s = s.slice(first, last + 1);
    }
    return s;
  }

  // True if x is a real number that is zero or more.
  function isGoodAmount(x) {
    return typeof x === 'number' && Number.isFinite(x) && x >= 0;
  }

  // Turn the model's raw text into { items, taxCents, currency }.
  // Throws an Error with a friendly message if anything looks wrong.
  function parseModelText(text) {
    let data;
    try {
      data = JSON.parse(cleanModelText(text));
    } catch (e) {
      throw new Error("Couldn't understand the receipt reader's answer. Try again or enter items manually.");
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      throw new Error("Couldn't find a list of items on that receipt. Try a clearer photo or enter items manually.");
    }

    const items = [];
    for (let i = 0; i < data.items.length; i++) {
      const raw = data.items[i] || {};
      // Let the engine turn the price into cents (no float money math).
      // It accepts 12.5, "12.50" and "12,50", and returns null if invalid.
      // A line with a bad price (negative, 3+ decimals, not a number) is
      // skipped instead of failing the whole receipt. The user can add it
      // by hand on the items screen.
      const priceCents = SplitIt.engine.parseMoneyInput(String(raw.price));
      if (priceCents === null) {
        continue;
      }
      let qty = typeof raw.qty === 'string' ? Number(raw.qty) : raw.qty;
      if (!isGoodAmount(qty) || qty === 0) {
        qty = 1;
      }
      let name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (name === '') {
        name = 'Item ' + (i + 1);
      }
      items.push({ name: name, qty: qty, priceCents: priceCents });
    }
    if (items.length === 0) {
      throw new Error('No readable items were found on that receipt. Try a clearer photo or enter the items by hand.');
    }

    let taxCents = 0;
    if (data.tax !== null && data.tax !== undefined) {
      taxCents = SplitIt.engine.parseMoneyInput(String(data.tax));
      if (taxCents === null) {
        throw new Error("The tax amount on the receipt couldn't be read. Please check it manually.");
      }
    }

    let currency = 'EUR';
    if (typeof data.currency === 'string' && /^[A-Za-z]{3}$/.test(data.currency.trim())) {
      currency = data.currency.trim().toUpperCase();
    }

    return { items: items, taxCents: taxCents, currency: currency };
  }

  // PUBLIC: SplitIt.parseReceipt(imageFile)
  // -> Promise<{ items: [{name, qty, priceCents}], taxCents, currency }>
  SplitIt.parseReceipt = async function parseReceipt(imageFile) {
    if (!imageFile) {
      throw new Error('Please choose a photo of the receipt first.');
    }
    if (imageFile.type && imageFile.type.indexOf('image/') !== 0) {
      throw new Error('That file is not an image. Please choose a photo of the receipt.');
    }

    // No key yet: stop with a friendly message so the user types the items.
    if (API_KEY === '') {
      throw new Error("Receipt reading isn't set up yet. Enter the items by hand.");
    }

    const base64 = await imageToBase64Jpeg(imageFile);
    let text;
    try {
      text = await callVisionAPI(base64);
    } catch (e) {
      // Keep our own friendly messages; replace network gibberish.
      const msg = e && e.message ? e.message : '';
      throw new Error(msg || "Couldn't reach the receipt reader. Check your connection or enter items manually.");
    }
    return parseModelText(text);
  };

  /* =====================================================================
     PART 2: SMALL DOM HELPERS
     ===================================================================== */

  // Make an element with an optional class name and optional text.
  // Text always goes in with textContent (never innerHTML).
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // 1234 -> "12.34" (plain text for an editable price field, no symbol).
  function centsToPlain(cents) {
    const whole = Math.floor(cents / 100);
    const rest = cents % 100;
    return whole + '.' + (rest < 10 ? '0' : '') + rest;
  }

  /* =====================================================================
     PART 3: SCREEN "upload"
     ===================================================================== */

  // The chosen photo is not part of saved state (it is not JSON),
  // so we remember it here while the page is open.
  let chosenFile = null;
  let chosenPreviewUrl = '';

  // Set to true by the items screen's Back button, so the upload screen
  // knows the user just went back (keep the photo) and not "Start over".
  let cameBackFromItems = false;

  // Forget everything this file remembers outside of state. Used after
  // "Start over", so an old photo or half-typed name doesn't come back.
  function resetLocalMemory() {
    if (chosenPreviewUrl) URL.revokeObjectURL(chosenPreviewUrl);
    chosenFile = null;
    chosenPreviewUrl = '';
    resetItemDrafts();
    personDraft = '';
  }

  function renderUpload(root, ctx) {
    // An empty state (no items, no people) means the user started over,
    // UNLESS they just pressed Back on the items screen. Then keep the photo.
    const isEmpty = ctx.state.items.length === 0 && ctx.state.people.length === 0;
    if (isEmpty && !cameBackFromItems) {
      resetLocalMemory();
    }
    cameBackFromItems = false; // the flag is used once, then cleared

    const screen = el('div', 'stack in-upload');
    screen.appendChild(el('h1', 'title', 'Scan your receipt'));
    screen.appendChild(el('p', 'muted', 'Take a photo of the bill, or pick one from your gallery.'));

    // File picker. The label is styled as a big button.
    const pickLabel = el('label', 'btn in-pick');
    pickLabel.appendChild(document.createTextNode(chosenFile ? 'Choose a different photo' : 'Take or choose photo'));
    const fileInput = el('input', 'in-file');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.setAttribute('capture', 'environment');
    pickLabel.appendChild(fileInput);
    screen.appendChild(pickLabel);

    // Error message area. It sits ABOVE the preview so a tall photo
    // can't push it down under the sticky button bar.
    const errorBox = el('p', 'warn in-error');
    errorBox.setAttribute('role', 'alert');
    screen.appendChild(errorBox);

    // Preview area.
    const previewBox = el('div', 'card in-preview');
    const previewImg = el('img', 'in-preview-img');
    previewImg.alt = 'Receipt preview';
    previewBox.appendChild(previewImg);
    screen.appendChild(previewBox);

    // Bottom buttons.
    const bar = el('div', 'sticky-bar stack');
    const readBtn = button('Read receipt', 'btn btn-primary in-read', onRead);
    const manualLink = button('Enter manually', 'btn btn-ghost in-link', function () {
      ctx.goTo('items');
    });
    bar.appendChild(readBtn);
    bar.appendChild(manualLink);
    screen.appendChild(bar);

    root.appendChild(screen);

    function showPreview() {
      if (chosenPreviewUrl) {
        previewImg.src = chosenPreviewUrl;
        previewBox.hidden = false;
      } else {
        previewBox.hidden = true;
      }
      readBtn.disabled = !chosenFile;
    }

    function showError(message) {
      errorBox.textContent = message || '';
      errorBox.hidden = !message;
    }

    function setLoading(isLoading) {
      readBtn.disabled = isLoading || !chosenFile;
      readBtn.textContent = isLoading ? 'Reading receipt...' : 'Read receipt';
      readBtn.classList.toggle('in-loading', isLoading);
      fileInput.disabled = isLoading;
      manualLink.disabled = isLoading;
    }

    fileInput.addEventListener('change', function () {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (chosenPreviewUrl) URL.revokeObjectURL(chosenPreviewUrl);
      chosenFile = file;
      chosenPreviewUrl = URL.createObjectURL(file);
      pickLabel.firstChild.textContent = 'Choose a different photo';
      showError('');
      showPreview();
    });

    async function onRead() {
      if (!chosenFile) return;
      showError('');
      setLoading(true);
      try {
        const result = await SplitIt.parseReceipt(chosenFile);
        const engine = ctx.engine;
        // Replace any old items with the ones from the receipt.
        let state = Object.assign({}, ctx.state, { items: [] });
        for (let i = 0; i < result.items.length; i++) {
          state = engine.addItem(state, result.items[i]);
        }
        state = Object.assign({}, state, { taxCents: result.taxCents, currency: result.currency });
        resetItemDrafts();
        ctx.setState(state, { silent: true });
        ctx.goTo('items');
      } catch (e) {
        setLoading(false);
        showError(e && e.message ? e.message : 'Something went wrong reading the receipt. Try again or enter items manually.');
      }
    }

    showPreview();
    showError('');
  }

  /* =====================================================================
     PART 4: SCREEN "items"
     ===================================================================== */

  // Text the user typed that is not (yet) a valid price. Keyed by item id.
  // Valid prices live in state as priceCents; invalid text lives only here.
  let priceDrafts = {};
  let taxDraft = null; // null = no draft, use state.taxCents

  function resetItemDrafts() {
    priceDrafts = {};
    taxDraft = null;
  }

  function renderItems(root, ctx) {
    const engine = ctx.engine;
    // Our own copy of state. Silent saves do not re-render, so ctx.state
    // would get out of date; we always build on this variable instead.
    let state = ctx.state;

    const screen = el('div', 'stack in-items');
    screen.appendChild(el('h1', 'title', 'Check the items'));
    screen.appendChild(el('p', 'muted', 'Fix anything the receipt reader got wrong. Price is the total for the line.'));

    const list = el('div', 'stack in-list');
    screen.appendChild(list);

    // Each row's message element, so we can update it without re-rendering.
    const rowMessages = {};

    if (state.items.length === 0) {
      list.appendChild(el('p', 'muted in-empty', 'No items yet. Tap "Add item" to start.'));
    }

    for (let i = 0; i < state.items.length; i++) {
      list.appendChild(buildRow(state.items[i]));
    }

    screen.appendChild(
      button('+ Add item', 'btn btn-ghost in-add', function () {
        const before = state.items.length;
        state = engine.addItem(state, { name: '', qty: 1, priceCents: 0 });
        const added = state.items[before] || state.items[state.items.length - 1];
        if (added) priceDrafts[added.id] = ''; // empty price until typed
        ctx.setState(state); // re-render
        focusLastName(root);
      })
    );

    // Optional tax.
    const taxCard = el('div', 'card stack in-tax');
    const taxLabel = el('label', 'in-label', 'Tax added on top (optional)');
    const taxInput = el('input', 'input in-tax-input');
    taxInput.type = 'text';
    taxInput.inputMode = 'decimal';
    taxInput.placeholder = '0.00';
    taxInput.value = taxDraft !== null ? taxDraft : state.taxCents ? centsToPlain(state.taxCents) : '';
    taxLabel.appendChild(taxInput);
    taxCard.appendChild(taxLabel);
    taxCard.appendChild(el('p', 'muted in-small', 'Finnish receipts already include VAT, so usually leave this empty.'));
    const taxMsg = el('p', 'warn in-row-msg');
    taxCard.appendChild(taxMsg);
    screen.appendChild(taxCard);

    taxInput.addEventListener('input', function () {
      const text = taxInput.value;
      if (text.trim() === '') {
        taxDraft = null;
        state = Object.assign({}, state, { taxCents: 0 });
        ctx.setState(state, { silent: true });
      } else {
        const cents = engine.parseMoneyInput(text);
        if (cents === null) {
          taxDraft = text;
        } else {
          taxDraft = null;
          state = Object.assign({}, state, { taxCents: cents });
          ctx.setState(state, { silent: true });
        }
      }
      refresh();
    });

    // Subtotal and problems summary.
    const subtotalLine = el('p', 'in-subtotal');
    screen.appendChild(subtotalLine);
    const problemsLine = el('p', 'warn in-problems');
    screen.appendChild(problemsLine);

    // Back / Next.
    const bar = el('div', 'sticky-bar row');
    bar.appendChild(button('Back', 'btn btn-ghost', function () {
      cameBackFromItems = true; // tells the upload screen to keep the photo
      ctx.goTo('upload');
    }));
    const nextBtn = button('Next', 'btn btn-primary', function () {
      if (!nextBtn.disabled) ctx.goTo('people');
    });
    bar.appendChild(nextBtn);
    screen.appendChild(bar);

    root.appendChild(screen);
    refresh();

    // Build one editable row for an item.
    function buildRow(item) {
      const row = el('div', 'card stack in-item');
      const fields = el('div', 'row in-item-fields');

      const nameInput = el('input', 'input in-name');
      nameInput.type = 'text';
      nameInput.placeholder = 'Item name';
      nameInput.value = item.name;
      nameInput.setAttribute('aria-label', 'Item name');

      const qtyInput = el('input', 'input in-qty');
      qtyInput.type = 'number';
      qtyInput.min = '1';
      qtyInput.step = '1';
      qtyInput.inputMode = 'numeric';
      qtyInput.value = String(item.qty);
      qtyInput.setAttribute('aria-label', 'Quantity');

      const priceInput = el('input', 'input in-price');
      priceInput.type = 'text';
      priceInput.inputMode = 'decimal';
      priceInput.placeholder = '0.00';
      priceInput.value = item.id in priceDrafts ? priceDrafts[item.id] : centsToPlain(item.priceCents);
      priceInput.setAttribute('aria-label', 'Line price');

      const del = button('\u00d7', 'btn btn-ghost in-del', function () {
        delete priceDrafts[item.id];
        state = engine.removeItem(state, item.id);
        ctx.setState(state); // re-render
      });
      del.setAttribute('aria-label', 'Delete item');

      fields.appendChild(nameInput);
      fields.appendChild(qtyInput);
      fields.appendChild(priceInput);
      fields.appendChild(del);
      row.appendChild(fields);

      const msg = el('p', 'warn in-row-msg');
      row.appendChild(msg);
      rowMessages[item.id] = { msg: msg, row: row };

      nameInput.addEventListener('input', function () {
        state = engine.updateItem(state, item.id, { name: nameInput.value });
        ctx.setState(state, { silent: true });
        refresh();
      });

      qtyInput.addEventListener('input', function () {
        const n = parseInt(qtyInput.value, 10);
        if (Number.isFinite(n) && n >= 1) {
          state = engine.updateItem(state, item.id, { qty: n });
          ctx.setState(state, { silent: true });
        }
      });

      priceInput.addEventListener('input', function () {
        const cents = engine.parseMoneyInput(priceInput.value);
        if (cents === null) {
          priceDrafts[item.id] = priceInput.value;
        } else {
          delete priceDrafts[item.id];
          state = engine.updateItem(state, item.id, { priceCents: cents });
          ctx.setState(state, { silent: true });
        }
        refresh();
      });

      return row;
    }

    // Recheck everything and update subtotal, messages and the Next button.
    function refresh() {
      let subtotal = 0;
      const problems = [];

      for (let i = 0; i < state.items.length; i++) {
        const item = state.items[i];
        const parts = rowMessages[item.id];
        let message = '';
        const label = item.name.trim() !== '' ? '"' + item.name.trim() + '"' : 'Item ' + (i + 1);

        if (item.id in priceDrafts) {
          message = priceDrafts[item.id].trim() === '' ? 'Enter a price.' : 'Price is not a valid amount (example: 12.50).';
          problems.push(label + ': price');
        } else {
          subtotal += item.priceCents;
        }
        if (item.name.trim() === '') {
          message = message ? message + ' Add a name.' : 'Add a name.';
          if (!(item.id in priceDrafts)) problems.push(label + ': name');
        }
        if (parts) {
          parts.msg.textContent = message;
          parts.msg.hidden = message === '';
          parts.row.classList.toggle('in-invalid', message !== '');
        }
      }

      const taxBad = taxDraft !== null;
      taxMsg.textContent = taxBad ? 'Tax is not a valid amount (example: 3.20).' : '';
      taxMsg.hidden = !taxBad;
      taxInput.classList.toggle('in-invalid-input', taxBad);
      if (taxBad) problems.push('Tax');

      subtotalLine.textContent = 'Subtotal: ' + engine.formatMoney(subtotal, state.currency);

      if (state.items.length === 0) {
        problemsLine.textContent = 'Add at least one item to continue.';
      } else if (problems.length > 0) {
        problemsLine.textContent = 'Fix before continuing: ' + problems.join(', ');
      } else {
        problemsLine.textContent = '';
      }
      problemsLine.hidden = problemsLine.textContent === '';
      nextBtn.disabled = state.items.length === 0 || problems.length > 0;
    }
  }

  // After "Add item" re-renders, put the cursor in the new row's name box.
  function focusLastName(root) {
    const names = root.querySelectorAll('.in-name');
    if (names.length > 0) names[names.length - 1].focus();
  }

  /* =====================================================================
     PART 5: SCREEN "people"
     ===================================================================== */

  let personDraft = ''; // half-typed name, kept across re-renders
  let focusPersonInput = false; // true right after adding someone

  function renderPeople(root, ctx) {
    const engine = ctx.engine;
    const state = ctx.state;

    const screen = el('div', 'stack in-people');
    screen.appendChild(el('h1', 'title', "Who's splitting?"));
    screen.appendChild(el('p', 'muted', 'Add everyone at the table, including yourself.'));

    const addRow = el('div', 'row in-add-person');
    const nameInput = el('input', 'input in-person-input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Name';
    nameInput.value = personDraft;
    nameInput.setAttribute('aria-label', 'Person name');
    nameInput.enterKeyHint = 'done';
    const addBtn = button('Add', 'btn btn-primary in-person-add', addPerson);
    addRow.appendChild(nameInput);
    addRow.appendChild(addBtn);
    screen.appendChild(addRow);

    // Chips for people already added.
    const chips = el('div', 'row in-chips');
    for (let i = 0; i < state.people.length; i++) {
      chips.appendChild(buildChip(state.people[i]));
    }
    screen.appendChild(chips);

    if (state.people.length === 0) {
      screen.appendChild(el('p', 'muted in-hint', 'Nobody added yet.'));
    } else if (state.people.length === 1) {
      screen.appendChild(el('p', 'muted in-hint', 'Only one person so far. Add the others to split the bill.'));
    }

    const bar = el('div', 'sticky-bar row');
    bar.appendChild(button('Back', 'btn btn-ghost', function () { ctx.goTo('items'); }));
    const nextBtn = button('Next', 'btn btn-primary', function () {
      if (state.people.length > 0) ctx.goTo('assign');
    });
    nextBtn.disabled = state.people.length === 0;
    bar.appendChild(nextBtn);
    screen.appendChild(bar);

    root.appendChild(screen);

    nameInput.addEventListener('input', function () {
      personDraft = nameInput.value;
    });
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addPerson();
      }
    });

    // Keep the keyboard open right after adding someone (only then).
    if (focusPersonInput) {
      focusPersonInput = false;
      nameInput.focus();
    }

    function addPerson() {
      const name = nameInput.value.trim();
      if (name === '') return;
      personDraft = '';
      focusPersonInput = true;
      ctx.setState(engine.addPerson(state, name)); // re-render
    }

    function buildChip(person) {
      const chip = el('span', 'chip on in-chip');
      chip.appendChild(el('span', 'in-chip-name', person.name));
      const x = button('\u00d7', 'in-chip-x', function () {
        ctx.setState(engine.removePerson(state, person.id)); // re-render
      });
      x.setAttribute('aria-label', 'Remove ' + person.name);
      chip.appendChild(x);
      return chip;
    }
  }

  /* =====================================================================
     PART 6: REGISTER THE SCREENS WITH THE SHELL
     ===================================================================== */

  SplitIt.registerScreen('upload', renderUpload);
  SplitIt.registerScreen('items', renderItems);
  SplitIt.registerScreen('people', renderPeople);
})();
