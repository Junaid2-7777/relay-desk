# Connect the practice planner

The n8n planner interprets a synthetic errand and returns a draft for review. The local desk controls plan confirmation, permissions, checks, and effects. In this mode, **Review errand** sends the typed note, the desk's local calendar day, and the fixture receipt catalog's issuer identifiers and labels to n8n. The example workflow forwards those fields to OpenAI. Use synthetic notes and identifiers throughout the practice desk.

## Set up n8n

1. Import [Relay Desk practice planner](../n8n/relay-desk-planner.json). The OpenAI node uses **Generate a Model Response**, available in n8n 1.117.0 and newer. [n8n text operations](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.openai/text-operations/#generate-a-model-response)
2. In **Practice planner request**, select a Header Auth credential with name `Authorization` and value `Bearer <webhook token>`. Create a high-entropy token for this workflow. Set the same token, without the `Bearer ` prefix, in the desk process. [n8n Webhook credentials](https://docs.n8n.io/integrations/builtin/credentials/webhook/#using-header-auth)
3. In **Propose an errand**, select the n8n OpenAI credential that holds your API key. The import pins `gpt-5.4-mini-2026-03-17`. If your project uses another model, choose a Responses API model with JSON Schema support and record its snapshot and settings before comparison. Leave tools disconnected and response storage disabled. [n8n OpenAI credentials](https://docs.n8n.io/integrations/builtin/credentials/openai/) · [Pinned model](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
4. Publish the workflow and copy its **Production URL**. The template disables saving production and manual execution data in n8n. Check the imported workflow settings before running the practice cases. [n8n Webhook URLs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/#webhook-urls) · [n8n workflow settings](https://docs.n8n.io/workflows/settings/)

## Open the practice desk

Set `RELAY_N8N_WEBHOOK_URL` and `RELAY_N8N_WEBHOOK_TOKEN` in the environment of the desk process. The URL must use HTTPS or loopback HTTP. `RELAY_N8N_TIMEOUT_MS` sets the proposal deadline in milliseconds and defaults to 12000.

```console
npm run reset -- --n8n --cold
```

Review a synthetic note such as “Track my membership with Practice library reference member-17 until it is closed. Can you check on Friday?” The review shows the planner mode used. Check the suggested date and confirm the proof plan before allowing a check. Failed, timed-out, or invalid responses fall back to fixed rules with an explanation in the review. Reopen the n8n practice data under `.relay/demo-n8n` with `npm run demo -- --n8n`.

## Webhook contract

The desk sends a single `POST` with an `Authorization: Bearer …` header and the JSON body `{ note, today, sources }`. A successful workflow responds with HTTP 200 and one JSON object with `goal`, `checkDate`, and `practicePlan`. A plan is `null`, a receipt plan with `capability`, `issuer`, `subject`, `type`, and `status`, or a visit plan with `capability`, `issuer`, `subject`, `service`, `windowStart`, and `windowEnd`. Missing identifiers and dates can be `null`. Relay Desk bounds and validates the response before showing it. [Proposal validator](../src/planner-proposal.mjs)

Run `node --test test/n8n-planner.test.mjs` to exercise the contract with a loopback server. This check needs only Node.js. The practice run with the published workflow exercises n8n authentication and OpenAI output separately.
