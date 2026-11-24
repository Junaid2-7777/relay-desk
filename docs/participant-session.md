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
3. **Warm Monday.** Start a fresh `npm run reset`. Ask the person to check the three errands, then ask “Which item needs you now? What would paying ₹1,180 once do to your next bill? How do you know whether the refund arrived and whether the visit is booked?” Let them open the source details and decide what to do about the bill. Check the native provider records after the participant answers. The first warm check produces one bill decision, a confirmed 3 pm visit with a calendar entry, and an open refund. [Run the local build](build.md#run-the-local-build)

Read each task aloud without naming a control. Start timing when the prompt ends and pause for observer setup such as restarting the desk. Record the outcome and elapsed time when the person finishes, stops, requests help or reaches the agreed cutoff. If they continue with help, record the first prompt you gave, what they did next and the assisted elapsed time separately. For a manual comparison, give the same starting reminders and access to the same fictional source records at the same checkpoints. Use a fresh copy for each arm and record the order so a second attempt can be interpreted in light of the first. [Comparison protocol](evaluation.md#compare-work-and-attention)

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
