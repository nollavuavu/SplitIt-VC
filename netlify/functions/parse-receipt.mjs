// netlify/functions/parse-receipt.mjs
// --------------------------------------------------------------------
// A tiny server-side helper for SplitIt (a Netlify Function, version 2).
// The browser sends the receipt photo here, and this code passes it on
// to Google Gemini using a key that only the server knows. That way the
// Gemini key is never inside index.html.
//
// Request:  POST JSON { image_base64, mime_type }
//           Any other fields are ignored. The instructions for Gemini
//           (RECEIPT_PROMPT below) live ONLY here, on the server.
// Success:  200 { text }        text = Gemini's answer (JSON as text)
// Failure:  4xx/5xx { error, geminiStatus?, reason? }
//           error is a short code; input.js turns it into a friendly
//           sentence, so all user-facing wording lives in input.js.
//
// Settings (Netlify site > Environment variables):
//   GEMINI_API_KEY  required. Never logged or sent back.
//   GEMINI_MODEL    optional, default 'gemini-3.5-flash'.
// No npm packages: Node 18+ has fetch built in.
// --------------------------------------------------------------------

const DEFAULT_MODEL = 'gemini-3.5-flash';
const MAX_BODY_BYTES = 6 * 1024 * 1024;   // about 6 MB, Netlify's own limit
const THINKING_BUDGET = 0;                // 0 = no thinking step (fastest)
const GEMINI_TIMEOUT_MS = 24000;          // give up on Gemini after 24 s
                                          // (Netlify stops a function at 26 s)
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// The instruction we send to Gemini together with the photo.
// It must answer with ONLY a JSON object in exactly this shape.
// This is the ONLY copy of the prompt. input.js checks the answer.
const RECEIPT_PROMPT =
  'You are reading a photo of a restaurant receipt. ' +
  'Reply with ONLY a JSON object, no explanation and no markdown, in exactly this shape: ' +
  '{"items":[{"name":string,"qty":number,"price":string}],"tax":string|null,"currency":string}. ' +
  'Rules: one entry per purchased line. "price" is the LINE TOTAL exactly as printed on that line ' +
  '(not the unit price), written as a STRING with a dot and exactly 2 decimals, like "12.50" or "4.00". "qty" is the quantity on that line, 1 if none is shown. ' +
  'Do NOT include subtotal, total (e.g. YHTEENSÄ), VAT/ALV summary, tip, card or cash payment (e.g. KORTTI, KÄTEINEN) ' +
  'or change (e.g. TAKAISIN) lines as items. ' +
  'A discount line (e.g. "Alennus ... -2,00") is never its own item: subtract it from the price of the item line ' +
  'directly above it. Never return a negative price. ' +
  '"tax" is a separately added tax amount (a string like "3.20") only if the receipt adds tax on top of the items; ' +
  'if prices already include VAT (as in Finland) use null. ' +
  '"currency" is the ISO 4217 code such as "EUR". If unsure of the currency, use "EUR".';

// Small helper: send a JSON answer with a status code.
function reply(status, data) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// Check the request and return { image_base64, mime_type },
// or a ready-made error Response if something is wrong.
async function readRequest(req) {
  if (req.method !== 'POST') {
    return { problem: reply(405, { error: 'method_not_allowed' }) };
  }
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) {
    return { problem: reply(413, { error: 'too_large' }) };
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return { problem: reply(413, { error: 'too_large' }) };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return { problem: reply(400, { error: 'bad_request' }) };
  }
  const ok = body && typeof body === 'object' &&
    typeof body.image_base64 === 'string' && body.image_base64.length > 0 &&
    ALLOWED_TYPES.includes(body.mime_type);
  if (!ok) {
    return { problem: reply(400, { error: 'bad_request' }) };
  }
  // Copy only the two fields we use; anything else the client sent is ignored.
  return { image_base64: body.image_base64, mime_type: body.mime_type };
}

// Build the request body for Gemini: our prompt plus the photo.
// thinkingBudget 0 turns off the model's slow "thinking" step, so it
// answers fast enough for Netlify's time limit.
function geminiBody(input) {
  return {
    contents: [{
      parts: [
        { text: RECEIPT_PROMPT },
        { inline_data: { mime_type: input.mime_type, data: input.image_base64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
      thinkingConfig: { thinkingBudget: THINKING_BUDGET }
    }
  };
}

// Pull the answer text out of Gemini's reply. Returns { text } or { error }.
function extractText(data) {
  if (data && data.promptFeedback && data.promptFeedback.blockReason) {
    return { error: 'blocked', reason: String(data.promptFeedback.blockReason) };
  }
  const candidate = data && data.candidates && data.candidates[0];
  const finish = candidate && candidate.finishReason;
  if (finish === 'SAFETY') return { error: 'safety' };
  if (finish === 'MAX_TOKENS') return { error: 'max_tokens' };

  // The answer can be split over several parts: glue all the text together.
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  let text = '';
  for (const part of parts) {
    if (part && typeof part.text === 'string') text += part.text;
  }
  if (text.trim() === '') return { error: 'empty' };
  return { text: text };
}

export default async function handler(req) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    // The site is deployed but nobody set the key yet.
    return reply(503, { error: 'not_configured' });
  }

  const input = await readRequest(req);
  if (input.problem) return input.problem;

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';

  let res;
  let data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(geminiBody(input)),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
    });
    if (res.ok) data = await res.json();
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    // Log only the error kind. Never log the key, the request or headers.
    console.log('parse-receipt: Gemini call failed:', timedOut ? 'timeout' : (e && e.name));
    return reply(timedOut ? 504 : 502, { error: timedOut ? 'timeout' : 'unreachable' });
  }

  if (!res.ok) {
    console.log('parse-receipt: Gemini answered status', res.status);
    // Pass 429 and 503 through as-is. Everything else becomes 502, so a
    // Gemini 404 (bad model name) can't be mistaken for "no function here".
    const status = res.status === 429 || res.status === 503 ? res.status : 502;
    return reply(status, { error: 'gemini_http', geminiStatus: res.status });
  }

  const result = extractText(data);
  if (result.error) return reply(502, result);
  return reply(200, { text: result.text });
}
