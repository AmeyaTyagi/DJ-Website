#!/usr/bin/env node
'use strict';

/**
 * Blend Room dev server — no dependencies, just Node.
 *
 *   node server.js            serve on http://localhost:5173
 *   node server.js --open     ...and open the browser
 *   node server.js --no-reload   serve without the live-reload injection
 *   PORT=8080 node server.js  pick the port
 *
 * Any file you save in this folder reloads the open tab.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const START_PORT = Number(process.env.PORT) || 5173;
const OPEN = process.argv.includes('--open') || process.argv.includes('-o');
const RELOAD = !process.argv.includes('--no-reload');
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.webm': 'video/webm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

const RELOAD_CLIENTS = new Set();

const RELOAD_SNIPPET = `
<script>
/* injected by server.js — dev only, never part of the saved file */
(function(){
  if(!window.EventSource) return;
  var es = new EventSource('/__reload');
  es.addEventListener('message', function(e){ if(e.data === 'reload') location.reload(); });
})();
</script>
`;

function serveReloadStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 500\n\n');
  RELOAD_CLIENTS.add(res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* gone */ }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    RELOAD_CLIENTS.delete(res);
  });
}

function notifyReload(what) {
  if (!RELOAD_CLIENTS.size) return;
  for (const res of RELOAD_CLIENTS) {
    try { res.write('data: reload\n\n'); } catch { RELOAD_CLIENTS.delete(res); }
  }
  console.log(`  reload  ${what}  →  ${RELOAD_CLIENTS.size} tab(s)`);
}

/* ---------------------------------------------------------------- network sources
 * The browser can't fetch a stranger's mp3 and read its bytes — cross-origin rules
 * stop it. Your own server has no such limit, so it fetches and hands the bytes over.
 * Private and loopback addresses are refused so a page can't aim this at your LAN.
 */
const BLOCKED_HOST = new RegExp(
  '^(?:' + [
    'localhost',
    '\\[?::1\\]?',
    '.*\\.local',
    '.*\\.internal',
    '(?:127|10|0)\\.\\d+\\.\\d+\\.\\d+',
    '169\\.254\\.\\d+\\.\\d+',
    '192\\.168\\.\\d+\\.\\d+',
    '172\\.(?:1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+',
    '100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d+\\.\\d+'
  ].join('|') + ')$', 'i'
);

/**
 * 45 MB is about the practical ceiling: decodeAudioData expands to 32-bit float
 * PCM, so a 45 MB mp3 already lands near 700 MB of RAM in the tab.
 */
const MAX_AUDIO_BYTES = 45 * 1024 * 1024;

function fetchUpstream(rawUrl, res, { maxBytes = MAX_AUDIO_BYTES } = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return sendError(res, 400, 'That is not a URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return sendError(res, 400, 'Only http and https.');
  }
  if (BLOCKED_HOST.test(u.hostname)) {
    return sendError(res, 403, 'Refusing to fetch a private or loopback address.');
  }

  console.log(`  fetch   ${u.href}`);
  const started = Date.now();

  // A request can fail more than once — a timeout destroys the socket, which then
  // emits an error too. Only the first outcome may write a response.
  let settled = false;
  const fail = (status, message) => {
    if (settled || res.headersSent) return;
    settled = true;
    sendError(res, status, message);
  };

  const once = (url, hops, tries) => {
    if (settled) return;
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'blend-room/1.0 (local dev server)', 'Accept': '*/*' },
      timeout: 25000
    }, (up) => {
      if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location && hops < 5) {
        up.resume();
        let next;
        try { next = new URL(up.headers.location, url); } catch { return fail(502, 'Bad redirect.'); }
        if (BLOCKED_HOST.test(next.hostname)) return fail(403, 'Redirect pointed at a private address.');
        return once(next, hops + 1, tries);
      }
      // The Archive answers 503 when it wants you to slow down, and usually
      // serves the same URL happily a second later.
      if ((up.statusCode === 503 || up.statusCode === 429) && tries < 3) {
        up.resume();
        const wait = 900 * tries;
        console.log(`  busy    ${up.statusCode} from ${url.host}, retrying in ${wait} ms`);
        return setTimeout(() => once(url, hops, tries + 1), wait);
      }
      if (up.statusCode !== 200 && up.statusCode !== 206) {
        up.resume();
        console.log(`  upstream ${up.statusCode} from ${url.host}`);
        return fail(502, up.statusCode === 503
          ? 'The Archive is throttling requests right now — give it a few seconds and try again.'
          : `Upstream said ${up.statusCode}.`);
      }
      const len = Number(up.headers['content-length'] || 0);
      if (len > maxBytes) {
        up.destroy();
        console.log(`  too big ${(len / 1048576).toFixed(0)} MB`);
        return fail(413,
          `That file is ${(len / 1048576).toFixed(0)} MB. The limit is ${(maxBytes / 1048576).toFixed(0)} MB — ` +
          `decoding expands audio about 15&times; in memory, so a longer mix would take the tab down.`);
      }

      settled = true;
      res.writeHead(200, {
        'Content-Type': up.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        ...(up.headers['content-length'] ? { 'Content-Length': up.headers['content-length'] } : {})
      });
      let seen = 0;
      up.on('data', (c) => {
        seen += c.length;
        if (seen > maxBytes) { up.destroy(); res.end(); }
      });
      up.on('end', () => console.log(`  got     ${(seen / 1048576).toFixed(1)} MB in ${Date.now() - started} ms`));
      up.pipe(res);
    });
    req.on('timeout', () => { req.destroy(); fail(504, 'Upstream timed out.'); });
    req.on('error', (e) => fail(502, `Could not reach it: ${e.message}`));
  };
  once(u, 0, 1);
}

/**
 * The Archive throttles hard when you ask repeatedly, answering 503 or simply
 * hanging, so every metadata call gets three goes with a widening gap.
 */
function fetchJson(url, tries = 1) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const give = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const retryOr = (err) => {
      if (tries < 3) {
        const wait = 800 * tries;
        console.log(`  busy    ${err.message} — retrying in ${wait} ms`);
        return setTimeout(() => fetchJson(url, tries + 1).then(resolve, reject), wait);
      }
      give(reject, err);
    };

    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'blend-room/1.0 (local dev server)', 'Accept': 'application/json' },
      timeout: 15000
    }, (up) => {
      if (up.statusCode === 503 || up.statusCode === 429 || up.statusCode >= 500) {
        up.resume();
        return retryOr(new Error(`upstream ${up.statusCode}`));
      }
      if (up.statusCode !== 200) {
        up.resume();
        return give(reject, new Error(`upstream ${up.statusCode}`));
      }
      let body = '';
      up.setEncoding('utf8');
      up.on('data', (c) => { body += c; if (body.length > 6e6) up.destroy(); });
      up.on('end', () => {
        try { give(resolve, JSON.parse(body)); } catch (e) { give(reject, new Error('bad JSON from upstream')); }
      });
    });
    req.on('timeout', () => { req.destroy(); retryOr(new Error('timed out')); });
    req.on('error', (e) => retryOr(e));
  });
}

/* ------------------------------------------------------------------ music library
 * Scanning a folder and serving files out of it is exactly the kind of thing a
 * public server must never do, which is why this one binds to 127.0.0.1 only and
 * will serve a file only from under a directory you explicitly scanned first.
 */
const AUDIO_EXT = /\.(mp3|wav|m4a|flac|ogg|opus|aac|aiff?|wma)$/i;
const SCANNED_ROOTS = new Set();

function libSuggest(res) {
  const home = require('os').homedir();
  const guesses = [
    path.join(home, 'Music'),
    path.join(home, 'Downloads'),
    path.join(home, 'OneDrive', 'Music'),
    path.join(home, 'Desktop')
  ];
  const found = [];
  for (const g of guesses) {
    try { if (fs.statSync(g).isDirectory()) found.push(g); } catch { /* not there */ }
  }
  sendJson(res, { home, folders: found });
}

function libScan(dir, res) {
  let root;
  try {
    root = fs.realpathSync(dir);
    if (!fs.statSync(root).isDirectory()) return sendError(res, 400, 'That is a file, not a folder.');
  } catch {
    return sendError(res, 404, `No folder at <code>${dir}</code>.`);
  }

  const files = [];
  const MAX = 4000;
  let truncated = false;
  const walk = (d, depth) => {
    if (files.length >= MAX || depth > 8) { truncated = truncated || files.length >= MAX; return; }
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX) { truncated = true; return; }
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && AUDIO_EXT.test(e.name)) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* skip */ }
        files.push({ rel: path.relative(root, full).replace(/\\/g, '/'), name: e.name, size });
      }
    }
  };
  walk(root, 0);

  SCANNED_ROOTS.add(root);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  console.log(`  library scan ${root} → ${files.length} audio file(s)${truncated ? ' (capped)' : ''}`);
  sendJson(res, { root, count: files.length, truncated, files });
}

function libFile(root, rel, res) {
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return sendError(res, 400, 'Unknown root.'); }
  if (!SCANNED_ROOTS.has(realRoot)) {
    return sendError(res, 403, 'That folder has not been scanned in this session.');
  }
  let full;
  try {
    full = fs.realpathSync(path.join(realRoot, rel));
  } catch {
    return sendError(res, 404, 'No such file.');
  }
  // realpath both sides, so a symlink cannot walk out of the scanned folder
  if (full !== realRoot && !full.startsWith(realRoot + path.sep)) {
    return sendError(res, 403, 'That path escapes the scanned folder.');
  }
  if (!AUDIO_EXT.test(full)) return sendError(res, 403, 'Not an audio file.');

  let stat;
  try { stat = fs.statSync(full); } catch { return sendError(res, 404, 'No such file.'); }
  if (stat.size > MAX_AUDIO_BYTES) {
    return sendError(res, 413, `That file is ${(stat.size / 1048576).toFixed(0)} MB, over the ${(MAX_AUDIO_BYTES / 1048576).toFixed(0)} MB decode limit.`);
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(full).on('error', () => res.end()).pipe(res);
}

/* ---------------------------------------------------------------- model storage */
const MODEL_FILE = path.join(ROOT, 'dj-model.json');

function modelRead(res) {
  fs.readFile(MODEL_FILE, 'utf8', (err, text) => {
    if (err) return sendJson(res, { model: null });
    try { sendJson(res, { model: JSON.parse(text) }); }
    catch { sendJson(res, { model: null, error: 'dj-model.json is not valid JSON' }); }
  });
}

function modelWrite(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
  req.on('end', () => {
    try { JSON.parse(body); } catch { return sendError(res, 400, 'That is not JSON.'); }
    fs.writeFile(MODEL_FILE, body, 'utf8', (err) => {
      if (err) return sendError(res, 500, err.message);
      console.log(`  model   saved ${(body.length / 1024).toFixed(1)} kB → dj-model.json`);
      sendJson(res, { saved: true, bytes: body.length });
    });
  });
}

function sendJson(res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Internet Archive: open catalogue, real API, no key needed. */
function iaSearch(q, res) {
  const url = 'https://archive.org/advancedsearch.php'
    // format:(MP3) matters — plenty of audio items hold only a zip or a RAR,
    // which a browser cannot decode
    + '?q=' + encodeURIComponent(`(${q}) AND mediatype:(audio) AND format:(MP3)`)
    + '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=year'
    + '&rows=24&page=1&output=json';
  console.log(`  ia      search "${q}"`);
  fetchJson(url).then((j) => {
    const docs = (j && j.response && j.response.docs) || [];
    sendJson(res, {
      items: docs.map((d) => ({
        id: d.identifier,
        title: Array.isArray(d.title) ? d.title[0] : d.title,
        creator: Array.isArray(d.creator) ? d.creator[0] : d.creator,
        year: d.year
      })).filter((d) => d.id)
    });
  }).catch((e) => sendError(res, 502, `Archive search failed: ${e.message}`));
}

/** Pick one plainly-decodable file out of an item, preferring a small mp3. */
function iaFiles(id, res) {
  fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`).then((j) => {
    const files = (j && j.files) || [];
    const audio = files
      .filter((f) => /\.(mp3|ogg|m4a|wav|flac)$/i.test(f.name || ''))
      .map((f) => ({ name: f.name, size: Number(f.size || 0), fmt: f.format || '' }))
      .sort((a, b) => {
        const am = /\.mp3$/i.test(a.name) ? 0 : 1;
        const bm = /\.mp3$/i.test(b.name) ? 0 : 1;
        if (am !== bm) return am - bm;
        return a.size - b.size;
      });
    const fits = audio.filter((f) => f.size > 0 && f.size <= MAX_AUDIO_BYTES);
    const pick = fits[0];
    if (!pick) {
      const smallest = audio[0];
      return sendJson(res, {
        file: null,
        reason: smallest
          ? `everything in that item is over ${(MAX_AUDIO_BYTES / 1048576).toFixed(0)} MB (smallest is ${(smallest.size / 1048576).toFixed(0)} MB)`
          : 'that item has no plain audio file — probably a zip or a RAR'
      });
    }
    sendJson(res, {
      file: pick.name,
      size: pick.size,
      url: `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(pick.name)}`
    });
  }).catch((e) => sendError(res, 502, `Archive metadata failed: ${e.message}`));
}

