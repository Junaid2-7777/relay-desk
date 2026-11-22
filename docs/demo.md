# Demo runbook

“Your school says it received your correction. Can you stop following up?” Give the judge that decision on the student’s own handoff sheet. The case can stay open, move to the district, or pause for review according to the evidence the judge supplies.

This is the planned demonstration. The Ministry notices are historical public records. The application, students, offices, messages, clock and calendar entries are synthetic. The prototype and measurements are pending. [Student experience](experience.md)

## Set the scene

1. Once the local build exists, follow the tested setup in the README. Reset the dedicated fixture to **1 October 2026**. Check the case service for one submitted NMMSS application for academic year 2026–27 with both verifications pending. The local calendar starts with one unrelated event and no scholarship reminders. The local outbox is empty.
2. Open the student sheet in one view, the judge controls in another and the independent provider records in a third. Keep the student on the sheet while the judge enters authority events. Record only public evidence and synthetic records.
3. Keep **Simulated date** and the actual planner mode visible. Use **Live model**, **Planner replay** or **Fixture-driven demo** as appropriate. Identify the public records as historical snapshots. An alternate calendar provider must be named in the recording and its own records shown.

## First, move the deadlines

| Simulated date | What the presenter does | Expected evidence |
| --- | --- | --- |
| **1 Oct** | Reveal the 1 October Ministry notice and show the school as the current owner. | The application deadline is 31 Oct. Two local all-day events appear for verification, school on 15 Nov and district on 30 Nov. Read both stable event IDs from CalDAV. |
| **31 Oct** | Advance the clock to the publication day and release the revised notice. Expand the school date on the sheet. | The application deadline becomes 15 Nov. The same two event IDs now read 30 Nov and 15 Dec. The filing receipt and unrelated event retain their original values. |
| **29 Nov** | Advance to the eve of school verification. Leave the student sheet open. Give the judge the choice of returning the case or introducing a misleading notice. | The sheet reads **Your school has the next step**. School verification is due 30 Nov. District verification is due 15 Dec. |

Use each notice’s three stated dates separately. Reveal the 21 November NSP cross-check only after the simulated clock reaches its observation date. Date-only sources authorize no cutoff hour. [1 October Ministry release](https://www.pib.gov.in/PressReleseDetailm.aspx?PRID=2317657&lang=1&reg=3) · [31 October Ministry release](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2330936&lang=1&reg=3) · [Portal snapshot and provenance](sources.md#public-nsp-cross-check-on-21-november-2026)

## Judge choice A · Return the application

1. **School actor.** Record a return for this case with the reason “The attachment is too faint to read. Please provide a legible copy.” On the sheet, Student becomes current, the reason appears in the school’s words and the 30 Nov deadline still belongs to the school. The student now has a concrete action, **Open student simulator**.
2. **Student actor.** Record the correction through the simulator and return to the sheet. Open **Review follow-up**. Show the empty outbox and read the case, exact local recipient, subject and message. An example message is “I’ve supplied a clearer copy for this case. Can you confirm receipt of the corrected attachment for school verification?” Choose **Approve and queue locally**. Show the single matching row and its receipt in the local outbox.
3. **School actor.** Acknowledge the correction. Stop on the student sheet. Ask “Who has the next step now?” The route stays at School and the headline reads **Your school received the correction**. Open the receipt so the judge can read what the school acknowledged. School verification is still pending. On a second run, let the school acknowledge *before* draft approval. The obsolete receipt request should retire and the outbox should stay empty.
4. **School actor, then district actor.** Record school verification and show the current owner move to District with the 15 Dec date. Issue the district’s separate verification for the same case. End on **Both verification steps are complete** and open the two authority records. The demonstrated outcome ends at verification.

## Judge choice B · Challenge the calendar

Give the judge the 1 October release again or the fixture for a different scholarship. Show the candidate beside the 31 October NMMSS record. An old release loses on issue date. A different scheme fails the scope check even if one date matches. Read the two stable event IDs, event count, dates and unrelated record directly from the calendar. The operation trace should show zero calendar or outbox writes, the outbox should remain empty and the school should still own the case. Replaying the accepted release also preserves all three calendar entries and the empty outbox. [Scope fixtures and release gates](evaluation.md)

## Cut for a 2 minute 20 second recording

| Time | Shot to keep |
| --- | --- |
| 0:00–0:15 | A submitted case on 1 Oct. Introduce the student’s question and name the school as the current owner. |
| 0:15–0:45 | The October extension. Hold the original and revised provider readbacks on screen long enough to compare each event’s ID and date. |
| 0:45–1:15 | Advance to 29 Nov. Have the judge return the case. Show the reason, the student’s simulated correction and the correction receipt. |
| 1:15–1:40 | The student reviews the local recipient and exact message. Cut from explicit approval to the matching outbox row. |
| 1:40–2:00 | Acknowledge receipt. Give viewers a moment to name the next owner. Then show the school's separate verification move the case to District. |
| 2:00–2:20 | The district verification record and the completed handoff sheet. Leave both authority receipts readable in the closing shot. |

For a live review, allow a judge to stop on any record or choose the scope challenge. If a provider readback fails, show the pending effect and the last confirmed value. Resume from that operation once the service recovers. Label any recorded segment at the point where playback begins. Check captions and legibility at the shared video size before submitting.
