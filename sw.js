/*
  sw.js: the SplitIt service worker (Agent 3).

  A service worker is a small script the browser keeps running next to the
  page. It can answer the page's network requests itself. We use it so the
  app opens even with no internet:

  1. "install":  download the app shell (the files the app needs to start)
                 and keep them in a cache.
  2. "activate": delete caches from older versions of this file.
  3. "fetch":    when the page asks for a shell file, answer from the cache
                 first (fast, works offline), and quietly refresh the cached
                 copy from the network in the background for next time.

  It NEVER touches /api/* (receipt reading must always go to the server),
  non-GET requests, or other websites. For those we simply return without
  calling respondWith, and the browser handles the request normally.

  To ship a new version: change CACHE_VERSION. Old caches are then deleted.
*/

var CACHE_VERSION = "v1";
var CACHE_NAME = "splitit-shell-" + CACHE_VERSION;

// The app shell: everything SplitIt needs to start with no network.
var SHELL_FILES = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
  "/icons/favicon-16.png"
];

/* ---------- install: fill the cache ---------- */
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(SHELL_FILES); })
      .then(function () { return self.skipWaiting(); })   // take over without waiting for old tabs to close
  );
});

/* ---------- activate: remove old caches ---------- */
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        var deletions = [];
        for (var i = 0; i < names.length; i++) {
          var isOurs = names[i].indexOf("splitit-shell-") === 0;
          if (isOurs && names[i] !== CACHE_NAME) deletions.push(caches.delete(names[i]));
        }
        return Promise.all(deletions);
      })
      .then(function () { return self.clients.claim(); })  // start controlling open pages now
  );
});

/* ---------- fetch: answer from the cache ---------- */
self.addEventListener("fetch", function (event) {
  var request = event.request;
  var url = new URL(request.url);

  // Leave these alone completely (no respondWith = normal network request):
  if (request.method !== "GET") return;                    // POSTs etc.
  if (url.origin !== self.location.origin) return;         // other websites
  if (url.pathname.indexOf("/api/") === 0) return;         // our server API
  if (url.pathname.indexOf("/.netlify/") === 0) return;    // Netlify internals

  // Opening the app (a page load): any URL like "/", "/index.html" or
  // "/?test=1" gets the cached start page, because SplitIt is a single page.
  // We store it under "/" (a host may redirect /index.html to /), and fall
  // back to the cached "/index.html" if "/" is missing.
  if (request.mode === "navigate") {
    event.respondWith(cacheFirst(event, "/", "/index.html"));
    return;
  }

  // Other shell files (manifest, icons): only those we listed.
  if (SHELL_FILES.indexOf(url.pathname) !== -1) {
    event.respondWith(cacheFirst(event, url.pathname));
  }
  // Anything else: no respondWith, the browser fetches it normally.
});

// Answer with the cached copy of cacheKey (or of backupKey, if given) when
// we have one, and refresh the cached copy from the network in the
// background. With no cached copy, use the network (and save a good answer
// for next time).
function cacheFirst(event, cacheKey, backupKey) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(cacheKey).then(function (cached) {
      if (cached || !backupKey) return cached;
      return cache.match(backupKey);
    }).then(function (cached) {
      var fromNetwork = fetch(event.request)
        .then(function (response) {
          if (isGoodToCache(response)) cache.put(cacheKey, response.clone());
          return response;
        });

      if (cached) {
        // Keep the worker alive until the background refresh finishes,
        // but ignore its errors (being offline is fine here).
        event.waitUntil(fromNetwork.catch(function () {}));
        return cached;
      }
      return fromNetwork;
    });
  });
}

// Only cache normal, successful answers. This skips error pages and
// login redirects (the site sits behind a Netlify login).
function isGoodToCache(response) {
  return response && response.status === 200 && response.type === "basic" && !response.redirected;
}
