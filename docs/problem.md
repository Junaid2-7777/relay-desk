# Problem statement

**Build a personal agent that takes responsibility for the next handoff after a student submits a scholarship application. When a notice changes a deadline or an institute returns the case for correction, it should work out what the student can do, make the reviewed changes across their local calendar and follow-up tools, and follow the case until it has independent evidence of verification.**

Submission starts a process with deadlines owned by different people. In the National Means-cum-Merit Scholarship Scheme (NMMSS), the student submits, the Institute Nodal Officer verifies at Level 1, and the District Nodal Officer verifies at Level 2. A Ministry notice explicitly asks already-submitted applicants to ensure that both verifications happen by their respective deadlines. Those dates changed repeatedly in academic year 2026–27. In a separate audit of pre- and post-matric schemes, India’s Comptroller and Auditor General identified delayed NSP verification as one of several reasons for non-disbursal. [Ministry schedule and verification instructions](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2330936&lang=1&reg=3) · [CAG Report No. 36 of 2025, §2.13.4.2](https://cag.gov.in/uploads/download_audit_report/2025/Report-No.-36-of-2025_Civil_English_03-02-2026-signed-069ca36644bcd89.99772695.pdf)

The first user is a student or family who has filed and is waiting on school or district action. They can find a date on the portal, but still have to decide which update applies, find the next responsible person, complete corrections, and check whether acknowledgement actually led to verification. Deadline Relay carries those obligations between events. A school counselor or education nonprofit is a candidate distribution partner. The prototype tests whether the agent can do the work correctly. Demand and willingness to adopt remain untested.

## What the agent owns

- **Keep the case clock grounded.** Track each published milestone independently. Match notices to scheme, academic year, cohort, stage and applicable geography. Preserve the cited source and effective version for every date used. A changed date updates only obligations that depend on it.
- **Act on the actual blocker.** Read the case timeline. If the institute returns a case for correction, stop routine verification nudges, show the recorded reason, and give the student a correction task. The student controls the correction. After an independent correction receipt, the agent can propose one local follow-up for review and verify that the sandbox has queued it.
- **Follow the handoff.** A case that is awaiting institute verification still needs institute verification after a draft, a send record, or a receipt acknowledgement. An explicit institute verification advances the case to district review. Close the demo case only on the district’s explicit verification record for that case and stage.
- **Handle doubt visibly.** If sources materially disagree on the same scope, the agent shows the conflicting evidence and keeps the last confirmed calendar entries. If proof of a transition is absent, it shows who owns the next action and what evidence is missing.

## Why A3

A student gives the agent a durable objective and can leave it waiting for new evidence. The agent plans across a public source reader, case history, calendar, and local outbox. A date change, a correction, a delayed acknowledgement, and a verification receipt trigger different tool decisions. The outcome is a verified handoff, with tool records the judge can inspect. [Official A3 statement](https://hackathon.homingo.co.in/hackathons/edition-01/problem-statements#a3)

## Hackathon boundary

One NMMSS historical workflow, one synthetic filed application, and a few out-of-scope notices and state changes for testing. Provide versioned public-source evidence, a local calendar, and an independent simulator for student, institute, and district events. Use synthetic case IDs and neutral attachment descriptions. The project helps with the student’s own follow-up. Institutions retain authority over verification, eligibility, and disbursement. The demonstrated case ends at simulated district verification.
