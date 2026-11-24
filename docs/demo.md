# One refund, then a busier morning

## Recorded walkthrough

[Watch the Relay Desk practice recording](media/relay-desk-practice.mp4). The silent video includes on-screen captions and uses separate local directories for the private desk and the synthetic fixed-rule practice household.

- **0:00–0:26.** Enter the refund note, review the Friday 27 November check and save. Reopen the desk and find the original note and open errand. The inspection trace shows zero account permissions and provider reads.
- **0:26–0:46.** Check the returning household. The revised ₹1,180 bill needs a decision under the ₹900 standing limit. Provider and calendar records agree on the free 3 pm visit. The original 11 am calendar commitment stays in place.
- **0:46–1:04.** The shop promise and a same-value credit for another return leave the refund open. The fixture operator publishes the ₹1,249 credit for `return-demo-1249`.
- **1:04–1:13.** The next check verifies the refund. Open **Refund evidence and access** to read **Posted credit demo-posted-refund** alongside the verified status. The bill still awaits a decision.

## Live walkthrough plan

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

## Book through a different practice provider

Start `npm run reset` in a fresh practice directory. Point the operator terminal at the same `RELAY_DATA_DIR` and use the default Monday 23 November 2026 clock. The evaluator can choose a new synthetic issuer, service, reference, and appointment window. This example uses a free equipment induction at a practice tool library.

1. Publish a household commitment, a free offer that overlaps it, and a paid offer within the requested window.

   ```console
   npm run demo:evidence -- calendar-commitment induction-conflict 2026-11-24T16:25:00+05:30 2026-11-24T16:40:00+05:30 "Practice household commitment"
   npm run demo:evidence -- visit-slot induction-busy practice-tool-library equipment-induction seat-47 2026-11-24T16:25:00+05:30 2026-11-24T16:35:00+05:30 0
   npm run demo:evidence -- visit-slot induction-paid practice-tool-library equipment-induction seat-47 2026-11-24T16:45:00+05:30 2026-11-24T16:55:00+05:30 10000
   ```

2. Enter “Could you find a free Tuesday equipment induction at the practice tool library?” in ordinary intake. Review and save the errand. In **Set up a practice check**, choose **Reserve a free slot**. Enter `practice-tool-library` as the issuer, `seat-47` as the record reference, and `equipment-induction` as the service. Set the earliest and latest times on Tuesday 24 November to 4:15 pm and 6:00 pm IST, then save the agreed check. Check the errands before granting access. The existing broadband permission covers its own visit. The new errand stays open without a provider read or reservation.
3. Open the new errand’s **Permissions** and allow **Calendar availability**, **Provider availability**, and **Free booking**. Check again. The paid and busy offers leave the errand open. Publish the free replacement and check again.

   ```console
   npm run demo:evidence -- visit-slot induction-free practice-tool-library equipment-induction seat-47 2026-11-24T17:00:00+05:30 2026-11-24T17:30:00+05:30 0
   ```

4. The provider confirms one free 5 pm reservation while calendar entry is pending. Allow **Calendar entry** and check again. The brief now shows the calendar entry. In `/api/fixture/visit`, match the offer and reservation on issuer, service, reference, and time. The linked calendar row uses the same reservation ID and times. The protected commitment remains at 4:25 pm.

`visit-slot` publishes a native offer with a fee in whole paise. Use `0` for free and supply ISO timestamps with seconds and an explicit offset. Reuse a slot ID to update its terms for the same provider, service, and subject. Use `visit-slot-withdraw SLOT_ID` to make an existing offer unavailable. Each changed offer gets a new revision. These commands publish synthetic fixture records. The desk applies grants and makes its own reservation and calendar checks. [R7 acceptance](evaluation.md#one-household-three-independent-outcomes)

Before the desk prepares a reservation for a visit you added, **Edit visit check** lets you correct the issuer, service, reference, or window. Saving changed terms keeps your note and chosen check. Review the new permissions before checking again. Once a booking attempt starts, the desk keeps its original terms for confirmation and recovery.

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
