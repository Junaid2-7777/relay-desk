# Connect the practice planner

The n8n planner interprets a synthetic errand and returns a draft for review. The local desk controls plan confirmation, permissions, checks, and effects. In this mode, **Review errand** sends the typed note, the desk's local calendar day, and the fixture receipt catalog's issuer identifiers and labels to n8n. The example workflow forwards those fields to OpenAI. Use synthetic notes and identifiers throughout the practice desk.

## Set up n8n

The browser sends the planner mode shown when the desk opened with each review. Direct callers of `POST /api/errands/preview` must include `"plannerMode": "n8n"` when asking n8n to review a note. If the mode changes while a tab is open, Relay returns HTTP 409 before contacting the workflow. Reload the tab to see the current mode.

1. Import [Relay Desk practice planner](../n8n/relay-desk-planner.json). The OpenAI node uses **Generate a Model Response**, available in n8n 1.117.0 and newer. [n8n text operations](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.openai/text-operations/#generate-a-model-response)
2. In **Practice planner request**, select a Header Auth credential with name `Authorization` and value `Bearer <webhook token>`. Create a high-entropy token for this workflow. Set the same token, without the `Bearer ` prefix, in the desk process. [n8n Webhook credentials](https://docs.n8n.io/integrations/builtin/credentials/webhook/#using-header-auth)
3. In **Propose an errand**, select the n8n OpenAI credential that holds your API key. The import pins `gpt-5.4-mini-2026-03-17`. If your project uses another model, choose a Responses API model with JSON Schema support and record its snapshot and settings before comparison. Leave tools disconnected and response storage disabled. [n8n OpenAI credentials](https://docs.n8n.io/integrations/builtin/credentials/openai/) · [Pinned model](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
4. Publish or activate the workflow and copy its **Production URL**. The template disables saving production and manual execution data in n8n. Check the imported workflow settings before running the practice cases. [n8n Webhook URLs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/#webhook-urls) · [n8n workflow settings](https://docs.n8n.io/workflows/settings/)

## Check the connection

Run `npm run check:n8n` to inspect the shipped template and validate local webhook settings offline. It reports which variables are set without showing their values. A usable template exits `0` when the webhook settings are valid or the URL or token is still missing. An unusable template or invalid settings with both required variables supplied exit `1`.

After applying the template in n8n, download the saved workflow JSON from the editor, or export just that workflow with the n8n Server CLI. Use the published version if the instance supports that export. Keep the JSON local because it can contain credential names and IDs. [Export and import workflows](https://docs.n8n.io/build/manage-workflows/export-and-import) · [Server CLI workflow export](https://docs.n8n.io/deploy/host-n8n/configure-n8n/use-the-command-line/#workflows)

```console
npm run --silent check:n8n -- --workflow .relay/n8n-workflow.json
```

This checks one local export up to 1 MiB against the template in this checkout. It checks the four-node path, Header Auth, execution timeout and retention settings, the model snapshot, the forwarded fields, prompt, schema, formatter, and JSON reply. It accepts renamed or repositioned nodes and credential ID/name references. Changing the model or any other executable part of the template is reported as drift. A match exits `0`. An unreadable export or a mismatch exits `1` with a description of the affected section. The command makes no requests, does not run workflow code, and keeps file paths and contents out of its diagnostics.

The export can show the workflow definition and its declared settings. Use the published webhook probe to check reachability and credentials, and review instance logging and credential configuration in n8n. The `--workflow` and `--live` flags are separate commands.

After publishing the workflow and setting the webhook variables, run `npm run check:n8n -- --live` to send one fixed synthetic note through the ordinary planner adapter and validator. It exits `0` only if the webhook returns a valid n8n proposal. A fixed-rule fallback, unusable template, or invalid live configuration exits `1`. Invalid command arguments exit `2`. The command keeps the endpoint, credentials, and upstream response out of its output. A successful probe verifies the webhook round trip and proposal shape. Use the held-out comparison to evaluate planning quality. [Held-out comparison](held-out.md)

## Open the practice desk

Set `RELAY_N8N_WEBHOOK_URL` and `RELAY_N8N_WEBHOOK_TOKEN` in the environment of the desk process. The URL must use HTTPS or loopback HTTP. `RELAY_N8N_TIMEOUT_MS` sets the proposal deadline in milliseconds and defaults to 12000.

```console
npm run reset -- --n8n --cold
```

Review a synthetic note such as “Track my membership with Practice library reference member-17 until it is closed. Can you check on Friday?” The review shows the planner mode used. Check the suggested date and confirm the proof plan before allowing a check. Failed, timed-out, or invalid responses fall back to fixed rules with an explanation in the review. Reopen the n8n practice data under `.relay/demo-n8n` with `npm run demo -- --n8n`.

## Webhook contract

The desk sends a single `POST` with an `Authorization: Bearer …` header and the JSON body `{ note, today, sources }`. A successful workflow responds with HTTP 200 and one JSON object with `goal`, `checkDate`, and `practicePlan`. A plan is `null`, a receipt plan with `capability`, `issuer`, `subject`, `type`, and `status`, or a visit plan with `capability`, `issuer`, `subject`, `service`, `windowStart`, and `windowEnd`. Missing identifiers and dates can be `null`. Relay Desk bounds and validates the response before showing it. [Proposal validator](../src/planner-proposal.mjs)

Run `node --test test/n8n-planner.test.mjs` to exercise the contract with a loopback server. This check needs only Node.js. The practice run with the published workflow exercises n8n authentication and OpenAI output separately.
