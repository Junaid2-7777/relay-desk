import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBill } from './bill.mjs';
import { openBillFixture } from './bill-fixture.mjs';
import { DeskError, openDesk } from './desk.mjs';
import { runReceipt, ReceiptPlanError } from './receipt.mjs';
import { openReceiptFixture } from './receipt-fixture.mjs';
import { openRefundFixture } from './refund-fixture.mjs';
import { runVisit } from './visit.mjs';
import { openVisitFixture } from './visit-fixture.mjs';

const assets = new Map([
  ['/', ['../public/index.html', 'text/html']],
  ['/desk.css', ['../public/desk.css', 'text/css']],
  ['/desk.mjs', ['../public/desk.mjs', 'text/javascript']],
  ['/household.mjs', ['../public/household.mjs', 'text/javascript']],
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

export function createDeskServer({
  dataDir, clock, fixtureMode = false, householdMode = false, reset = false, warm = true
} = {}) {
  if (householdMode) fixtureMode = true;
  dataDir ??= resolve(fixtureMode ? '.relay/demo' : '.relay');
  const refundFixture = fixtureMode ? openRefundFixture({ dataDir, clock }) : undefined;
  const household = householdMode ? {
    bill: { fixture: openBillFixture({ dataDir, clock }), run: runBill },
    visit: { fixture: openVisitFixture({ dataDir, clock }), run: runVisit },
    receipt: { fixture: openReceiptFixture({ dataDir, clock }), run: runReceipt }
  } : undefined;
  const desk = openDesk({ dataDir, clock, refundFixture, household });
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
      if (method === 'GET' && pathname === '/api/fixture/refund' && refundFixture) {
        return send(response, 200, refundFixture.inspect());
      }
      if (household && method === 'GET') {
        const provider = /^\/api\/fixture\/(visit|bill|receipt)$/.exec(pathname);
        if (provider) return send(response, 200, household[provider[1]].fixture.inspect());
      }
      if (household && method === 'POST' && pathname === '/api/checkpoint') {
        const { checkpointId } = await jsonBody(request);
        return send(response, 200, desk.checkpoint(checkpointId));
      }
      if (method === 'POST' && pathname === '/api/errands/preview') {
        return send(response, 200, desk.preview((await jsonBody(request)).note));
      }
      if (method === 'POST' && pathname === '/api/errands') {
        return send(response, 201, desk.save(await jsonBody(request)));
      }
      const errand = /^\/api\/errands\/([\w-]+)(\/draft)?$/.exec(pathname);
      if (errand && method === 'PUT' && !errand[2]) return send(response, 200, desk.edit(errand[1], await jsonBody(request)));
      if (errand && method === 'POST' && errand[2]) return send(response, 200, desk.draft(errand[1]));
      const tracking = /^\/api\/errands\/([\w-]+)\/tracking$/.exec(pathname);
      if (tracking && method === 'POST') return send(response, 200, desk.tracking(tracking[1], await jsonBody(request)));
      const refund = /^\/api\/errands\/([\w-]+)\/(refund-access|check-refund)$/.exec(pathname);
      if (refundFixture && refund && method === 'POST') {
        const [, id, action] = refund;
        const body = await jsonBody(request);
        return send(response, 200, action === 'refund-access' ? desk.refundAccess(id, body) : desk.checkRefund(id, body.checkpointId));
      }
      const decision = /^\/api\/errands\/([\w-]+)\/(household-access|bill-choice|setup)$/.exec(pathname);
      if (household && decision && method === 'POST') {
        const [, id, action] = decision;
        const body = await jsonBody(request);
        if (action === 'setup') return send(response, 200, desk.setup(id, body));
        return send(response, 200, action === 'bill-choice' ? desk.billChoice(id, body) : desk.householdAccess(id, body));
      }
      throw new DeskError('This page could not be found.', 404);
    } catch (error) {
      const status = error instanceof ReceiptPlanError ? 400 : error.status;
      if (!status) console.error(error);
      send(response, status ?? 500, { error: status ? error.message : 'Relay Desk could not finish this request.' });
    }
  });
  if (reset && refundFixture) {
    server.once('listening', () => {
      try {
        refundFixture.reset();
        desk.resetRefund(householdMode && warm);
        if (household) {
          household.bill.fixture.reset();
          household.visit.fixture.reset();
          household.receipt.fixture.reset();
          desk.resetHousehold(warm);
        }
      } catch (error) {
        server.close();
        server.emit('error', error);
      }
    });
  }
  server.once('close', () => {
    desk.close();
    refundFixture?.close();
    household?.bill.fixture.close();
    household?.visit.fixture.close();
    household?.receipt.fixture.close();
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const fixtureMode = process.argv.includes('--fixture');
  const dataDir = process.env.RELAY_DATA_DIR ?? resolve(fixtureMode ? '.relay/demo' : '.relay');
  const fixedTime = process.env.RELAY_CLOCK ?? (fixtureMode ? '2026-11-23T09:00:00+05:30' : undefined);
  const clock = fixedTime ? () => new Date(fixedTime) : undefined;
  if (clock && !Number.isFinite(+clock())) throw new Error('RELAY_CLOCK must be a date or an ISO timestamp.');
  const port = Number(process.env.RELAY_PORT ?? 4173);
  const server = createDeskServer({
    dataDir, clock, fixtureMode, householdMode: fixtureMode, reset: process.argv.includes('--reset'),
    warm: !process.argv.includes('--cold')
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Relay Desk is open at http://127.0.0.1:${server.address().port}`);
  });
}
