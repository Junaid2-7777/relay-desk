# Why Relay Desk

**23 November 2026 · Product decision for Agents A3**

Keep the part of Deadline Relay that earned trust. It asked the right question about a school acknowledgement. Who can actually prove the work is finished? Apply that question to the household’s open commitments, and let the owner give permission once for routine work. The product becomes **Relay Desk**, a household chief of staff. Deadline Relay becomes its scholarship specialist.

## What the previous proposal actually established

At `e7b729d`, the repository contained a scholarship proposal, dated public-source research, a visual study, a state-machine design and a test plan. Its historical probe used typed dates and in-memory records. Its result concerned two reminder keys. The repository did not contain a runnable planner, measured user outcomes, provider integrations or a submission recording. The audit below assesses that revision as a proposal. Inspect it with `git ls-tree -r --name-only e7b729d` and `git show e7b729d:docs/evaluation.md`. The older candidate comparison is preserved in `git show e7b729d:docs/decision.md`.

Homingo publishes five judging criteria for the edition. The A3 statement gives those criteria a particular audience, people who currently do their own personal administration. It asks for an assistant they could trust with that work. [Official edition rubric](https://hackathon.homingo.co.in/hackathons/edition-01#judging) · [A3 statement](https://hackathon.homingo.co.in/hackathons/edition-01/problem-statements#a3) · [Official statement data](https://api.homingo.co.in/api/hackathons/edition-01)

| Published criterion | Evidence and gap at `e7b729d` | Consequence for this design |
| --- | --- | --- |
| Problem fit & impact | The Ministry notices established real deadlines and two offices with separate duties. One already-filed scholarship case gave us no evidence about the rest of a household’s week. The planned five-person study had no results. | Start with the adult who already coordinates calls, appointments and bills for the household. Observe which checks they would trust someone else to own and which decisions they want back. |
| Technical depth | The proposed case had a fixed set of actors and event types. Changing a school’s words tested interpretation inside that one workflow. | Accept a desired outcome, scoped permission and an agreed source of completion evidence. Resolve a calendar conflict and a changed invoice in the same session. Ask the judge to supply a fourth outcome outside the three examples. |
| Reliability & evaluation | The proposal specified unusually good failure cases for stale records and duplicate writes. All release thresholds were targets. None tested spending authority or a stale appointment offer. | Keep the fault tests, add changed prices, revoked permission, competing bookings and a credit for the wrong order. Score actual provider records, forbidden effects and avoidable interruptions. |
| Product & experience | A clear single-case screen answered who had the next step. Someone would still have to inspect each file to find the decision that mattered. | Lead with one answerable exception. In the worked session, a bill crosses a limit. The appointment can advance and the refund can wait without demanding attention. |
| Demo & communication | The planned walkthrough established how to read receipts. The presenter supplied the correction and both verifications. It would have been easy to mistake the judge advancing the fixture for the agent doing work. | Let the judge alter an input or withhold evidence. Show the agent’s response separately from what the provider records. Compare what the household had to decide with what the desk handled under its existing grant. |

## Why these three jobs belong together

A refund, a broadband appointment and an electricity bill compete for the same person’s attention while they wait on different people. Each requires a different use of authority. Follow up on money owed to the owner. Claim a permitted time on their behalf. Stop before spending beyond their instruction. The session only succeeds when these three behaviours coexist. An unresolved bill cannot stop a permitted booking, and a merchant’s promise cannot pad the number of finished jobs.

A single new outcome is the test of breadth. A judge can ask the desk to track the closure of a library membership. The desk needs the membership reference, the issuing library and the record that would show the membership closed. Until that record is available, it can explain what is outstanding. Tracking a closure gives it no permission to cancel a membership. [Worked household brief](problem.md)

The scholarship work still answers a harder specialist question. Public notices establish a deadline. Only the institute and then the district can verify a particular application. The four historical notices and the old probe belong to this example. They supply no evidence of refund settlement, household demand or time saved. [Scholarship source register](scholarship-sources.md)