function sendError(res, status, message) {
  const body = `<!doctype html><meta charset="utf-8"><title>${status}</title>` +
    `<body style="font:14px system-ui;padding:40px;color:#222;background:#faf9f7">` +
    `<h1 style="font-size:20px">${status}</h1><p>${message}</p>` +
    `<p><a href="/">Back to Blend Room</a></p>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveFile(res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  if (ext === '.html') {
    fs.readFile(filePath, 'utf8', (err, text) => {
      if (err) return sendError(res, 500, 'Could not read that file.');
      let out = text;
      if (RELOAD) {
        out = out.includes('</body>')
          ? out.replace('</body>', `${RELOAD_SNIPPET}</body>`)
          : out + RELOAD_SNIPPET;
      }
      const buf = Buffer.from(out, 'utf8');
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(filePath).on('error', () => res.end()).pipe(res);
}

const server = http.createServer((req, res) => {
  const isPost = req.method === 'POST';
  if (!isPost && req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'Only GET and POST here.');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    return sendError(res, 400, 'That URL could not be parsed.');
  }

  if (pathname === '/__reload') return serveReloadStream(req, res);
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (pathname.startsWith('/__')) {
    const params = new URL(req.url, `http://${HOST}`).searchParams;
    if (pathname === '/__caps') return sendJson(res, { proxy: true, ia: true, library: true, model: true, reload: RELOAD });
    if (pathname === '/__library/suggest') return libSuggest(res);
    if (pathname === '/__library/scan') {
      const dir = (params.get('dir') || '').trim();
      if (!dir) return sendError(res, 400, 'Pass a <code>dir</code>.');
      return libScan(dir, res);
    }
    if (pathname === '/__library/file') {
      const root = (params.get('root') || '').trim();
      const rel = (params.get('path') || '').trim();
      if (!root || !rel) return sendError(res, 400, 'Pass <code>root</code> and <code>path</code>.');
      return libFile(root, rel, res);
    }
    if (pathname === '/__model') return isPost ? modelWrite(req, res) : modelRead(res);
    if (isPost) return sendError(res, 405, 'That endpoint is GET only.');
    if (pathname === '/__proxy') {
      const target = params.get('url');
      if (!target) return sendError(res, 400, 'Pass a <code>url</code>.');
      return fetchUpstream(target, res);
    }
    if (pathname === '/__ia/search') {
      const q = (params.get('q') || '').trim();
      if (!q) return sendError(res, 400, 'Pass a <code>q</code>.');
      return iaSearch(q, res);
    }
    if (pathname === '/__ia/files') {
      const id = (params.get('id') || '').trim();
      if (!id) return sendError(res, 400, 'Pass an <code>id</code>.');
      return iaFiles(id, res);
    }
    return sendError(res, 404, 'No such endpoint.');
  }

  const target = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  const resolved = path.resolve(target);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return sendError(res, 403, 'That path is outside the project folder.');
  }

  fs.stat(resolved, (err, stat) => {
    if (err) return sendError(res, 404, `Nothing at <code>${pathname}</code>.`);
    if (stat.isDirectory()) {
      const index = path.join(resolved, 'index.html');
      return fs.stat(index, (e2, s2) => {
        if (e2) return sendError(res, 404, 'No index.html in that folder.');
        serveFile(res, index, s2);
      });
    }
    serveFile(res, resolved, stat);
  });
});

