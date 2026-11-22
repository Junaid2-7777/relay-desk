# Relay Desk roadmap

## Current stage

**The local desk runs the three-errand practice household.** The first-use flow keeps a private note and check date. With synthetic permissions, the practice brief shows a revised bill for review, a verified free visit and an open refund. Participant testing and the working-demo video are still ahead. [Run the desk](docs/build.md#run-the-local-build) · [Evaluation plan](docs/evaluation.md)

**Build next · Handle an unfamiliar request.** Use ordinary intake to configure a practice errand with a new issuer and subject. Try an available evidence source and an unsupported one. Participant usability checks and model evaluation still need their own runs. [Evaluation plan](docs/evaluation.md)

## Build order

Pick the first unfinished step. Move on when another person can reproduce the result.

| Step | What to build | How to tell it works |
| --- | --- | --- |
| 1. Keep one errand · Built | Save a short note, an optional check date and the source of the information. Let the person review and edit it. | Reopen Relay with no connections. The refund is still open and the check date is still theirs. Inspect the trace for zero outside reads or writes. [First-use check](docs/evaluation.md#first-use-acceptance) |
| 2. Check the evidence · Built | Add a resettable synthetic household, a read-only refund tracker and a separate source for incoming credits. Ask for access just to the records that errand needs. | Declining access leaves the saved note usable. With access, neither a shop’s promise nor a same-value credit for another order closes the refund. A matching posted credit does. |
| 3. Act within permission · Built | Add an appointment provider, calendar and bill simulator. Give each action a precise permission and each person a short explanation when a choice is needed. | Relay books the free visit and checks both the provider confirmation and calendar entry. The refund stays open. A bill revised from ₹850 to ₹1,180 puts one decision in the brief and leaves the ₹900 limit intact. [Worked session](docs/build.md#first-build-review) |
| 4. Recover when something changes · Built | Handle withdrawn permission, revised invoices, newly busy slots and lost provider replies. Track each attempted action across restarts. | An expired approval produces zero debits. A lost reply yields the original receipt once. A conflict after a confirmed booking shows the reservation and the conflict without moving someone else’s appointment. |
| 5. Make the brief easy to use · Browser checks passed | Put the decision, amount and consequence together. Let people inspect a source, decline an action, withdraw access or add an errand from the same brief. | Using a phone or keyboard, a reader can find the one decision, see why the refund is open and tell whether a payment was made. Check those answers with people who handle different kinds of errands. [Experience](docs/experience.md) |
| 6. Handle an unfamiliar request | Feed plain-language instructions to a bounded planner. Give it the same permission checks and tools as the fixed-rule version. Freeze both before an evaluator supplies a new errand. | A new subject and issuer can reuse an existing tool with the right permission. An unsupported request stays open with the missing evidence named. No new workflow is added for the trial. |
| 7. Measure and demonstrate | Run the first-use check, R1–R7, the held-out trials and the matched manual and fixed-rule comparisons. Record failures and collect participant feedback. | A second person can reproduce the results from a clean checkout. Record the working session with the fixture and planner mode visible. Use those results in the entry. [Evaluation](docs/evaluation.md) · [Demo runbook](docs/demo.md) · [Submission checklist](docs/hackathon.md) |

## What earns a release claim

- **Acts safely.** Require zero unauthorized or duplicate effects, false completions, missed mandatory approvals or sensitive-data leaks. A one-time approval applies to one specific bill. Reserve the live-model claim for at least 33 of 36 successful held-out trials, including all 12 blocked trials.
- **Takes work off someone’s hands.** Compare successful outcomes, decisions, interruptions and lookups against the matched manual baseline. Count the cost of initial permission and later clarification. Measure time and effort with people using the product. [Comparison protocol](docs/evaluation.md)
- **Works beyond the examples.** Verify both tracking a new outcome and taking a newly authorized action through an existing tool. If a provider cannot confirm completion, show exactly what is still open.

## From a demo to a service

Ask someone to bring one recent errand and try handing it over in their own words. Find out what they would let Relay see, when they want to hear from it and what would let them stop checking for themselves. Record confusion and refusals alongside successes. [Research protocol](docs/problem.md)

For a pilot, start with consented reads and reversible calendar work. Establish how the person can revoke access and how the provider can confirm an outcome. A bank credit may lack an order reference, and a service company may have no booking feed. Relay can still keep the errand and prepare a follow-up. Expand into money-moving actions only after verifying the spending controls and settlement evidence.
