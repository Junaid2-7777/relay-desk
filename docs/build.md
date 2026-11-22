# Building the first case

Start with a judge at a terminal, looking at the same two calendar events before and after the 31 October notice. Give the judge a separate way to inspect who issued each case event. Once these observations work from a fresh reset, the student interface has something trustworthy to show.

## Smallest useful setup

| Part | Proposed implementation | What a builder can inspect directly |
| --- | --- | --- |
| Historical inputs | Four versioned Ministry schedules, one dated portal capture and a fixed IST clock. Keep the original field, a short passage or row, URL, issuer date and capture identity together. | Which evidence was available on the simulated day and which field justified each deadline. [Source register](sources.md) |
| Case and outbox simulator | A loopback FastAPI service with role-specific fixture controls. Keep the case timeline and local outbox in separate SQLite tables, so queuing against the current case sequence can be atomic. | The authority, stage, case and correction request for each event. The exact payload and receipt for each queued request. |
| Personal agent | A separate process and SQLite journal. Validate model proposals with Pydantic and run the same state transitions in fixture mode. Start with Python 3.12 and pin tested dependencies when the build lands. | The input that woke the agent, decision, pending effect, and corresponding provider readback. |
| Calendar | One isolated Radicale calendar on loopback. Seed one unrelated event. Give each managed stage a stable event UID and resource path. | Calendar data obtained from the provider, including the UID, date and revision of each changed event. [Radicale](https://radicale.org/) |

## Walk it through from a clean reset

1. **Start on 1 October.** Seed one filed NMMSS case for AY 2026–27, both verifications pending, one unrelated calendar event and an empty outbox. Release the 1 October notice. Save provider readbacks for the two new reminders and the unrelated event.
2. **Advance to 31 October.** Release the revised notice. Compare the same two resources by UID. School moves from 15 to 30 November. District moves from 30 November to 15 December. Replay the release and check the effect history for zero additional writes. [Published dates](sources.md#nmmss-timeline)
3. **Advance to 29 November.** Have the school request a legible copy. Record the student's correction against that return. Exercise both orders after taking a fresh reset for each run. Approval first queues one local message. Acknowledgement first retires the draft without queuing it. The school owns verification at the end of both runs.
4. **Withhold the final receipt.** Issue school verification and inspect the district handoff. Leave the case there through a restart. Supply a matching district verification and inspect both authority records before displaying completion. [State and effect contracts](architecture.md)

## Make the setup reproducible

Ship one documented path to start, inspect and reset the isolated services on PowerShell and on macOS/Linux. A reset restores only the dedicated fixture data, clock and calendar. Keep dated public excerpts available offline. Label the actual planner mode in both the UI and run record. A fresh-clone check must exercise the fixture-driven path without a model key and declare the configuration needed for live inference.

If Radicale blocks progress, keep the provider boundary and use a separate loopback SQLite calendar service with stable event IDs. Show that service's native records and label the CalDAV check outstanding. If inference is unavailable, replay the typed case with actual local writes and label it **Fixture-driven demo**. Claim model performance only for scored live runs. [Evaluation protocol](evaluation.md)
