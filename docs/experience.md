# The household briefing

A household owner leaves for work with three jobs on the desk. Relay can book a broadband visit around their calendar, watch for a promised refund and handle electricity bills within an agreed limit. When the owner checks in, the first screen should tell them what needs their judgement, what Relay did and what someone else still owes.

## Monday morning

<img src="images/relay-desk-briefing.png" width="500" alt="Proposed briefing for a synthetic household on 23 November 2026. Only the revised electricity bill needs review. The merchant refund is still pending and the provider confirmed Tuesday's broadband visit at 3 pm.">

**Review revised bill** opens the earlier and current invoices side by side. Show the payee, account reference, dates and amount for each. Put the household’s standing ₹900 limit immediately below the new ₹1,180 total. Explain that the decision applies to this version of this invoice. Present **Pay ₹1,180 once** and **Leave unpaid**. Choosing the one-time exception authorizes the local simulator to pay that version, and the ₹900 standing limit still applies to the next bill.

After approval, show the local payment action and its status. If the writer loses its response, say **Checking whether the payment went through** and reconcile the existing operation. Mark the bill settled only after reading a matching settlement receipt. A new invoice revision while the owner is reviewing the bill retires the old decision and shows what changed. Deferring the bill returns the owner to the brief without reprompting them on every refresh.

## Work the owner can leave on the desk

| Delegated outcome | What the owner sees today | What counts as proof |
| --- | --- | --- |
| Recover the **₹1,249 merchant refund** | **Waiting for credit.** Open the merchant’s promise, the last check of the authorized account and the next agreed checkpoint. If it passes, offer a follow-up for review. | A posted incoming credit on the scoped account matching the amount, currency and return reference. A credit of the same amount for another return leaves this case open. |
| Arrange **one free Tuesday afternoon broadband visit** | **Booked for Tue 24 Nov, 3 pm.** The 11 am offer overlapped a household commitment. The permitted 3 pm booking has a provider confirmation and a calendar entry. | The provider’s confirmed booking for the correct service, date, time and zone. Show calendar readback separately. If the booking is confirmed but the calendar is unavailable, keep the booking and disclose the calendar problem. |
| Pay the **electricity account within ₹900** | **Needs your review.** The original ₹850 invoice was replaced by ₹1,180 before any payment. Hold the payment while waiting for the owner’s decision. | A settled receipt matching the exact invoice, payee, currency and amount authorized for that payment. |

The brief interrupts the owner once for this set of facts. Relay can still work on the refund and booking while the owner considers the bill. Open any row to see the original instruction, permission, next owner, next check and the issuer’s record. A single missed check stays attached to the affected job. Keep last successful check and last event as separate dates. An unavailable issuer should yield a message such as **The last ledger check was Monday. Relay couldn’t check for a newer credit.** A quiet feed with a successful read can report a fresh check with no new record. [Delegation and evidence contracts](architecture.md)

## Giving Relay a new job

Start with an outcome in the owner’s own words. Relay repeats the outcome, the exact scope of the access it needs, what it may do independently, and the record that will finish the job. For the broadband visit, the owner should be able to see **One appointment · Tuesday afternoon · Free · Keep existing commitments** before delegating. If the remaining offers all require a fee, a different day or moving an event, Relay returns with those specific choices.

For unfamiliar work, ask for the missing evidence at intake. “Watch for my old library membership to close” needs the membership reference and a source that can confirm closure. If only an acknowledgement is available, keep the case open and show the missing confirmation. The owner can inspect or revoke a delegation at any time. Withdrawing permission stops future work and keeps the history of receipts already recorded.

## A briefing that works on a phone

Read the decision first, including the previous value, the new value and the owner’s rule. Put completed or waiting work in a calm list below. Use a text label with every status symbol. Keep the decision visible until resolved, and leave provider evidence accessible from each item. Use the carbon-copy receipt treatment for the decision and save the melon tab for a genuine exception. [Identity system](../DESIGN.md)

At 320 CSS pixels, stack the revised amount, permission and choices in reading order. Give controls visible keyboard focus and touch targets of at least 44 by 44 CSS pixels. Opening a decision places focus at the invoice heading. Closing it returns focus to the invoking control, or to the updated briefing when that control retires. New receipts announce once without stealing focus. Reduced-motion mode updates the text and state immediately.

Use the synthetic Monday briefing for a future walkthrough. Ask an owner to identify their one decision, find the refund proof that is still missing, and explain what paying this bill does to next month’s limit. Repeat with keyboard navigation and 200% text zoom. Record errors and the detail the owner had to hunt for. These checks specify the intended experience. The current artwork is a design study. [Evaluation plan](evaluation.md)
