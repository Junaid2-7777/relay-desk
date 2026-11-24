<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/wordmark-reversed.svg">
    <img src="docs/brand/wordmark.svg" width="300" alt="Relay Desk">
  </picture>
</h1>

**A personal staff for everyone.** Relay Desk is a proposed personal assistant for the errands you have to remember long after the call ends. You can hand it one job in your own words, whether that’s following up on a refund, finding an appointment around your shifts or checking what happened to a form. You decide what it can see and what it may do for you.

## Start with one errand

> The shop said it would refund me. Can you help me check on Friday?

That’s enough to start. Relay keeps the note and the day you want to check. When you come back on Friday, you can see what the shop promised and whether the refund is still open. You can prepare a draft message to the shop locally. Saving the note requires only the words you want to keep.

**Current stage · Local desk and synthetic household.** [Current milestone](roadmap.md#current-stage) · [Five-slide pitch](docs/relay-desk-pitch.pptx)

Run the local desk with Node.js 24 or newer. The app uses Node’s built-in HTTP and SQLite modules.

```sh
npm start
```

Saved notes stay in `.relay/desk.sqlite`. Open [Relay Desk on this computer](http://127.0.0.1:4173).

Use `npm run reset` to start the three-errand practice household on 23 November 2026 IST. Select **Check your errands** to see the morning brief. To start with no permissions, use `npm run reset -- --cold`. To reopen the practice desk, use `npm run demo`. Stop the desk before switching commands. The practice desk uses `.relay/demo` by default.

The optional n8n workflow gives the practice desk a model-backed intake. Import it into n8n and attach your OpenAI credential when you are ready to run synthetic cases. [Connect the practice planner](docs/n8n.md)

Run `npm run evaluate` for automated checks, or `npm run compare:planners` to replay twelve synthetic scenarios against fixed rules and authored planner responses. The comparison reports each interpretation and provider outcome. [Build and verification commands](docs/build.md#run-the-local-build)

Run `npm run compare:morning` to compare scripted manual follow-up with fixed rules for the cold and warm practice mornings. [Scripted morning baseline](docs/evaluation.md#scripted-morning-baseline)

Run `npm run compare:held-out -- .relay/evaluator.json` after freezing the build and collecting the evaluator's synthetic cases. The command pairs three n8n trials per case with a fixed-rule run. [Held-out comparison guide](docs/held-out.md)

## When you want Relay to take more off your hands

Suppose you’ve asked Relay to watch a return, book a free broadband visit on Tuesday afternoon and pay your electricity bill up to ₹900. Here is the proposed morning brief for one synthetic household.

| Your errand | What Relay would do | What you’d see |
| --- | --- | --- |
| “Did my ₹1,249 refund come through?” | With your permission, check the incoming credit against the return. If it’s overdue, prepare a follow-up for you to review. | **Waiting for credit.** The refund stays open until the matching credit posts. |
| “Book the broadband visit around my calendar.” | Check the offered times. The 11 am slot conflicts with an existing commitment. Book the free 3 pm visit with the provider and add it to your calendar. | **Booked for Tuesday at 3 pm.** You can open the provider confirmation and calendar entry. |
| “Handle this bill up to ₹900.” | The bill changed from ₹850 to ₹1,180. Hold payment and bring you the revised amount. | **Pay ₹1,180 once** or **Leave unpaid**. If you approve it, your next bill still has a ₹900 limit. |

<img src="docs/images/relay-desk-briefing.png" width="470" alt="Proposed morning briefing. The revised electricity bill needs one decision. Relay is watching for the refund credit and the broadband provider has confirmed Tuesday at 3 pm.">

## Can it handle a different errand?

A student waiting for a scholarship decision needs to know which office still has the application. Someone closing a library membership needs confirmation from the library. Both should be able to start by saying what they’re waiting for. A reply saying “we received your request” leaves the errand open. If Relay has no authorized way to check the outcome, it should say what is missing. [Product brief](docs/problem.md) · [Scholarship example](docs/scholarship-sources.md)

The evaluation asks someone outside the team to supply an unfamiliar errand after the build is frozen. It also tests whether people can start without connecting accounts, whether Relay stays within permission, and how many checks a person still has to do themselves. [Evaluation and baselines](docs/evaluation.md)

## Project materials

Prepared for **Homingo Hack Days, Agents A3 · A personal staff for everyone**. The practice build uses synthetic records and amounts. Live model evaluation and participant testing are pending. Codex assisted with research, writing, design and implementation. [Official brief](https://hackathon.homingo.co.in/hackathons/edition-01/problem-statements#a3)

- [A3 design audit](docs/decision.md) · [Research and provider sources](docs/sources.md) · [Everyday experience](docs/experience.md)
- [Build order](roadmap.md) · [First build review](docs/build.md) · [Contributor guide](agents.md)
- [Judge walkthrough](docs/demo.md) · [Submission checklist](docs/hackathon.md)
- [Design guide and logos](DESIGN.md) · [Printable identity sheets](docs/brand/identity.pdf) · [Editable identity source](docs/brand/identity.pptx)
