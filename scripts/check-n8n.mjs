import { open, readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { createIntakePlanner } from '../src/intake-planner.mjs';
import { previewErrand, suggestPracticePlan } from '../src/intake.mjs';
import { createN8nPlannerFromEnv } from '../src/n8n-planner.mjs';

const template = new URL('../n8n/relay-desk-planner.json', import.meta.url);
const fields = ['RELAY_N8N_WEBHOOK_URL', 'RELAY_N8N_WEBHOOK_TOKEN'];
const stages = [
  ['n8n-nodes-base.webhook', 'Webhook', 'httpHeaderAuth'],
  ['@n8n/n8n-nodes-langchain.openAi', 'OpenAI', 'openAiApi'],
  ['n8n-nodes-base.code', 'Proposal formatter'],
  ['n8n-nodes-base.respondToWebhook', 'JSON response']
];
const executionSettings = {
  executionOrder: 'v1', executionTimeout: 30,
  saveDataErrorExecution: 'none', saveDataSuccessExecution: 'none',
  saveManualExecutions: false, saveExecutionProgress: false
};
const inertSettings = { availableInMCP: false, callerPolicy: 'none', errorWorkflow: 'DEFAULT', timezone: 'DEFAULT' };
const workflowFields = [
  'nodes', 'connections', 'settings', 'pinData', 'staticData',
  'name', 'description', 'id', 'active', 'isArchived', 'createdAt', 'updatedAt', 'tags', 'meta', 'nodeGroups', 'sourceWorkflowId',
  'versionId', 'activeVersionId', 'versionMetadata', 'versionCounter', 'triggerCount', 'parentFolderId', 'shared'
];
const nodeFields = ['type', 'typeVersion', 'parameters', 'name', 'id', 'position', 'notes', 'notesInFlow', 'credentials'];
const nodeDefaults = {
  disabled: false, executeOnce: false, alwaysOutputData: false, retryOnFail: false,
  continueOnFail: false, onError: 'stopWorkflow'
};
const maximumExportBytes = 1024 * 1024;
const failureMessages = {
  unavailable: 'The webhook did not return a successful response.',
  timeout: 'The webhook exceeded the planner deadline.',
  'invalid-proposal': 'The webhook response could not be used as a planner proposal.'
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const onlyFields = (value, fields) => isObject(value) && Object.keys(value).every(field => fields.includes(field));
const withoutDefaults = (object, defaults) => Object.fromEntries(Object.entries(object).filter(([key, value]) =>
  !Object.hasOwn(defaults, key) || value !== defaults[key]));

function credentialReferences(credentials, key) {
  if (credentials === undefined) return true;
  if (!onlyFields(credentials, key ? [key] : [])) return false;
  if (!key || !Object.hasOwn(credentials, key)) return true;
  const reference = credentials[key];
  return onlyFields(reference, ['id', 'name']) && (reference.id === null || nonempty(reference.id)) && nonempty(reference.name);
}

function modelParameters(parameters) {
  const result = structuredClone(parameters);
  if (isObject(result.modelId)) {
    delete result.modelId.cachedResultName;
    delete result.modelId.cachedResultUrl;
    if (result.modelId.mode === 'list') result.modelId.mode = 'id';
  }
  const format = result.options?.textFormat?.textOptions;
  if (typeof format?.schema === 'string') format.schema = JSON.parse(format.schema);
  else throw new TypeError();
  return result;
}

function examineWorkflow(input) {
  const workflow = Array.isArray(input) && input.length === 1 ? input[0] : input;
  const problems = [];
  if (!onlyFields(workflow, workflowFields) || workflow.isArchived === true) problems.push('Workflow export structure differs.');
  if (!isObject(workflow)) return { problems };
  if (!isObject(workflow.settings) || !isDeepStrictEqual(withoutDefaults(workflow.settings, inertSettings), executionSettings)) {
    problems.push('Workflow execution or retention settings differ.');
  }
  if ([workflow.pinData, workflow.staticData].some(value => value != null && !onlyFields(value, []))) {
    problems.push('The export contains pinned data or workflow state.');
  }

  const nodes = Array.isArray(workflow.nodes) && workflow.nodes.length === stages.length
    ? stages.map(([type]) => workflow.nodes.find(node => node?.type === type)) : [];
  if (!nodes.length || !nodes.every(node => isObject(node) && nonempty(node.name) && nonempty(node.id)) ||
      new Set(nodes.map(node => node.name)).size !== stages.length || new Set(nodes.map(node => node.id)).size !== stages.length) {
    problems.push('The workflow must contain exactly one node for each of the four planner steps.');
    return { problems };
  }
  const connections = Object.fromEntries(nodes.slice(0, -1).map((node, index) => [node.name, {
    main: [[{ node: nodes[index + 1].name, type: 'main', index: 0 }]]
  }]));
  if (!isDeepStrictEqual(workflow.connections, connections)) problems.push('The workflow connections differ from the single planner path.');
  const comparable = nodes.map((node, index) => {
    const [, label, credential] = stages[index];
    const fields = index === 0 ? [...nodeFields, 'webhookId'] : nodeFields;
    if (!onlyFields(withoutDefaults(node, nodeDefaults), fields) || !credentialReferences(node.credentials, credential)) {
      problems.push(`${label} execution settings or credential references differ.`);
    }
    try {
      if (!isObject(node.parameters)) throw new TypeError();
      let parameters = node.parameters;
      if (index === 1) parameters = modelParameters(parameters);
      if (index === 2) parameters = withoutDefaults(parameters, { language: 'javaScript', mode: 'runOnceForAllItems' });
      return { typeVersion: node.typeVersion, parameters };
    } catch {
      problems.push(`${label} parameters are invalid.`);
      return null;
    }
  });
  return { problems, comparable };
}

async function loadTemplate() {
  const { problems, comparable } = examineWorkflow(JSON.parse(await readFile(template, 'utf8')));
  if (problems.length) return null;
  const [webhook, model, formatter, response] = comparable.map(node => node.parameters);
  const format = model.options?.textFormat?.textOptions;
  const expected = webhook.httpMethod === 'POST' && webhook.authentication === 'headerAuth' && webhook.responseMode === 'responseNode' &&
    onlyFields(model, ['resource', 'operation', 'modelId', 'responses', 'simplify', 'options']) &&
    onlyFields(model.options, ['instructions', 'maxTokens', 'reasoning', 'store', 'textFormat']) &&
    model.resource === 'text' && model.operation === 'response' && model.options.store === false &&
    model.options.maxTokens === 2048 && format?.type === 'json_schema' &&
    format.schema?.type === 'object' && format.schema.additionalProperties === false &&
    isDeepStrictEqual(format.schema.required, ['goal', 'checkDate', 'practicePlan']) && nonempty(formatter.jsCode) &&
    response.respondWith === 'firstIncomingItem';
  return expected ? comparable : null;
}

async function readExport(path) {
  try {
    if (/^(?:[/\\]{2}|[a-z][\w+.-]*:\/\/)/iu.test(path) || !(await stat(path)).isFile()) return null;
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      const { size } = info;
      if (!info.isFile() || size > maximumExportBytes) return null;
      const buffer = Buffer.alloc(size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== size) return null;
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function checkExport(path, baseline) {
  const exported = await readExport(path);
  if (exported === null) {
    console.error('Could not read a local JSON workflow export of at most 1 MiB.');
    return 1;
  }
  const { problems, comparable } = examineWorkflow(exported);
  comparable?.forEach((node, index) => {
    if (node && !isDeepStrictEqual(node, baseline[index])) problems.push(`${stages[index][1]} version or parameters differ.`);
  });
  for (const problem of problems) console.error(problem);
  if (problems.length) return 1;
  console.log('The local workflow export matches the shipped planner contract.');
  return 0;
}

async function main(args) {
  const live = args.length === 1 && args[0] === '--live';
  const workflow = args.length === 2 && args[0] === '--workflow' && nonempty(args[1]) && !args[1].startsWith('--');
  if (args.length && !live && !workflow) {
    console.error('Usage: npm run check:n8n [-- --live | --workflow <local-export.json>]');
    return 2;
  }
  const baseline = await loadTemplate().catch(() => null);
  if (workflow) {
    if (baseline) return checkExport(args[1], baseline);
    console.error('The shipped n8n template is missing or its planner contract is invalid.');
    return 1;
  }
  const ready = Boolean(baseline);
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
