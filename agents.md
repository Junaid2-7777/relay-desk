# Working on Relay Desk

Relay Desk is a proposed personal chief of staff. One household delegates outcomes, grants specific powers and gets a brief when something needs a decision. The repository currently contains research, the design and build plan, and visual materials. Start at the first unfinished [roadmap milestone](roadmap.md). The [first build review](docs/build.md) specifies the common fixture.

## Where decisions live

| Change | Start here |
| --- | --- |
| Who the product serves and why the scope changed | [Product brief](docs/problem.md) and [A3 audit](docs/decision.md) |
| What the person may see, approve or revoke | [Household experience](docs/experience.md) and [delegation contract](docs/architecture.md) |
| Tool writes, evidence, failures or claims about work saved | [Architecture](docs/architecture.md) and [evaluation fixtures](docs/evaluation.md) |
| Public claims or a proposed integration | [Source register](docs/sources.md) |
| A logo, the household study, presentation or Canva asset | [Identity guide](DESIGN.md) and [judge walkthrough](docs/demo.md) |
| Submission status and deliverables | [Event checklist](docs/hackathon.md) |

## Preserve the delegation

- Start with the person's desired outcome, permitted actions and evidence that would settle the job. An unfamiliar tracking job should fit the existing intake when its proof is reachable. A missing adapter is a capability gap. Record it explicitly.
- Separate the household's instructions from what a message says. Tie each grant to a subject, operation, destination, limit and lifetime. A one-time payment exception applies only to the displayed payee, amount, currency and invoice revision. Revoking a grant stops future work under it.
- Read outcomes from their owners. A merchant promise leaves the refund open. A booked visit needs provider confirmation and its calendar readback. A payment initiation leaves settlement pending. After an ambiguous write, look up the original operation before retrying.
- Preserve the original scholarship case as a specialist regression. Dates come from scoped public evidence. Only the school can verify its stage and only the district can verify the next one. [Historical source register](docs/scholarship-sources.md)
- Keep all fixture households, communications, financial records and recipients synthetic. Use the smallest permitted read. Calendar availability needs an interval. It rarely needs a meeting title. Show the last successful check separately from the last event.
- Score human attention honestly. Keep first-use consent, repeat decisions, interruptions, lookups and verified outcomes distinct. Label proposals, simulation runs and empirical observations accurately.

## Commit and verify

Before changing behavior, name the input, expected owner, authorized effect and required proof. Use the closest existing fixture. Commit each coherent increment and stage only its files. For proposal work, check source claims, relative links and heading anchors, inspect changed artwork at reading size, and run `git diff --check`. Once a runtime exists, document and exercise its actual start, reset and evaluation commands.

Keep the editable [household brief](docs/images/relay-desk-briefing.svg) and its [README image](docs/images/relay-desk-briefing.png) aligned. When revising the identity sheets or pitch, update the relevant local master and inspect each page of its Canva edition. Keep private edit invitations out of the public repository.

## Writing for Junaid

Omit “Cheers” and “Cheers!” as sign-offs in replies, PR comments, reviews and other messages written on Junaid's behalf, including when an older template requests that closing.
