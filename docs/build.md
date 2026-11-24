# Building the first household desk

The local build starts with an errand someone can hand over using only a sentence. The three-job practice household lets a judge inspect a booking, a payment and a credit directly.

## Start with one note

Use a fresh local desk with no connected accounts or model key. Accept typed text or a pasted, redacted note. Show an editable goal and optional check date together before saving. For the shop refund example, save the user's Friday check and label the promise **From your note**. Keep provider details optional. On reopening the desk, the same errand and check should be easy to find.

Build this through the ordinary intake and local case store used by the household brief. The first review needs one saved item and a trace with zero provider calls. A pasted note can support preparing a follow-up locally. Sending one is a separate action. [First-use acceptance](evaluation.md#first-use-acceptance)

## Run the local build

Use Node.js 24 or newer. There are no third-party runtime packages to install.

- `npm start` opens the ordinary desk on `http://127.0.0.1:4173` with data in `.relay`.
- `npm run reset` launches the three-errand practice desk with synthetic grants. Select **Check your errands** to run the morning. `npm run reset -- --cold` resets the same household with no grants. `npm run demo` reopens the practice database in `.relay/demo`. Stop the existing process before switching commands.
- `npm run reset -- --recorded` starts the authored-response practice desk, and `npm run demo -- --recorded` reopens its own data in `.relay/demo-recorded`. Paste a note from the [rehearsal cases](../fixtures/planner-rehearsal.json) to replay its proposal. Other notes use fixed rules with a visible fallback message.
- `npm run reset -- --n8n --cold` starts the n8n practice desk after webhook configuration. `npm run demo -- --n8n` reopens its data in `.relay/demo-n8n`. Use synthetic notes in this mode. [Connect the practice planner](n8n.md)
- `npm run evaluate` runs the acceptance checks and isolated simulator cases and prints the build revision, fixture and rubric hashes, and duration. Run `node --test test/first-use.test.mjs` to replay just the first saved errand.
- `npm run compare:planners` runs the fixed rules and authored recorded responses through the same intake, consent and provider checks. [Paired planner rehearsal](evaluation.md#paired-planner-rehearsal)
- `npm run compare:morning` compares scripted manual follow-up with fixed rules for the cold and warm morning. [Scripted morning baseline](evaluation.md#scripted-morning-baseline)
- `RELAY_PORT`, `RELAY_DATA_DIR` and `RELAY_CLOCK` override the port, data directory and clock. Supply an ISO timestamp with an explicit offset for the clock.

The practice desk exposes `/api/fixture/refund`, `/api/fixture/visit` and `/api/fixture/bill` for native provider records. `/api/inspect` shows the local errands, permissions and prepared actions. Browser checks covered the first-use flow by keyboard, a 320 CSS pixel viewport and 200% text size in Chromium. The practice brief was also exercised by keyboard, including deferring a payment and verifying a matching synthetic settlement.

In the practice refund, **Draft a follow-up** shows the synthetic recipient, subject and editable message. **Queue this draft in practice outbox** authorizes those exact words. Inspect the saved queue row at `/api/fixture/outbox`. The refund remains open while waiting for credit. If an authorized credit check already finds the matching posted credit when you approve the draft, the desk verifies the refund and skips the queue.

To rehearse a new errand, save “Track my membership with Practice library reference member-17 until it is closed.” Open **Set up a practice check** and confirm the issuer, reference, record type and expected status. The suggestion uses fixed rules. After saving, allow just the issuer receipt and select **Check your errands**. An evaluator can publish an acknowledgement or closure through `openReceiptFixture` and inspect the native records at `/api/fixture/receipt`. Run `node --test test/transfer-flow.test.mjs` to replay the receipt, unavailable issuer and new booking subjects without manual setup.

## Seed one Monday

Use an isolated household and an injected clock of **23 November 2026 IST**. Seed prospective grants already agreed by the household. The bill revision arrives before any payment of the earlier invoice. All personal records and monetary amounts are synthetic.

| What the household permits | What the builder supplies | First observable result |
| --- | --- | --- |
| Watch one merchant return for ₹1,249. Read its message thread and relevant incoming credits. | The merchant promises the refund. The ledger includes a same-value credit for a different return. | The refund stays open. The expected reference remains visible and the unrelated credit has no effect. |
| Book one free broadband visit on Tuesday afternoon. Protect existing commitments. | The provider offers 11 am and 3 pm on 24 November. An existing event covers 11 am. The 3 pm slot is free. | Read one confirmed 3 pm reservation from the provider and one corresponding event from the calendar. The unrelated event retains its time and identity. |
| Pay the named electricity account up to ₹900 per bill. | Invoice revision one is ₹850. Before dispatch, the issuer posts revision two at ₹1,180. | Zero debits. The owner sees the revised amount, payee, reference and choices. The standing limit still reads ₹900. |

## Implement the shared path first

Use a deterministic runner before adding model interpretation. A loopback simulator owns mail, free/busy intervals, bookings, credits, invoices and settlement records. Keep the agent's journal in a separate SQLite store. Give the tester direct provider-side readback. The future UI and tests should drive the same runner. [Architecture](architecture.md)

The planner proposes a typed action. The controller checks the household's current grant, allowed fields, amount or time restrictions, freshness and prior effects. The adapter rechecks the state it owns at the moment of the write. Journal an operation key before dispatch. After a lost reply, look up that key and inspect the result before retrying.

Keep domain facts in adapters. A free calendar interval cannot confirm a booking. An additional read source can enable a new tracking job without a workflow named for that errand. A new power, such as filing a form with an agency, needs its own adapter, permission and tests.

## First build review

1. After the single-note check, run both multi-job starting conditions. In a cold reset the three tasks arrive with **no grants**. Have the owner permit free/busy only and decline ledger access. Record the setup decisions, available actions and missing refund evidence. In the warm Monday reset, capture the original calendar event, invoice history, three existing grants and initial provider records.
2. Run the Monday sequence without prompting between errands. Capture the single bill decision, the confirmed 3 pm booking and the outstanding refund reference.
3. From a fresh reset, remove the 3 pm slot just before confirmation. Then run a separate race in which the provider confirms the visit and a new protected calendar event arrives before sync. Report the existing reservation and conflict, offer a rescheduling decision, and preserve the protected event. Read back the reservation before any second booking.
4. Approve ₹1,180 once, then revise the invoice again before dispatch. Verify zero debits against the stale approval. In a separate unchanged run, lose a payment response and verify that retry yields one exact payment. Settlement needs its own evidence.
5. Rehearse ordinary intake with library membership closure. After freezing the build, have the evaluator choose a different tracking job using an existing read capability. Supply a wrong issuer's acknowledgement, withhold the matching record across a restart, then release it. Inspect each transition without changing program code.

Publish actual install, start, reset and evaluation commands once tested on a clean clone. Pin the runtime, fixtures and planner settings. Supply an offline path and label live-model runs. Start a real pilot with consented reads and reversible calendar work. A local settlement simulation provides no evidence of production payment access. [Roadmap](../roadmap.md) · [Evaluation protocol](evaluation.md)
