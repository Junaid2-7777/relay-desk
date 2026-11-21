# Solo build plan

Target a tested local demo by 3 December. Homingo submissions open 4 December at 00:00 IST and close 6 December 2026 at 23:59 IST. [Edition timeline](https://hackathon.homingo.co.in/hackathons/edition-01#timeline) · [FAQ](https://hackathon.homingo.co.in/faq)

## First vertical slice

Create one previously submitted synthetic case and place the two institute and district reminders in a separate CalDAV calendar. Replay the 1 and 31 October notices. The two appointments must keep their UIDs and move to the approved new dates. Trigger an institute return, a student correction, and a correction acknowledgement. The last event must leave the handoff open. Finish by emitting the two independent authority records in order. Do this first with a deterministic driver so the core can be verified without a model key.

## Milestones

1. **21–23 November** — Build the source fixture, synthetic case event service, and local calendar setup. Land the vertical slice through independent reads. Capture the exact date values, revisions and record IDs for witnesses. If the separate CalDAV startup is the blocker, use a second loopback HTTP calendar service with SQLite and stable event IDs, then state the changed integration clearly in the demo and documentation.
2. **24–26 November** — Add validated source resolution, the durable event loop, exact approval and local outbox. Test stale draft, same-event replay, late/out-of-order case event, provider conflict, and a crash after writing. Gate on no skipped verification stage and zero duplicate writes.
3. **27–29 November** — Add the model-backed planner, one case-focused UI and the judge controls. Show the notice evidence, who owns the next action, chronological case events and native state readback. Gate on the model completing the happy path and adapting to at least one unseen source or case variation with no manual edit to the agent’s database.
4. **30 November–2 December** — Freeze fixtures and run the [evaluation protocol](evaluation.md), including matched baseline, model failure and scope traps. Check a fresh clone with the pinned setup, reset and a no-key mode. Save reproducible results and shorten any unsupported demo claim.
5. **3 December** — Freeze the demo and record the live run. Verify that the recording shows the acknowledgements and authority records from independent services. Update the README with exact setup, runtime and model disclosures. [Demo script](demo.md)
6. **4–6 December** — Check signed-out access to the GitHub repository and video. Submit through the dashboard and confirm the saved links. [Submission checklist](hackathon.md)

## Stack and scope

- Use Python 3.12, FastAPI, Pydantic, SQLite, and one tool-capable model. Separate the synthetic authority event store from the agent journal. Start Radicale as a local service for the calendar and keep mail in a local outbox. Pin versions at implementation. [Radicale documentation](https://radicale.org/)
- Show one synthetic case at a time. Include one primary flow, one mismatched-notice branch, one conflicting-evidence or status-gap test, and restart recovery in the evaluation. Additional schemes, languages, broad scraping and deployment can wait. Preserve the two independently witnessed handoffs and an explicit abstention path.
- Provide documented PowerShell and macOS/Linux launch steps. Use a reset command that restores only the dedicated demo fixtures. Keep cached public evidence free of sign-in links, identifiers and unrelated page content. Label live-model and prerecorded planner modes, and distinguish the historical public notices from synthetic case events.
