#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const apiDir = path.join(rootDir, 'api');
const port = Number(process.env.PORT || process.env.npm_config_port || 3000);

function parseEnvValue(rawValue) {
  let value = String(rawValue || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\n/g, '\n');
}

async function loadEnvFile(filename, override = false) {
  const filePath = path.join(rootDir, filename);
  if (!existsSync(filePath)) return;
  const text = await readFile(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const clean = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = clean.indexOf('=');
    if (eq <= 0) continue;
    const key = clean.slice(0, eq).trim();
    const value = parseEnvValue(clean.slice(eq + 1));
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

await loadEnvFile('.env', false);
await loadEnvFile('.env.local', true);
// Fallback utili su Windows quando il file viene creato senza punto iniziale
// o con estensione .txt nascosta da Esplora file.
await loadEnvFile('env.local', true);
await loadEnvFile('.env.local.txt', true);

function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return 'no';
  if (text.length <= 8) return 'si';
  return `si (${text.slice(0, 4)}...${text.slice(-4)})`;
}


const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = statusCode;
  if (contentType) res.setHeader('Content-Type', contentType);
  res.end(body);
}

function createVercelLikeResponse(res) {
  const apiRes = {
    status(code) {
      res.statusCode = code;
      return apiRes;
    },
    setHeader(name, value) {
      res.setHeader(name, value);
      return apiRes;
    },
    send(body = '') {
      if (!res.writableEnded) res.end(body);
      return apiRes;
    },
    json(payload) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (!res.writableEnded) res.end(JSON.stringify(payload));
      return apiRes;
    },
    end(body = '') {
      if (!res.writableEnded) res.end(body);
      return apiRes;
    },
  };
  return apiRes;
}

async function collectBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, url) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const routeName = path.basename(url.pathname).replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(apiDir, `${routeName}.js`);
  if (!existsSync(filePath)) {
    send(res, 404, JSON.stringify({ ok: false, error: 'Endpoint API non trovato in locale' }), 'application/json; charset=utf-8');
    return;
  }

  const query = Object.fromEntries(url.searchParams.entries());
  const reqShim = Object.assign(req, { query, body: null });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const rawBody = await collectBody(req);
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.includes('application/json')) {
      try {
        reqShim.body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        reqShim.body = rawBody;
      }
    } else {
      reqShim.body = rawBody;
    }
  }

  try {
    const moduleUrl = pathToFileURL(filePath).href;
    const handler = (await import(moduleUrl)).default;
    if (typeof handler !== 'function') {
      throw new Error(`Il file ${routeName}.js non esporta un handler default`);
    }
    await handler(reqShim, createVercelLikeResponse(res));
  } catch (err) {
    console.error(`[api/${routeName}]`, err);
    if (!res.writableEnded) {
      send(
        res,
        500,
        JSON.stringify({ ok: false, error: err?.message || 'Errore API locale' }),
        'application/json; charset=utf-8'
      );
    }
  }
}

async function resolveStaticFile(pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const safePath = path.normalize(decodedPath).replace(/^([.][.][/\\])+/, '');
  const candidates = [];

  if (safePath === '/' || safePath === '') {
    candidates.push(path.join(publicDir, 'index.html'));
  } else {
    candidates.push(path.join(publicDir, safePath));
    if (!path.extname(safePath)) {
      candidates.push(path.join(publicDir, `${safePath}.html`));
      candidates.push(path.join(publicDir, safePath, 'index.html'));
    }
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(publicDir)) continue;
    try {
      const info = await stat(resolved);
      if (info.isFile()) return resolved;
    } catch {
      // Prova il candidato successivo.
    }
  }
  return null;
}

async function handleStatic(req, res, url) {
  const filePath = await resolveStaticFile(url.pathname);
  if (!filePath) {
    send(res, 404, 'Pagina non trovata');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const body = await readFile(filePath);
  send(res, 200, body, mimeTypes[ext] || 'application/octet-stream');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${port}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await handleStatic(req, res, url);
  } catch (err) {
    console.error('[local-dev]', err);
    if (!res.writableEnded) send(res, 500, 'Errore server locale');
  }
});

server.listen(port, () => {
  console.log(`PrezzoFuel locale avviato: http://localhost:${port}`);
  console.log(`OCM_API_KEY caricata: ${maskSecret(process.env.OCM_API_KEY)}`);
  console.log('API locali disponibili su /api/*. Usa .env.local per OCM_API_KEY e feed tariffe opzionali.');
});
