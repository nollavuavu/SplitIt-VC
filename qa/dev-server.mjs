// qa/dev-server.mjs: a tiny local stand-in for Netlify, for testing only.
// - Serves the SplitIt folder (the parent of qa/) as static files.
// - With FUNCTION=on, sends /api/parse-receipt to the real Netlify
//   function code (netlify/functions/parse-receipt.mjs).
// - Reads the Gemini key from .gemini_key in the repo root (the folder
//   above qa/) into GEMINI_API_KEY. The key is never printed.
//
// Run with receipt reading:   FUNCTION=on node qa/dev-server.mjs
// Run as a plain static host: node qa/dev-server.mjs   (used by npm test)
// then open http://localhost:8765
// Options (environment variables):
//   PORT=8765      port to listen on
//   FUNCTION=on    turn the receipt reader on. The DEFAULT is off: the
//                  server acts like a static host with no function, so
//                  /api/parse-receipt answers a plain 404 and the page says
//                  "Receipt reading isn't set up yet".
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const QA_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(QA_DIR, '..');
const PORT = Number(process.env.PORT || 8765);
const FUNCTION_ON = process.env.FUNCTION === 'on';

// Load the key quietly. Only say whether it was found.
const keyFile = path.join(ROOT, '.gemini_key');
if (fs.existsSync(keyFile)) {
  process.env.GEMINI_API_KEY = fs.readFileSync(keyFile, 'utf8').trim();
}
const fn = (await import(pathToFileURL(path.join(ROOT, 'netlify/functions/parse-receipt.mjs')).href)).default;

const TYPES = { '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

// Turn Node's request into a standard web Request, call the function,
// and copy its Response back.
async function runFunction(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request('http://localhost' + req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks)
  });
  const response = await fn(request, {});
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.resolve(ROOT, '.' + urlPath);
  // Refuse anything outside the folder and any dotfile (like .gemini_key).
  if (!file.startsWith(ROOT + path.sep) || file.split(path.sep).some(p => p.startsWith('.'))) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/parse-receipt' || p === '/.netlify/functions/parse-receipt') {
    if (!FUNCTION_ON) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    return runFunction(req, res).catch(() => { res.writeHead(500); res.end('{"error":"crash"}'); });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log('dev-server on http://localhost:' + PORT,
    '| function', FUNCTION_ON ? 'on' : 'off',
    '| key', process.env.GEMINI_API_KEY ? 'loaded' : 'missing');
});
