/* =====================================================================
   input.js  (Agent 2: input flow)
   Screens: "upload", "items", "people"  +  SplitIt.parseReceipt(file)

   Everything sits inside one function wrapper (an IIFE) so this file adds
   no globals except what it puts on globalThis.SplitIt.
   ===================================================================== */
(function () {
  "use strict";

  /* -------------------------------------------------------------------
     SETTINGS: receipt reading.
     The page never talks to Google Gemini itself and never holds a key.
     It sends the photo to OUR server at /api/parse-receipt, and the server
     adds the secret key and the instructions (the prompt) for Gemini.
     See netlify/functions/parse-receipt.mjs (deployed on Netlify) and
     qa/dev-server.mjs (the same thing on your own computer).
     Opened as a plain file (file://) there is no server, so "Read receipt"
     shows a friendly message and the user types the items by hand.
     ------------------------------------------------------------------- */

  // Where the receipt reader lives (see netlify.toml).
  const PROXY_URL = '/api/parse-receipt';

  // Give up waiting for our server after this many milliseconds.
  // (The server itself gives up on Gemini after 24 s, so this is a bit longer.)
  const READER_TIMEOUT_MS = 30000;

  /* ------------------------------------------------------------------- */

  const SplitIt = (globalThis.SplitIt = globalThis.SplitIt || {});

  // Settings for shrinking the photo before upload.
  // Smaller photos upload faster and Gemini answers sooner.
  const MAX_IMAGE_EDGE = 1280; // pixels, longest side
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

  const TOO_SLOW_MESSAGE =
    'The receipt reader took too long to answer. Try again or enter items manually.';
  const CANT_REACH_MESSAGE =
    "Couldn't reach the receipt reader. Check your connection or enter items manually.";
  const NOT_SET_UP_MESSAGE = "Receipt reading isn't set up yet. Enter the items by hand.";

  // True if this error came from our timer cancelling the request.
  function isTimeout(e) {
    return !!e && e.name === 'AbortError';
  }

  // Turn an HTTP status code (from Gemini, passed on by our server)
  // into a message a person understands.
  function friendlyHttpError(status) {
    if (status === 400 || status === 401 || status === 403) {
      return 'The receipt reader refused the request (' + status + '). Check GEMINI_API_KEY on the server, or enter items manually.';
    }
    if (status === 404) {
      return 'The receipt reader model was not found (404). Check GEMINI_MODEL on the server, or enter items manually.';
    }
    if (status === 429) {
      return 'Too many requests to the receipt reader right now. Wait a minute or enter items manually.';
    }
    if (status === 503) {
      return 'The receipt reader is busy right now. Try again in a minute or enter items manually.';
    }
    return 'The receipt reader answered with an error (' + status + '). Try again or enter items manually.';
  }

  /* ---------------------------------------------------------------
     callProxyAPI(base64): ask OUR server (/api/parse-receipt) to read
     the receipt. We send only the photo: { image_base64, mime_type }.
     The server answers with { text } (Gemini's answer) or
     { error: "short_code", ... }. Here we turn those codes into
     friendly sentences.
     --------------------------------------------------------------- */
  async function callProxyAPI(base64) {
    // An AbortController lets us cancel the request if it takes too long.
    // The timer covers BOTH waiting for the answer and reading its body.
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, READER_TIMEOUT_MS);

    let res;
    let data = null;
    try {
      try {
        res = await fetch(PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: base64, mime_type: 'image/jpeg' }),
          signal: controller.signal
        });
      } catch (e) {
        throw new Error(isTimeout(e) ? TOO_SLOW_MESSAGE : CANT_REACH_MESSAGE);
      }
      try {
        data = await res.json();
      } catch (e) {
        if (isTimeout(e)) throw new Error(TOO_SLOW_MESSAGE);
        data = null; // not JSON: probably a plain web server, handled below
      }
    } finally {
      clearTimeout(timer); // always stop the timer, whatever happened
    }

    // Our function always answers with JSON. A non-JSON 404/405/501 means
    // this web server has no receipt reader (for example a plain static host).
    if (data === null || typeof data !== 'object') {
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        throw new Error(NOT_SET_UP_MESSAGE);
      }
      throw new Error(res.ok
        ? 'The receipt reader sent a broken answer. Try again or enter items manually.'
        : friendlyHttpError(res.status));
    }

    if (res.ok && typeof data.text === 'string') {
      return data.text;
    }
    throw new Error(proxyErrorMessage(data.error, data, res.status));
  }

  // Turn the server's short error code into a sentence for the user.
  function proxyErrorMessage(code, data, status) {
    if (code === 'not_configured') return NOT_SET_UP_MESSAGE;
    if (code === 'gemini_http') return friendlyHttpError(data.geminiStatus || status);
    if (code === 'timeout') return TOO_SLOW_MESSAGE;
    if (code === 'unreachable') return "The receipt reader couldn't reach Gemini. Try again or enter items manually.";
    if (code === 'too_large') return 'That photo is too large. Try a smaller photo or enter items manually.';
    if (code === 'blocked') return 'The receipt reader refused this photo (' + (data.reason || 'blocked') + '). Try another photo or enter items manually.';
    if (code === 'safety') return 'The receipt reader stopped for safety reasons. Try another photo or enter items manually.';
    if (code === 'max_tokens') return 'The receipt is too long for the reader to finish. Enter the items manually, or photograph it in two parts.';
    if (code === 'empty') return "The receipt reader didn't send back any items. Try a clearer photo or enter items manually.";
    return 'The receipt reader answered with an error (' + status + '). Try again or enter items manually.';
  }

  // True when the page was opened from a web server (not as a local file).
  function isServedOverHttp() {
    return typeof location !== 'undefined' &&
      (location.protocol === 'http:' || location.protocol === 'https:');
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
    let skippedCount = 0; // lines we couldn't read and left out
    for (let i = 0; i < data.items.length; i++) {
      const raw = data.items[i] || {};
      // Let the engine turn the price into cents (no float money math).
      // It accepts 12.5, "12.50" and "12,50", and returns null if invalid.
      // A line with a bad price (negative, 3+ decimals, not a number) is
      // skipped instead of failing the whole receipt. The user can add it
      // by hand on the items screen.
      const priceCents = SplitIt.engine.parseMoneyInput(String(raw.price));
      if (priceCents === null) {
        skippedCount++;
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

    return { items: items, taxCents: taxCents, currency: currency, skippedCount: skippedCount };
  }

  // PUBLIC: SplitIt.parseReceipt(imageFile)
  // -> Promise<{ items: [{name, qty, priceCents}], taxCents, currency, skippedCount }>
  // skippedCount = how many receipt lines had an unreadable price and were left out.
  SplitIt.parseReceipt = async function parseReceipt(imageFile) {
    if (!imageFile) {
      throw new Error('Please choose a photo of the receipt first.');
    }
    if (imageFile.type && imageFile.type.indexOf('image/') !== 0) {
      throw new Error('That file is not an image. Please choose a photo of the receipt.');
    }

    // No web server (opened as a file): nothing can read the receipt,
    // so stop with a friendly message and let the user type it.
    if (!isServedOverHttp()) {
      throw new Error(NOT_SET_UP_MESSAGE);
    }

    const base64 = await imageToBase64Jpeg(imageFile);
    let text;
    try {
      // Ask our server, which keeps the Gemini key secret.
      text = await callProxyAPI(base64);
    } catch (e) {
      // Keep our own friendly messages; replace network gibberish.
      const msg = e && e.message ? e.message : '';
      throw new Error(msg || CANT_REACH_MESSAGE);
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
        skippedLines = result.skippedCount || 0;
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

  // How many lines the last receipt read had to leave out (0 = none).
  let skippedLines = 0;

  function resetItemDrafts() {
    priceDrafts = {};
    taxDraft = null;
    skippedLines = 0;
  }

  function renderItems(root, ctx) {
    const engine = ctx.engine;
    // Our own copy of state. Silent saves do not re-render, so ctx.state
    // would get out of date; we always build on this variable instead.
    let state = ctx.state;

    const screen = el('div', 'stack in-items');
    screen.appendChild(el('h1', 'title', 'Check the items'));
    screen.appendChild(el('p', 'muted', 'Fix anything the receipt reader got wrong. Price is the total for the line.'));

    // Tell the user if the receipt reader had to leave some lines out.
    if (skippedLines > 0) {
      const notice = skippedLines === 1
        ? "1 line couldn't be read. Please add it."
        : skippedLines + " lines couldn't be read. Please add them.";
      const skippedMsg = el('p', 'warn in-skipped', notice);
      skippedMsg.setAttribute('role', 'status');
      screen.appendChild(skippedMsg);
    }

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
