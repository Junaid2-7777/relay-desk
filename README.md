# Deadline Relay

**You submitted the application. The next deadline belongs to someone else.**

Deadline Relay is a personal agent for students and families following up on an already-submitted scholarship application. It reads official notices, tracks who owes the next action, and reworks the student’s calendar and follow-up when a deadline moves or the application is returned. It keeps the case open until it sees verification from the responsible authority.

This is the selected proposal for Homingo Hackathon Edition 01, **Agents A3 — A personal staff for everyone**. The repository contains the specification and research. The runnable agent, evaluation results, and submission video are in the build plan. [Official A3 statement](https://hackathon.homingo.co.in/hackathons/edition-01/problem-statements#a3)

## What judges can change live

1. A student has filed their scholarship application and is waiting for school verification. A historical Ministry notice moves the school deadline from **15 November to 30 November** and the district deadline from **30 November to 15 December**. The agent updates the two affected reminders in a real local calendar. A separate calendar entry stays in place. [Earlier Ministry notice](https://www.pib.gov.in/PressReleseDetailm.aspx?PRID=2317657&lang=1&reg=3) · [Revised notice](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2330936&lang=1&reg=3)
2. The judge switches to the simulated school’s view and returns the application for a correction. The agent reads the reason, identifies who must act next, and prepares a specific handoff. The student controls the correction, and an explicit approval is required to queue a follow-up in the local sandbox.
3. The school acknowledges receipt. The agent keeps the verification deadline open. After the simulated school verifies the case, it follows the handoff to the district. Only the district’s own verification record closes the case. The judge can also introduce an old or differently scoped notice and inspect what the agent leaves untouched.

The notices are public government records. Every student, status change, correspondence, and calendar entry in the demo is synthetic. The demo uses a historical clock and local services.

## Documentation

- [Problem statement](docs/problem.md) defines the user, the failure, and the scope of the agent’s job.
- [Decision record](docs/decision.md) compares the alternatives and records the checks that changed the recommendation.
- [Sources and precedent](docs/sources.md) records the official evidence and its limits.
- [Architecture](docs/architecture.md) specifies the agent loop, source rules, provider contracts, and recovery.
- [Evaluation](docs/evaluation.md) defines matched baselines, release gates, and the evidence to record.
- [Demo](docs/demo.md) gives the live sequence and short video script.
- [Build plan](docs/build.md) sets the solo milestones.
- [Hackathon](docs/hackathon.md) records event rules and the submission checklist.

## Local setup and disclosures

Clone the repository and open this README to review the specification. The runnable release will include a pinned setup and commands to start the local services, reset the historical demo, and run the evaluation. The final README will list the runtime dependencies, data sources, model and AI tools used. Codex assisted with research and drafting the specification.
