# One refund, then a busier morning

**Demonstration plan · 2 minutes 20 seconds.** Open with one person typing one errand into an empty desk. Then switch to the practice household and show what the desk can do with scoped permission. Keep the simulated clock and planner mode visible in the recording. Every message, account, amount and appointment in the practice household is synthetic. [Run the local build](build.md#run-the-local-build)

Start with “The shop said it would refund me. Can you help me check on Friday?” The person can type that sentence or paste the relevant line of an edited sample message. Save the open errand and its next check. Pause on what the desk can honestly say at this point. The person has a promise and a day to check. Relay has never read their account.

## Prepare the fixture

- Prepare a first-use state with one synthetic shop message, zero connected sources and no standing permissions. Saving the errand should produce zero provider reads, messages or payments. The first screen should give the person a useful next step even if they decline every connection.
- In a separate, returning-user state, seed the Monday 23 November 2026 IST session with one ₹1,249 return and a merchant promise. This person has allowed the desk to check the specific account for that return. Initially its ledger has no matching posted credit.
- Give the desk permission to book one free broadband visit on Tuesday afternoon, 24 November. The provider offers 11 am and 3 pm. An existing household commitment occupies 11 am. The household controls that event.
- Seed the electricity account with its ₹900 limit. Deliver the ₹850 invoice and its replacement for ₹1,180 **before the first payment decision**. Both versions refer to the same unpaid bill.
- Start with no booking, no managed service-visit calendar entry and no bill payment. Give the judge separate controls over the provider records. The agent can inspect those records and exercise its own scoped tools. Only the responsible provider can issue a settlement, booking confirmation or account-closure record. [Proposed architecture](architecture.md)

Run `npm run demo:evidence -- unrelated-credit` and `npm run demo:evidence -- matching-credit` from a second terminal while the practice desk is open. Choose **Check your errands** after each event and compare the brief with `/api/fixture/refund`. After a practice payment is accepted, `npm run demo:evidence -- settle-bill` publishes the biller's matching settlement. For the library example, save “Track my membership with Practice library reference member-17 until it is closed”, confirm the receipt plan for `member-17`, and allow its read. Publish `membership-acknowledged` and then `membership-closed` through the same command and check after each. These commands write synthetic records directly to the fixture stores. They target `.relay/demo` by default. For another practice directory, set `RELAY_DATA_DIR` in the operator terminal. Match the running desk's `RELAY_CLOCK` if it overrides the fixture date.

## Try an issuer of your own

Use a running practice desk and a second terminal pointed at its practice directory. The operator can choose any synthetic issuer, subject, record type and required status. This rehearsal uses a community centre and a returned key.

1. Run `npm run demo:evidence -- receipt-source practice-centre "Practice community centre"`. Save “I returned the key to the community centre. Can you check on Friday?” In **Set up a practice check**, choose **Watch for a receipt** and enter `practice-centre`, `key-17`, `key-return` and `received`. Confirm the plan and allow the issuer receipt read in **Permissions**.
2. Run `npm run demo:evidence -- receipt-record practice-centre key-17 acknowledgement pending ack-1`. Select **Check your errands**. The acknowledgement appears as issuer activity and the errand stays open.
3. Run `npm run demo:evidence -- receipt-offline practice-centre`, then publish the matching record with `npm run demo:evidence -- receipt-record practice-centre key-17 key-return received proof-1`. Check the desk again. It shows the issuer outage and preserves the previous successful check. The fixture's native read log at `/api/fixture/receipt` shows the two failed attempts.
4. Run `npm run demo:evidence -- receipt-online practice-centre` and check again. The card shows the matching receipt `proof-1`. Compare its issuer and reference with the native record. The receipt timestamp comes from the operator’s `RELAY_CLOCK`.

## Follow the session

| Time | What happens on screen | What the audience can verify |
| --- | --- | --- |
| 0:00–0:18 | Type the refund request, confirm Friday and choose **Save this errand**. Keep the account disconnected. | The next check tells the person to look for the credit. The shop message is visible as a promise. The desk has zero verified credits and zero provider reads. |
| 0:18–0:48 | Switch to **Returning user · permissions already granted**. Show the separately approved Tuesday-afternoon booking and electricity limit. The desk rejects the busy 11 am offer, books 3 pm and records it in the calendar. The merchant promise and revised invoice arrive. | One provider booking and one matching calendar entry. The original commitment remains at 11 am. The refund stays open. The revised bill has no payment attempt. |
| 0:48–1:12 | Open the person’s brief. The only new decision is the ₹1,180 electricity bill. Show the earlier ₹850 version, the ₹900 cap, **Pay ₹1,180 once** and **Leave unpaid**. Open the other errands on request. | Only the bill interrupted this returning-user session. The provider confirmed the booking. The refund still awaits a matching credit. Count permission setup separately. |
| 1:12–1:35 | Let the judge choose the bill decision. If they approve, show the exact payee, amount and revision they approved. If they defer, continue with the other work. | Approval applies once, and a matching settled receipt from the biller closes that invoice. A processing acknowledgement leaves it pending. Deferral makes zero payments. The standing cap stays at ₹900 in both branches. |
| 1:35–1:55 | Let the judge post a credit of the same amount for a different return. Then supply the credit for this return, or withhold it. | Only the matching incoming credit for the authorized account, return reference, currency and amount settles the job. Withholding it keeps a truthful open item while the booked visit stays booked. |
| 1:55–2:20 | Invite an unfamiliar request in the judge’s own words, such as “Track when my library membership closes.” Identify the reference and the library record needed to finish. Leave the final brief visible. | The same intake accepts this fourth outcome. If a permitted source is available, its matching closure record can finish the errand. A receipt for the request leaves it open. The person retains the decision to cancel. |

At the end, let the judge inspect the three separate records for the appointment offer, confirmed booking and matching calendar entry. The booking proves the agreed visit was scheduled. The person may still be waiting on a refund or an invoice settlement at the close of a successful demonstration.

## Let the judge break the plan

To reproduce a calendar conflict through the brief, use a fresh practice directory for both terminals.

1. Run `npm run reset -- --cold`. In the visit’s permissions, allow **Calendar availability**, **Provider availability** and **Free booking**. Leave **Calendar entry** ungranted. Check the errands and find the provider’s confirmed visit.
2. In the operator terminal, run `npm run demo:evidence -- visit-conflict`. This adds a synthetic household commitment during the confirmed visit. In the brief, allow **Calendar entry** and check again. The visit card shows the overlap.
3. Choose to handle rescheduling yourself or to keep checking for a free interval. Inspect `/api/fixture/visit` after the choice. Both the confirmed reservation and the household commitment retain their times.
4. To simulate the calendar owner independently moving their commitment, run `npm run demo:evidence -- visit-conflict-moved` and check again. With the watch choice and active permissions, Relay can add and verify the original visit. With personal follow-up selected, the person keeps responsibility for arranging a change.

Use a clean fixture for each challenge. A lost 3 pm slot should prompt a fresh availability check within the existing grant. If only a paid visit or a busy time remains, show the alternatives and leave the protected event alone. Changing the bill again after a one-time approval should retire the stale decision before any new payment. Dropping a provider response after an accepted write should trigger readback before a retry. Compare the provider records before and after the challenge. Preserve failed runs separately from the uninterrupted video. [Evaluation plan](evaluation.md)

For the unfamiliar task, let the judge choose the subject and issuer. If the available tools cannot read the specified proof, accept a tracking-only task or ask for clarification and disclose the limitation. Record this audience-chosen trial separately from frozen evaluation cases. For viewers who know the original project, the scholarship specialist offers a further example. A school’s receipt of a correction leaves verification outstanding through the separate institute and district stages. [Scholarship sources](scholarship-sources.md)

Report any later live run with its build revision, fixture, planner mode, observed decisions and provider effects. A static concept board can illustrate the intended brief. The required submission video must show working behaviour. [Event requirements](hackathon.md)
