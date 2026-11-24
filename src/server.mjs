import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zonedInstant } from '../shared/evidence-time.mjs';
import { runBill } from './bill.mjs';
import { openBillFixture } from './bill-fixture.mjs';
import { DeskError, openDesk } from './desk.mjs';
import { createN8nPlannerFromEnv } from './n8n-planner.mjs';
import { openOutboxFixture } from './outbox-fixture.mjs';
import { checkReceipt, ReceiptPlanError } from './receipt.mjs';
import { openReceiptFixture } from './receipt-fixture.mjs';
import { createRecordedPlanner } from './recorded-planner.mjs';
import { openRefundFixture } from './refund-fixture.mjs';
import { runVisit } from './visit.mjs';
import { openVisitFixture } from './visit-fixture.mjs';

const assets = new Map([
  ['/', ['../public/index.html', 'text/html']],
  ['/desk.css', ['../public/desk.css', 'text/css']],
  ['/desk.mjs', ['../public/desk.mjs', 'text/javascript']],
  ['/shared/brief-order.mjs', ['../shared/brief-order.mjs', 'text/javascript']],
  ['/shared/evidence-time.mjs', ['../shared/evidence-time.mjs', 'text/javascript']],
  ['/household.mjs', ['../public/household.mjs', 'text/javascript']],
  ['/wordmark.svg', ['../docs/brand/wordmark.svg', 'image/svg+xml']],
  ['/mark.svg', ['../docs/brand/mark.svg', 'image/svg+xml']]
]);
const practiceDirectories = new Map([
  ['recorded-response', '.relay/demo-recorded'],
  ['n8n', '.relay/demo-n8n']
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
  dataDir, clock, fixtureMode = false, householdMode = false, reset = false, warm = true, planner
} = {}) {
  if (planner && !householdMode) throw new TypeError('Use planner proposals in the practice household.');
  if (householdMode) fixtureMode = true;
  const plannerMode = planner?.mode ?? 'fixed-rule';
  function checkPlannerMode(expected, preview) {
    if ((expected !== undefined || (preview && plannerMode === 'n8n')) && expected !== plannerMode) {
      throw new DeskError('The planner changed. Reload the desk to review where your note will go.', 409);
    }
  }
  dataDir ??= resolve(fixtureMode ? (practiceDirectories.get(planner?.mode) ?? '.relay/demo') : '.relay');
  const refundFixture = fixtureMode ? openRefundFixture({ dataDir, clock }) : undefined;
  const household = householdMode ? {
    bill: { fixture: openBillFixture({ dataDir, clock }), run: runBill },
    visit: { fixture: openVisitFixture({ dataDir, clock }), run: runVisit },
    receipt: { fixture: openReceiptFixture({ dataDir, clock }), run: checkReceipt },
    outbox: { fixture: openOutboxFixture({ dataDir, clock }) }
  } : undefined;
  const desk = openDesk({ dataDir, clock, refundFixture, household, planner });
  async function checkedBody(request) {
    const body = await jsonBody(request);
    desk.checkDeskContext();
    return body;
  }
  async function serve(request, response) {
    try {
      const { host, origin } = request.headers;
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host ?? '') || (origin && origin !== `http://${host}`)) {
        throw new DeskError('Open Relay Desk on this computer.', 403);
      }
      const { pathname } = new URL(request.url, `http://${host}`);
      const { method } = request;
      if (pathname.startsWith('/api/')) desk.checkDeskContext();
      if (method === 'GET' && assets.has(pathname)) {
        const [file, type] = assets.get(pathname);
        return send(response, 200, await readFile(new URL(file, import.meta.url)), type);
      }
      if (method === 'GET' && pathname === '/api/desk') return send(response, 200, desk.readWithContext(desk.brief));
      if (method === 'GET' && pathname === '/api/inspect') return send(response, 200, desk.readWithContext(desk.inspect));
      if (method === 'GET' && pathname === '/api/fixture/refund' && refundFixture) {
        return send(response, 200, desk.readWithContext(refundFixture.inspect));
      }
      if (household && method === 'GET') {
        const provider = /^\/api\/fixture\/(visit|bill|receipt|outbox)$/.exec(pathname);
        if (provider) return send(response, 200, desk.readWithContext(household[provider[1]].fixture.inspect));
      }
      if (household && method === 'POST' && pathname === '/api/checkpoint') {
        const { checkpointId } = await checkedBody(request);
        return send(response, 200, desk.checkpoint(checkpointId));
      }
      if (method === 'POST' && pathname === '/api/errands/preview') {
        const { note, plannerMode: expected } = await checkedBody(request);
        checkPlannerMode(expected, true);
        const preview = await desk.preview(note);
        desk.checkDeskContext();
        return send(response, 200, preview);
      }
      if (method === 'POST' && pathname === '/api/errands') {
        const body = await checkedBody(request);
        checkPlannerMode(body.plannerMode, false);
        return send(response, 201, desk.save(body));
      }
      const errand = /^\/api\/errands\/([\w-]+)(?:\/(draft|local-draft))?$/.exec(pathname);
      if (errand && method === 'PUT' && !errand[2]) return send(response, 200, desk.edit(errand[1], await checkedBody(request)));
      if (errand && method === 'POST' && errand[2] === 'draft') return send(response, 200, desk.readWithContext(() => desk.draft(errand[1])));
      if (errand && method === 'PUT' && errand[2] === 'local-draft') {
        return send(response, 200, desk.saveLocalDraft(errand[1], await checkedBody(request)));
      }
      const followup = /^\/api\/errands\/([\w-]+)\/queue-followup$/.exec(pathname);
      if (household && followup && method === 'POST') {
        return send(response, 200, desk.queueFollowup(followup[1], await checkedBody(request)));
      }
      const tracking = /^\/api\/errands\/([\w-]+)\/tracking$/.exec(pathname);
      if (tracking && method === 'POST') return send(response, 200, desk.tracking(tracking[1], await checkedBody(request)));
      const refund = /^\/api\/errands\/([\w-]+)\/(refund-access|check-refund)$/.exec(pathname);
      if (refundFixture && refund && method === 'POST') {
        const [, id, action] = refund;
        const body = await checkedBody(request);
        return send(response, 200, action === 'refund-access' ? desk.refundAccess(id, body) : desk.checkRefund(id, body.checkpointId));
      }
      const decision = /^\/api\/errands\/([\w-]+)\/(household-access|bill-choice|visit-choice|setup)$/.exec(pathname);
      if (household && decision && method === 'POST') {
        const [, id, action] = decision;
        const body = await checkedBody(request);
        if (action === 'setup') return send(response, 200, desk.setup(id, body));
        if (action === 'visit-choice') return send(response, 200, desk.visitChoice(id, body));
        return send(response, 200, action === 'bill-choice' ? desk.billChoice(id, body) : desk.householdAccess(id, body));
      }
      throw new DeskError('This page could not be found.', 404);
    } catch (error) {
      const status = error instanceof ReceiptPlanError ? 400 : error.status;
      if (!status) console.error(error);
      send(response, status ?? 500, {
        error: status ? error.message : 'Relay Desk could not finish this request.',
        ...(error instanceof DeskError && error.code ? { code: error.code } : {})
      });
    }
  }
  const server = createServer((request, response) =>
    desk.withDeskContext(request.headers['x-relay-desk'], () => serve(request, response)));
  if (reset && refundFixture) {
    server.once('listening', () => {
      try {
        desk.resetPractice(warm, () => {
          refundFixture.reset();
          if (household) {
            household.bill.fixture.reset();
            household.visit.fixture.reset();
            household.receipt.fixture.reset();
            household.outbox.fixture.reset();
          }
        });
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
    household?.outbox.fixture.close();
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const fixtureMode = process.argv.includes('--fixture');
  const recorded = process.argv.includes('--recorded');
  const n8n = process.argv.includes('--n8n');
  if ((recorded || n8n) && !fixtureMode) throw new Error('Use --recorded or --n8n with the practice household.');
  if (recorded && n8n) throw new Error('Choose one practice planner mode.');
  const dataDir = process.env.RELAY_DATA_DIR;
  const fixedTime = process.env.RELAY_CLOCK ?? (fixtureMode ? '2026-11-23T09:00:00+05:30' : undefined);
  let clock;
  if (fixedTime !== undefined) {
    const instant = zonedInstant(fixedTime);
    if (!Number.isFinite(instant)) throw new Error('Set RELAY_CLOCK to a valid ISO timestamp with an explicit offset.');
    clock = () => new Date(instant);
  }
  let planner;
  if (recorded) {
    const { cases } = JSON.parse(await readFile(new URL('../fixtures/planner-rehearsal.json', import.meta.url), 'utf8'));
    planner = createRecordedPlanner(cases.map(({ note, recordedProposal }) => ({ note, recordedProposal })));
  } else if (n8n) {
    planner = createN8nPlannerFromEnv();
  }
  const port = Number(process.env.RELAY_PORT ?? 4173);
  const server = createDeskServer({
    dataDir, clock, fixtureMode, householdMode: fixtureMode, reset: process.argv.includes('--reset'),
    warm: !process.argv.includes('--cold'), planner
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Relay Desk is open at http://127.0.0.1:${server.address().port}`);
  });
}
