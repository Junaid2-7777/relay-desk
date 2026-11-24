# Participant session worksheet

Copy this sheet for each session. Invite five adults who recently waited on a shop, office or service provider. Include people who use paper, memory and apps to keep track. Ask what finally told them their last errand was settled. Use the fictional examples for every task and record an anonymous session code. Let the person skip a task or decline access. Keep account details, private messages and names out of the notes. [Research protocol](problem.md#what-we-know-and-what-we-need-to-learn)

```text
Session code __   Build revision __   Observer __   Date __
Usual tracking method __   Device / keyboard / zoom __
Task order __   Planner mode __   Fixture clock and cutoff __
Participant agreed to take part __   Tasks skipped __
```

## Give the tasks

Use a fresh `RELAY_DATA_DIR` for each task and arm. Stop the current server before switching tasks. Start each task with `RELAY_CLOCK` set to `2026-11-23T09:00:00+05:30`.

1. **Blank desk.** Run `npm start`. Say “A fictional shop said it would refund you. Save what you want to check on Friday.” Offer the sample sentence if they ask for one. After they save, restart with the same data and set the clock to `2026-11-27T09:00:00+05:30`. Ask them to find their chosen check and explain who can verify the credit. Record whether they thought account access was required. [First-use acceptance](evaluation.md#first-use-acceptance)
2. **Cold Monday.** Start a separate `npm run reset -- --cold`. Ask the person to keep the refund account private, allow Relay to see only when their calendar is busy on Tuesday afternoon, and run a check. Let them find the access controls and explain what Relay can do next. Record any additional permission they choose, any refusal and the actual sources checked. The prescribed choices produce one scoped availability read, zero ledger reads and zero bookings.
3. **Warm Monday.** Start a fresh `npm run reset`. Ask the person to check the three errands and find any item that needs them. Let them inspect the source details. Ask “What would paying ₹1,180 once do to your next bill? How do you know whether the refund arrived and whether the visit is booked?” Capture the first result before they act on the bill. Then let them choose what to do and capture the result again if they act. The first warm check produces one bill decision, a confirmed 3 pm visit with a calendar entry, and an open refund. [Run the local build](build.md#run-the-local-build)

Read each task aloud without naming a control. Start timing when the prompt ends and pause for observer setup such as restarting the desk. Record the outcome and elapsed time when the person finishes, stops, requests help or reaches the agreed cutoff. If they continue with help, record the first prompt you gave, what they did next and the assisted elapsed time separately. For a manual comparison, give the same starting reminders and access to the same fictional source records at the same checkpoints. Use a fresh copy for each arm and record the order so a second attempt can be interpreted in light of the first. [Comparison protocol](evaluation.md#compare-work-and-attention)

## Run the manual first morning

Open `npm run manual:session -- cold` or `npm run manual:session -- warm` in a terminal. Each invocation starts with fresh synthetic records at 9 am IST on 23 November 2026. It uses its own temporary data and removes it when the session ends. Cold begins with every source unasked. Warm begins with the same standing permissions as the warm practice desk.

Run `reminders` to read the starting reminders aloud. Let the participant say which source they would check, which permissions they would give, and which terms they would act on. Enter the matching command and show or read its result. Use `help` as the facilitator’s reference and keep the API inspector closed. The terminal takes only the listed commands and synthetic offer IDs. Keep private information and participant names out of it.

- **Consent and lookup.** `allow availability` and `decline credits` record the prescribed cold choices. `look availability` then shows only the chosen window and its busy intervals. Enter `look bill`, `look slots`, `look shop` or `look credits` only when requested. The participant can decline a scope or stop at any point.
- **Appointment.** After the participant compares availability and offers, use `choose OFFER-ID` to show the selected terms. Submit only after their confirmation with `book OFFER-ID`. `look booking` verifies the provider’s original reservation. Use `add calendar` when the participant asks to add that appointment, and `look calendar` when they ask to verify the entry and the interval. A submission alone does not confirm either outcome. Free/busy checks reveal intervals only, and the existing event stays in place.
- **Cutoff.** Use `finish` after the first-morning checks and before the participant acts on a bill exception. They can say which item needs a decision and explain the exact amount and standing cap. The manual session has no payment or deferral action. If you continue with the warm worksheet’s bill decision, record that separately after the comparison cutoff.

Keep the `Session trace` with the anonymous worksheet. Its setup and ongoing actions, native reads, write attempts, committed effects and matching readbacks come from this local practice run. A committed reservation with an unchecked receipt appears as a native effect with `reservation: false` under `matchedNativeEvidence`. Record what the participant noticed, actual attention occasions, elapsed time and help separately. Use `npm run compare:morning` for the scripted pair at the same cutoff. Those scripted counts are evaluation data. [Scripted first-morning baseline](evaluation.md#compare-work-and-attention)

## Capture what the desk did

At each capture, pause interaction, fixture updates and the task timer. In a second terminal run `npm run --silent observe:session`. Capture each task’s starting state and final state. On warm Monday, keep the result before the bill choice as well as any result after it. Set `RELAY_PORT` if the desk uses a different port. Record the server checkout’s build revision with `git rev-parse HEAD`. The command reads the running local desk and prints a JSON snapshot. It leaves the desk and provider logs untouched. The report carries the fixture time, planner mode, current permissions, check dates, household provider reads and failures, write attempts and committed effects. It omits note and draft text, recipients, record identifiers and calendar titles. The observer rejects a capture if the errands or native records change during inspection.

Compare the snapshots to find what changed during the task. On cold Monday, expect one free/busy read after the prescribed consent choices. On warm Monday, look for `decisionReady: "bill-review"` in the capture before the bill choice, and a visit with both `reservation: true` and `calendar: true` under `matchedNativeEvidence`. A false value means the current native records did not corroborate that claim. Record it with the session. A ready decision on screen can go unnoticed. Use your observations for attention, help, elapsed time and decisions the participant actually took.

## Record one block per task and arm

```text
Task __   Arm (manual / fixed-rule / model-backed) __   Starting permissions __
Unassisted elapsed __   Outcome (done / stopped / asked for help / cutoff) __
First help given __   Assisted elapsed __   Outcome after help __

Count                                      Setup     Ongoing     Total
Distinct consent choices                   __        __          __
Missing-field clarifications               __        __          __
Exception decisions presented / taken      __ / __   __ / __     __ / __
Manual source lookups                      __        __          __
Repeat prompts                             __        __          __
Occasions requiring attention              __        __          __

Consent granted, declined or withdrawn by scope __
What the participant thought was done or still open __
Confusion, missed intervention or next-check timing __
Actions the participant approved or submitted __
Independently verified result by errand and source __
Expected result the observer could not verify __
```

Count each consent choice once. Three scopes reviewed on one screen can be three choices in one occasion. Count lookups the participant performs separately from the desk’s provider reads. Verify a visit against its reservation and calendar entry, a payment against its accepted payment and matching settlement, and a refund against its posted matching credit. Use the practice provider records and desk trace to confirm zero effects where the person withheld access. Record unresolved outcomes and refusals alongside successes. Report first-use and assisted results separately from scripted evaluation and independently verified outcomes. [Evidence checks](evaluation.md#one-household-three-independent-outcomes) · [Inspection commands](build.md#run-the-local-build)

## Summarize the worksheets

Tally the paper worksheets by hand or run `npm run --silent summarize:sessions -- INPUT.json` after collection. Keep the input local and the original worksheets with their build revision, task order and independently verified evidence. The command prints aggregate JSON. Use `observed-participant-sessions` for records from people who agreed to take part. This example uses invented measurements to illustrate the format.

```json
{
  "schemaVersion": 1,
  "kind": "synthetic-format-example",
  "sessions": [{
    "code": "s-001",
    "runs": [{
      "task": "blank-desk",
      "arm": "fixed-rule",
      "cutoff": { "point": "saved-check-after-restart", "clock": "2026-11-27T09:00:00+05:30" },
      "outcome": "done",
      "unassistedSeconds": 42,
      "counts": { "ongoing": { "manualLookups": 0, "interruptions": 1 } }
    }]
  }]
}
```

- Give each worksheet an anonymous `s-` code followed by three to eight digits, with one record per task and arm. Tasks are `blank-desk`, `cold-monday` and `warm-monday`. Arms are `manual`, `fixed-rule` and `model-backed`. Use `skipped` for a task the person skipped. Leave an arm without a record when it was never offered or observation is missing.
- Record the first `outcome` as `done`, `stopped`, `asked-for-help`, `cutoff` or `skipped`. `unassistedSeconds` covers the first observation before any help. If the person continued with help, add `assisted` with its own `outcome` of `done`, `stopped` or `cutoff`, and `elapsedSeconds` for that assisted interval. Unknown times can be omitted or set to `null`.
- Fill `counts.setup` and `counts.ongoing` with observed nonnegative counts for `consentChoices`, `clarifications`, `decisionsPresented`, `decisionsTaken`, `manualLookups`, `repeatPrompts` and `interruptions`. Use `0` when you observed zero. Omit unknown values or set them to `null`. A total requires both phases for that measure. A skipped record carries no timing or workload.
- Record the known cutoff with its fixture `clock` and `point`. Use `saved-check-after-restart` for blank desk, `first-morning-checkpoint` for the first cold or warm check, and `after-bill-decision` for a warm observation that includes the choice. Omit the cutoff or set it to `null` when unknown. Use an explicit clock offset. Keep notes and other worksheet details on the worksheet.

Read the task and arm results with their recorded, attempted and missing denominators. The summary separates outcomes before and after help. Every elapsed or workload median gives the number actually observed. A desk and manual outcome is paired only for the same worksheet, task, comparable cutoff point and fixture instant. Paired elapsed and workload figures also require both completions in the same help group and an observation on each side. The warm bill choice falls after the manual comparison cutoff. The reported differences are descriptive, with task completion and independently verified errand outcomes recorded separately.
