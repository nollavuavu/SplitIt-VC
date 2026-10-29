// shell.js - the app frame. Holds the state, draws the header, and shows one screen at a time.
// Screens are registered by input.js (upload, items, people) and ui.js (assign, results).
globalThis.SplitIt = globalThis.SplitIt || {};

(function (SplitIt) {
  // The five steps, in the order the user walks through them.
  var STEPS = ["upload", "items", "people", "assign", "results"];
  var screens = {};   // stepName -> screen function
  var state = null;   // the single source of truth (plain JSON)
  var lastStep = null; // step drawn last time, so we only scroll up on a real step change

  // Screens call this once to say "I know how to draw this step".
  SplitIt.registerScreen = function (stepName, screenFn) {
    screens[stepName] = screenFn;
  };

  // Replace the state, save it, and redraw (unless silent: used while typing).
  function setState(newState, opts) {
    state = newState;
    SplitIt.engine.saveState(state);
    if (!(opts && opts.silent)) render();
  }

  // Jump to another step, keeping all data.
  function goTo(step) {
    setState(Object.assign({}, state, { step: step }));
  }

  // Header: app name plus one dot per step, the current one filled.
  function drawHeader(appEl) {
    var header = document.createElement("header");
    header.className = "row";
    var name = document.createElement("strong");
    name.textContent = "SplitIt";
    var dots = document.createElement("span");
    dots.className = "muted";
    var current = STEPS.indexOf(state.step);
    var text = "";
    for (var i = 0; i < STEPS.length; i++) text += (i === current ? "\u25CF" : "\u25CB") + " ";
    dots.textContent = text.trim();
    dots.setAttribute("aria-label", "Step " + (current + 1) + " of " + STEPS.length);
    header.appendChild(name);
    header.appendChild(dots);
    appEl.appendChild(header);
  }

  // Safety net: if a screen crashes, show what happened and a way out instead of a blank page.
  function drawError(rootEl, err) {
    rootEl.textContent = "";
    var box = document.createElement("div");
    box.className = "card warn stack";
    var msg = document.createElement("p");
    msg.textContent = "Something went wrong: " + (err && err.message ? err.message : String(err));
    var btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "Start over";
    btn.addEventListener("click", startOver);
    box.appendChild(msg);
    box.appendChild(btn);
    rootEl.appendChild(box);
  }

  function startOver() {
    SplitIt.engine.clearState();
    setState(SplitIt.engine.createInitialState());
  }

  // Draw the whole page for the current step.
  function render() {
    var appEl = document.getElementById("app");
    appEl.textContent = "";
    drawHeader(appEl);
    var rootEl = document.createElement("main");
    rootEl.className = "screen";
    appEl.appendChild(rootEl);
    var screenFn = screens[state.step];
    var ctx = { state: state, setState: setState, goTo: goTo, engine: SplitIt.engine };
    try {
      if (!screenFn) throw new Error("No screen called \"" + state.step + "\".");
      screenFn(rootEl, ctx);
    } catch (err) {
      console.error(err);
      drawError(rootEl, err);
    }
    if (state.step !== lastStep) window.scrollTo(0, 0);
    lastStep = state.step;
  }

  // Boot: resume saved state if it's valid, otherwise begin fresh.
  SplitIt.start = function () {
    var saved = SplitIt.engine.loadState();
    state = (saved && STEPS.indexOf(saved.step) !== -1) ? saved : SplitIt.engine.createInitialState();
    if (/[?&]test=1\b/.test(location.search)) SplitIt.engine.selfTest();
    render();
  };
})(globalThis.SplitIt);
