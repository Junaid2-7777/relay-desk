import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeskError, openDesk } from './desk.mjs';

const assets = new Map([
  ['/', ['../public/index.html', 'text/html']],
  ['/desk.css', ['../public/desk.css', 'text/css']],
  ['/desk.mjs', ['../public/desk.mjs', 'text/javascript']],
  ['/wordmark.svg', ['../docs/brand/wordmark.svg', 'image/svg+xml']],
  ['/mark.svg', ['../docs/brand/mark.svg', 'image/svg+xml']]
]);

function send(response, status, content, type = 'application/json') {
  response.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  response.end(type === 'application/json' ? JSON.stringify(content) : content);
}

async function jsonBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new DeskError('Use a JSON request.', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new DeskError('This request is too large.', 413);
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DeskError('This request is not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeskError('Send a JSON object.');
  }
  return value;
}

export function createDeskServer({ dataDir = resolve('.relay'), clock } = {}) {
  const desk = openDesk({ dataDir, clock });
  const server = createServer(async (request, response) => {
    try {
      const { host, origin } = request.headers;
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host ?? '') || (origin && origin !== `http://${host}`)) {
        throw new DeskError('Open Relay Desk on this computer.', 403);
      }
      const { pathname } = new URL(request.url, `http://${host}`);
      const { method } = request;
      if (method === 'GET' && assets.has(pathname)) {
        const [file, type] = assets.get(pathname);
        return send(response, 200, await readFile(new URL(file, import.meta.url)), type);
      }
      if (method === 'GET' && pathname === '/api/desk') return send(response, 200, desk.brief());
      if (method === 'GET' && pathname === '/api/inspect') return send(response, 200, desk.inspect());
      if (method === 'POST' && pathname === '/api/errands/preview') {
        return send(response, 200, desk.preview((await jsonBody(request)).note));
      }
      if (method === 'POST' && pathname === '/api/errands') {
        return send(response, 201, desk.save(await jsonBody(request)));
      }
      const errand = /^\/api\/errands\/([\w-]+)(\/draft)?$/.exec(pathname);
      if (errand && method === 'PUT' && !errand[2]) return send(response, 200, desk.edit(errand[1], await jsonBody(request)));
      if (errand && method === 'POST' && errand[2]) return send(response, 200, desk.draft(errand[1]));
      throw new DeskError('This page could not be found.', 404);
    } catch (error) {
      if (!(error instanceof DeskError)) console.error(error);
      send(response, error.status ?? 500, { error: error.status ? error.message : 'Relay Desk could not finish this request.' });
    }
  });
  server.once('close', () => desk.close());
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const dataDir = process.env.RELAY_DATA_DIR ?? resolve('.relay');
  const clock = process.env.RELAY_CLOCK ? () => new Date(process.env.RELAY_CLOCK) : undefined;
  if (clock && !Number.isFinite(+clock())) throw new Error('RELAY_CLOCK must be a date or an ISO timestamp.');
  const port = Number(process.env.RELAY_PORT ?? 4173);
  const server = createDeskServer({ dataDir, clock });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Relay Desk is open at http://127.0.0.1:${server.address().port}`);
  });
}