function watch() {
  if (!RELOAD) return;
  const IGNORE = /(^|[\\/])(\.git|\.vscode|node_modules)[\\/]|[\\/]~\$|\.(swp|tmp|crdownload)$/;
  let timer = null;
  try {
    fs.watch(ROOT, { recursive: true }, (_event, name) => {
      if (!name || IGNORE.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => notifyReload(String(name).replace(/\\/g, '/')), 90);
    });
  } catch (err) {
    console.log(`  (file watching unavailable: ${err.message})`);
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function listen(port, attempt) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 12) {
      console.log(`  port ${port} is busy, trying ${port + 1}…`);
      listen(port + 1, attempt + 1);
    } else {
      console.error(`  ${err.message}`);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.removeListener('error', onError);
    const url = `http://localhost:${port}/`;
    console.log('');
    console.log('  BLEND ROOM  ·  local dev server');
    console.log(`  ready on ${url}`);
    console.log(`  serving  ${ROOT}`);
    console.log(RELOAD ? '  live reload on — save a file and the tab refreshes' : '  live reload off');
    console.log('  stop with Ctrl+C');
    console.log('');
    watch();
    if (OPEN) openBrowser(url);
  });
}

// A dev server should complain and carry on, not take the whole session down.
process.on('uncaughtException', (err) => {
  console.error('  !! ' + ((err && err.message) ? err.message : err));
  if (err && err.stack) {
    console.error(String(err.stack).split(/\r?\n/).slice(1, 4).join('\n'));
  }
  console.error('  the server is still up — that request was dropped');
});

process.on('SIGINT', () => {
  console.log('\n  stopped.');
  process.exit(0);
});

console.log('  starting Blend Room server…');
listen(START_PORT, 0);
