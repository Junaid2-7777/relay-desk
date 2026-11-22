# Building the first household desk

The first implementation should let a judge inspect a booking, a payment and a credit without trusting the agent's account of what happened. Begin with a terminal and independent provider records. The prototype described here is planned.

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

1. Run both starting conditions. In a first-use reset the task descriptions arrive with **no grants**. Have the owner permit free/busy only and decline ledger access. Record the setup decisions, the narrower actions available and the refund's missing evidence. In the separate Monday reset, capture the original calendar event, invoice history, three existing grants and initial provider records.
2. Run the Monday sequence without prompting between errands. Capture the single bill decision, the confirmed 3 pm booking and the outstanding refund reference.
3. From a fresh reset, remove the 3 pm slot just before confirmation. Then run a separate race in which the provider confirms the visit and a new protected calendar event arrives before sync. Report the existing reservation and conflict, offer a rescheduling decision, and preserve the protected event. Read back the reservation before any second booking.
4. Approve ₹1,180 once, then revise the invoice again before dispatch. Verify zero debits against the stale approval. In a separate unchanged run, lose a payment response and verify that retry yields one exact payment. Settlement needs its own evidence.
5. Rehearse ordinary intake with library membership closure. After freezing the build, have the evaluator choose a different tracking job using an existing read capability. Supply a wrong issuer's acknowledgement, withhold the matching record across a restart, then release it. Inspect each transition without changing program code.

Publish actual install, start, reset and evaluation commands once tested on a clean clone. Pin the runtime, fixtures and planner settings. Supply an offline path and label live-model runs. Start a real pilot with consented reads and reversible calendar work. A local settlement simulation provides no evidence of production payment access. [Roadmap](../roadmap.md) · [Evaluation protocol](evaluation.md)
