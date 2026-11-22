# Problem statement

**After filing, a student should be able to put the application down. When they come back, they should know who has it, whether they owe anyone a response, and which record backs that answer.** Deadline Relay would keep that account for one scholarship case, revise the student's local calendar when dates move, and prepare a follow-up when a correction changes hands.

Submission starts a process with deadlines owned by different people. In the National Means-cum-Merit Scholarship Scheme (NMMSS), the student submits, the Institute Nodal Officer verifies at Level 1, and the District Nodal Officer verifies at Level 2. A Ministry notice explicitly asks already-submitted applicants to ensure that both verifications happen by their respective deadlines. Those dates changed repeatedly in academic year 2026–27. In a separate audit of pre- and post-matric schemes, India’s Comptroller and Auditor General identified delayed NSP verification as one of several reasons for non-disbursal. [Ministry schedule and verification instructions](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2330936&lang=1&reg=3) · [CAG Report No. 36 of 2025, §2.13.4.2](https://cag.gov.in/uploads/download_audit_report/2025/Report-No.-36-of-2025_Civil_English_03-02-2026-signed-069ca36644bcd89.99772695.pdf)

The first user is the person in the family who took responsibility for following up after filing. Today a calendar entry can tell them when an office is due to verify. When the school asks for a new copy of a document, the family must also remember what to replace, whether the school received it, and whether anyone has verified it since. A school counselor helping the family should be able to read the same handoff with them, without needing a roster of students or access to their accounts.

## What the family should see

Imagine reopening the case on the simulated 29 November, after the school acknowledged the replacement copy. The handoff should read like this.

> **Your school has the corrected copy.** The school confirmed receipt. Its verification is still due **30 November**. You have nothing to resend. The next update to look for is the school's verification record.

The family should be able to open two pieces of evidence from that summary. The school's case receipt explains “has the corrected copy.” The effective Ministry notice explains “due 30 November.” If the school later verifies, the next owner becomes the district and its own deadline comes forward. The family can reconstruct what changed without reading a log first. [Historical Ministry notice](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2330936&lang=1&reg=3)

| When the record changes | What the family gets | What settles the handoff |
| --- | --- | --- |
| A newer notice moves the school's deadline | The previous date, revised date, and school reminder updated in place. A district change has its own source field and reminder. | Read the reminder back from the calendar. School verification is still pending. |
| The school returns an unreadable attachment | The school's reason and one task for the student to supply a legible copy. Keep the 30 November date attached to school verification. The student's correction date is unspecified in this fixture. | The student records the correction in the simulator. Its receipt hands review back to the school. |
| The correction is recorded | If a receipt check is due, offer one follow-up for the student to review. Show the exact recipient and message before asking to queue it locally. | An outbox receipt settles queuing. The school's acknowledgement settles receipt of the correction. |
| The school verifies | Show its verification record and the district's pending review. The student can put the case down again. | A separate district verification for this case completes the two-stage follow-up. |

If the school deadline passes in silence, keep the case open. Show the last case record, the date that passed, and the office that still owes verification. If two applicable notices disagree, keep the last confirmed reminder and let the family inspect the disputed dates. Neither passage of time nor a reassuring message supplies an officer's verification. [State and evidence rules](architecture.md)

## Why A3

A student gives the agent a durable objective and can leave it waiting for new evidence. The agent plans across a public source reader, case history, calendar, and local outbox. A date change, a correction, a delayed acknowledgement, and a verification receipt trigger different tool decisions. The outcome is a verified handoff, with tool records the judge can inspect. [Official A3 statement](https://hackathon.homingo.co.in/hackathons/edition-01/problem-statements#a3)

## Hackathon boundary

One NMMSS historical workflow, one synthetic filed application, and a few out-of-scope notices and state changes for testing. Provide versioned public-source evidence, a local calendar, and an independent simulator for student, institute, and district events. Use synthetic case IDs and neutral attachment descriptions. The project helps with the student’s own follow-up. Institutions retain authority over verification, eligibility, and disbursement. The demonstrated case ends at simulated district verification.
