# Deadline Relay roadmap

**Build for the moment a family gets a school receipt and has to decide whether to keep following up.** The first release follows one synthetic, already-filed NMMSS application from submission through school and district verification. A judge should be able to change the reason for a return, withhold a receipt, or replay an old notice and see the right next step emerge.

As of 22 November 2026, the repository contains research, a product specification, a visual study and an evaluation plan. Implementation, user research and measured results are ahead. The solo build targets a recordable local demo on **3 December**. The event submission window is **4–6 December**, closing at **23:59 IST on 6 December**. [Edition timeline](https://hackathon.homingo.co.in/hackathons/edition-01#timeline)

## The build sequence

| Target in 2026 | Build this next | Evidence needed to move on |
| --- | --- | --- |
| **23 Nov · One independent observation** | Freeze the four Ministry schedules and their field-level sources. Seed a filed case, an empty outbox and an isolated calendar. Build a deterministic driver for the two October notices. | Read the same two event UIDs from the calendar before and after the revision. School moves from 15 to 30 Nov, district from 30 Nov to 15 Dec. The unrelated event keeps its original contents. |
| **24–25 Nov · One complete case** | Implement the role-specific case simulator, student correction, exact draft approval and local queue. Tie every correction to the return that requested it. | Run the school acknowledgement both before and after approval. The outbox counts are zero and one respectively. Issue school verification, withhold the district receipt and restart. The district is still the next owner. Supply its receipt and inspect both authority records. |
| **26 Nov · Recovery** | Add the durable decision journal, scoped notice resolution, conditional calendar writes and reconciliation after interruption. Exercise an unreachable authority feed. | Drop a calendar reply after the write and interrupt a two-event update halfway. Read back each stable event, show the outstanding operation and recover without duplicates. Replay a stale return and a wrong-scope notice. Neither changes the current handoff. |
| **27–28 Nov · The student sheet** | Build the phone-first handoff view over the verified records. Add source disclosure, draft review and separate judge controls. Render every owner change on that same sheet. | Complete the correction by keyboard, read the school receipt, then find the Ministry source for the date. At phone width and enlarged text the owner, school deadline and student action stay readable. Show what the family sees when the last case check failed. [Interaction design](docs/experience.md) |
| **29 Nov · The model earns its place** | Connect the planner to the existing read tools and validator. Keep the fixed-parser comparison on the same case, clock, permissions and providers. Freeze the prompts, parser, scenarios and scoring labels before opening the held-out set. | On a development example, switch the return from an unreadable copy to a missing reverse page. The task must specify the missing page. An unspecified defect should elicit a clarification. Both cases retain the authority's original words and deadline. |
| **30 Nov–2 Dec · Score and rehearse** | Run the deterministic fault suite, the baseline comparisons and the held-out live trials. Rehearse the judge’s alternate branches. Exercise setup, reset and the no-key path from a fresh clone. | Save the commit, fixture hashes, settings, failures and provider observations. Apply each claim gate below. The README should let another person reproduce the run they saw. |
| **3 Dec · Freeze and record** | Freeze the tested revision and record the 2 min 20 sec walkthrough. Keep the planner mode, simulated date and data source legible. | A viewer sees the original and revised reminders, the acknowledgement with school verification pending, and both authority receipts. Watch the export with captions at its intended playback size. [Demo runbook](docs/demo.md) |
| **4–6 Dec · Submit** | Check the repository and recording while signed out, then complete the participant submission. | Reopen the saved entry and verify the exact submitted links before the deadline. [Submission checklist](docs/hackathon.md) |

## What survives a schedule slip

Protect the one-case handoff, student approval, independent readback and evidence of an unresolved case. If time runs short, cut alternate screens, extra schemes and live fetching first. Dated public snapshots already support the historical demo. If the CalDAV integration stalls, a separate local calendar service can demonstrate stable updates. Name the substitute and leave the CalDAV gate open. A fixture-driven run can demonstrate recovery while live inference is unavailable. Label the mode wherever a judge sees the result. [First-case build notes](docs/build.md)

## Which claims the evidence can support

| Proposed claim | Required evidence |
| --- | --- |
| The workflow recovers the handoff. | Every deterministic fixture and fault variant passes. Provider records confirm each expected effect. Any unauthorized or duplicate write, incorrect deadline write, or false verification blocks the claim until repaired and rerun. |
| A live model handles the variations. | At least **33 of 36** held-out live trials pass, including **12 of 12** negative trials. Keep timeouts and failures in the denominator. A forbidden effect in any trial blocks the model-backed release claim. |
| The model adds value over the typed workflow. | It wins a majority of trials on at least two noisy scenarios where the fixed parser fails a majority, with no increase in false effects. Publish paired outcomes even if the parser matches it. |

The evaluation protocol defines the fixtures, acceptable abstentions and evidence package. A local message receipt proves only that the approved text entered the sandbox queue. An officer's verification proves the case reached that stage. [Evaluation protocol](docs/evaluation.md)

## The decision after the demo

**Do families use the handoff correctly?** Walk five adults with relevant scholarship experience through the correction and acknowledgement screens. Record their uncoached answers. Aim for four of five to identify the next owner and action in both scenes. If anyone mistakes a receipt for verification, revise that screen and test it again. Ask about a recent real follow-up separately to learn whether this problem recurs. [Family study](docs/problem.md#test-the-premise-with-families)

**Where would trustworthy case updates come from?** Before proposing a real pilot, ask a participating school or counsellor to identify an authorized source for each stage, who may read it, how quickly updates appear, and how a family can tell when access stops. The public notices supply dates. A viable two-stage pilot also needs a permitted path to case-specific school **and** district evidence. If one stage is unavailable, limit a pilot to the handoff the partner can substantiate and mark the remaining stage unknown.
