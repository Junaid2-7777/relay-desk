import { readFile } from 'node:fs/promises';
import { createIntakePlanner } from '../src/intake-planner.mjs';
import { previewErrand, suggestPracticePlan } from '../src/intake.mjs';
import { createN8nPlannerFromEnv } from '../src/n8n-planner.mjs';

const template = new URL('../n8n/relay-desk-planner.json', import.meta.url);
const fields = ['RELAY_N8N_WEBHOOK_URL', 'RELAY_N8N_WEBHOOK_TOKEN'];
const failureMessages = {
  unavailable: 'The webhook did not return a successful response.',
  timeout: 'The webhook exceeded the planner deadline.',
  'invalid-proposal': 'The webhook response could not be used as a planner proposal.'
};

async function templateReady() {
  try {
    const workflow = JSON.parse(await readFile(template, 'utf8'));
    const nodes = [
      'n8n-nodes-base.webhook', '@n8n/n8n-nodes-langchain.openAi',
      'n8n-nodes-base.code', 'n8n-nodes-base.respondToWebhook'
    ].map(type => workflow.nodes.find(node => node.type === type));
    const [webhook, model, , response] = nodes;
    if (nodes.some(node => !node)) return false;
    const format = model.parameters.options.textFormat.textOptions;
    const schema = JSON.parse(format.schema);
    return webhook.parameters.httpMethod === 'POST' && webhook.parameters.authentication === 'headerAuth' &&
      webhook.parameters.responseMode === 'responseNode' && model.parameters.operation === 'response' &&
      model.parameters.options.store === false && format.type === 'json_schema' &&
      schema.type === 'object' && Array.isArray(schema.required) &&
      ['goal', 'checkDate', 'practicePlan'].every(field => schema.required.includes(field)) &&
      response.parameters.respondWith === 'firstIncomingItem' && nodes.slice(0, -1).every((node, index) =>
        workflow.connections[node.name]?.main?.[0]?.[0]?.node === nodes[index + 1].name);
  } catch {
    return false;
  }
}

async function main(args) {
  if (args.length && !(args.length === 1 && args[0] === '--live')) {
    console.error('Usage: npm run check:n8n [-- --live]');
    return 2;
  }
  const live = args.length > 0;
  const ready = await templateReady();
  console.log(ready
    ? 'The shipped template has a Header Auth webhook, a schema-constrained OpenAI step and a JSON reply.'
    : 'The shipped n8n template is missing or its planner contract is invalid.');
  const supplied = fields.filter(field => Boolean(process.env[field]));
  for (const field of fields) console.log(`${field} is ${supplied.includes(field) ? 'set' : 'missing'}.`);
  let planner;
  try {
    planner = createN8nPlannerFromEnv();
    console.log('The local webhook settings are valid.');
  } catch {
    if (supplied.length === fields.length) {
      console.error('The supplied webhook settings are invalid. Check for an HTTPS or loopback HTTP URL, a token without spaces, and an optional timeout from 1 to 30000 ms.');
    } else {
      console.log('Set the missing webhook variables before connecting.');
    }
  }
  console.log('Set the OpenAI credential in the OpenAI node inside n8n.');
  if (!live) {
    console.log('Offline check complete. To probe a configured workflow, run npm run check:n8n -- --live.');
    return ready && (planner || supplied.length < fields.length) ? 0 : 1;
  }
  if (!ready || !planner) {
    console.error('The live probe requires a usable template and valid webhook settings.');
    return 1;
  }

  const { practiceReceiptSource } = await import('../src/receipt-fixture.mjs');
  const note = 'Track my membership with Practice library reference member-readiness until it is closed. Can you check on Friday?';
  const today = '2026-11-23';
  const sources = [practiceReceiptSource];
  const fixed = { ...previewErrand(note, today), practicePlan: suggestPracticePlan(note, sources) };
  const result = await createIntakePlanner(planner).review(note, today, sources, fixed);
  if (result.plannerMode !== 'n8n' || result.plannerStatus !== 'proposed') {
    console.error(failureMessages[result.plannerFailure] ?? 'The planner fell back to fixed rules.');
    return 1;
  }
  console.log('The webhook returned a valid planner proposal for one synthetic note.');
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch(() => {
  console.error('The n8n readiness check could not finish.');
  return 1;
});
