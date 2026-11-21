# Demo runbook

Open on a submitted scholarship application with one day left for institute verification. The student has done their part once. The case now depends on two offices, and the deadlines have already moved. Let the judge decide what happens next.

This is the planned demo for Deadline Relay. The prototype, its calendar writes, and its evaluation results are pending. The notices below are public records. The application, status events, recipient, and calendar belong to the local simulator.

## The case

Use the National Means-cum-Merit Scholarship Scheme (NMMSS), academic year 2026–27. The fixture starts with a submitted application. Keep the public rules and this individual case side by side so viewers can see what each source proves.

| Historical release | Last date to submit | Institute Nodal Officer (L1) | District Nodal Officer (L2) |
| --- | --- | --- | --- |
| 1 Oct 2026 | 31 Oct 2026 | 15 Nov 2026 | 30 Nov 2026 |
| 31 Oct 2026 | 15 Nov 2026 | 30 Nov 2026 | 15 Dec 2026 |

Replay the [1 October PIB release](https://www.pib.gov.in/PressReleseDetailm.aspx?PRID=2317657&lang=1&reg=3) and then the [31 October PIB release](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2330936&lang=1&reg=3). The new notice supplies the new deadlines. Confirmation of each case stage comes from the simulator’s separate case store.

Keep all dates as Indian calendar dates. Move the fixture clock to 29 November 2026 IST after the historical replay. Label that clock **Simulated date** on screen.

## Before recording

1. Start the application, case simulator, local CalDAV server, and local message outbox using the README setup steps once they are available. Seed or reset the demo fixture.
2. Use an anonymous case identifier and a local fixture inbox. Check that the case is submitted, L1 and L2 verification are pending, the calendar has one unrelated synthetic event and no program reminders, and the outbox has no messages.
3. Choose live-model mode when available. If using a recorded planner trace, label it **Planner replay** and show the state-changing tools running locally. Label a scripted path **Fixture-driven demo**.
4. Set the browser up so the project view, calendar provider readback, and case event log are easy to switch between. A recording should contain only public sources and synthetic data.

## Shared opening

1. Load the 1 October release. Show the matching scheme and academic year and the two verification reminders it creates on the local CalDAV server. The case timeline remains submitted and waiting for L1.
2. Replay the 31 October release. Show why it replaces the earlier schedule for this scope, and open its source evidence at the two revised dates.
3. Read the two events back from the calendar server. Show that the L1 and L2 event UIDs are the same as before, that their dates moved to 30 November and 15 December, and that there are still exactly two scholarship milestone events. Replaying the new release again should keep both UIDs, dates, and count unchanged. The unrelated event stays untouched throughout.
4. Advance the case clock to 29 November. Show the current case state and the next deadline. Ask the judge to choose a branch.

## Branch A — the institute returns the application

1. Inject a **Returned as defective** case event through the simulator controls. Include a synthetic correction request, such as replacing an unreadable attachment with a legible copy. The case should surface the student’s next action while retaining the official L1 and L2 deadlines.
2. Use the student control to record the correction in the simulator. Show the resulting follow-up draft with its exact local recipient, subject and body, such as “A legible copy was recorded for this case. Please confirm whether the corrected submission is visible for institute verification.” Show an empty outbox before approval. Approve that version, then verify a single queued request in the local outbox.
3. Inject an acknowledgement that the correction was received. The case must still show L1 as pending. Hold the view long enough for that distinction to register.
4. Inject an explicit **L1 verified** event from the institute actor. Show that L2 is still pending. Inject a separate **L2 verified** event from the district actor and show both source-backed transitions in the case timeline. The final state reports the two verification stages complete.

## Branch B — the judge adds a misleading notice

1. Feed the agent an old release again, or a fixture for a different scheme that uses similar verification language. Show the candidate’s scheme, academic year, and publication date beside the active NMMSS release.
2. Open the decision trace. Show the reason the candidate did not supersede the current schedule, such as an older publication or a different scheme.
3. Read the calendar back from CalDAV. Show the same two UIDs, 30 November and 15 December dates, and event count. The case remains submitted and awaiting L1, and the outbox remains empty.

## What the recording should prove

| Moment | Direct evidence |
| --- | --- |
| Dates are replaced | The 31 October release is visible. Calendar readback shows updated dates for the original event UIDs and two total milestone events. |
| Replayed or irrelevant input | Provider readback shows that both event UIDs and dates are untouched. The decision displays the freshness or scope reason. |
| Approved follow-up | The exact local draft is visible before approval. The outbox has zero messages before approval and one matching queue record afterwards. |
| Acknowledgement versus verification | The case event log shows receipt of the correction with L1 pending, a distinct L1 verification with L2 pending, then a distinct L2 verification. |

## Video plan

Target **2:20**. Record Branch A for the main entry because it shows the full student workflow. Keep both branches ready for a live walkthrough.

| Time | Shot | Suggested narration |
| --- | --- | --- |
| 0:00–0:18 | Submitted case beside the two verification steps and the imminent deadline. | “You submitted your scholarship application. Two offices still have to verify it. What happens when the deadlines move or the institute needs something from you?” |
| 0:18–0:46 | Replay 1 October and 31 October, expand the published source, and read back CalDAV. | “These two Ministry notices are real. Deadline Relay applies the revised dates to the existing reminders. The calendar still has the same two event IDs.” |
| 0:46–0:57 | Show the simulated 29 November clock and pick the judge’s branch. | “In this simulated case, it’s one day before institute verification closes. Let’s see what happens if the institute returns the application.” |
| 0:57–1:27 | Show the defect and student correction, then confirm the exact draft and one outbox write. | “The student replaces the unreadable attachment. The agent prepares a follow-up. The local outbox gets the approved version once.” |
| 1:27–1:59 | Show distinct acknowledgement, L1 verification, and L2 verification events. | “The institute received the correction. L1 is still pending. Here is the institute’s separate verification. The district then verifies at L2.” |
| 1:59–2:20 | End on the evidence panel and completed synthetic case. | “The public notice determines when each step is due. The case record shows which step happened and who did it.” |

For Branch B, use 0:57–1:52 to show the candidate, the rejection reason, and both unchanged calendar records. End on the pending case and the two dates, or show measured evaluation results once they exist. Confirm shared video playback, readable screen text, and captions before submission.

## Submission copy

Deadline Relay picks up where a scholarship application leaves off. It tracks which person owes the next action, revises the student’s calendar from official notices, and helps recover a returned application. In the demo, a judge sends the case back for correction. The agent follows it through student action and local follow-up, then waits for separate school and district verification records. The dates come from real Ministry notices. The case and communications run in a local simulation.
