# Working on Deadline Relay

Deadline Relay follows one already-filed NMMSS scholarship application through school and district verification. At this revision the repository holds the proposal, research, visual study and build plan. Start at the first unfinished milestone in [roadmap.md](roadmap.md). The [first-case walkthrough](docs/build.md) defines the fixture to build against.

## Pick the right reference

| If the change touches | Read |
| --- | --- |
| What the family needs or what appears on the sheet | [Product brief](docs/problem.md) and [student experience](docs/experience.md) |
| The logo, colour themes, typography or use of the folded receipt | [Identity guide and master artwork](DESIGN.md) |
| A deadline, source scope or historical replay date | [Source register](docs/sources.md) |
| Ownership, writes, approval, retries or case freshness | [Architecture](docs/architecture.md) and the matching [evaluation fixtures](docs/evaluation.md) |
| What the presenter or judge can claim | [Demo runbook](docs/demo.md), [release gates](docs/evaluation.md) and [submission checklist](docs/hackathon.md) |

## Preserve the meaning of the handoff

- **Dates come from scoped public evidence.** Keep each stage, issuer revision and source together. Preserve date-only deadlines. Release historical inputs only when the simulated clock reaches their publication or, for an undated snapshot, its capture.
- **Ownership comes from the case record.** A return gives the student a correction task. Resubmission hands it back to the school. Acknowledgement settles receipt. Require the school's verification to move to the district and the district's own verification to close. Label the 30 November date as a school deadline in the 29 November example.
- **The student controls follow-up.** Review the exact local recipient, subject and body before queuing. Bind approval to the relevant case, return and draft versions. A changed case or draft can make an earlier approval obsolete. A queue receipt means “queued locally.”
- **Read effects from their owners.** Inspect the calendar's event UID and date, the outbox row and the simulator's authority record. The agent journal records intent and recovery progress. After an ambiguous write, reconcile the original operation before retrying.
- **Tell the family how fresh the answer is.** Track the last successful case read separately from the last event. If a check fails, show the last evidenced owner and what still needs checking. Keep examples, personal records and local recipients synthetic. Use only public scheme facts from real notices.

## Work in small commits

For a behavior change, write down the input, expected owner and expected provider effect first. Use the closest existing fixture. Keep the change and its matching evidence small enough to inspect in one commit. Commit each coherent increment and stage only its intended paths.

For a proposal edit, check changed claims against the source register, follow relative links and heading anchors, inspect the visual at its normal reading size if it changed, and run `git diff --check` before committing. The editable [handoff drawing](docs/images/handoff-sheet.svg) and its [README preview](docs/images/handoff-sheet.png) depict the same synthetic case. Update both when that example changes.

Once the runtime exists, use its documented setup and test commands. Record the planner mode, fixture version, provider readbacks and observed failures alongside results. Use future tense for planned work. Reserve measured claims for reproducible runs.

## Writing for Junaid

Omit “Cheers” and “Cheers!” as sign-offs in replies, PR comments, reviews and other messages written on Junaid's behalf, including when an older template requests that closing.
