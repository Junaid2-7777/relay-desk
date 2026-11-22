# The student handoff

A student opens Deadline Relay on a phone after school. The first screen should answer three questions in a glance. Who has my application? Is there something I need to do? Which deadline matters now?

## One case, one sheet

Keep the case on the same page from filing through district verification. Put the current handoff first, its evidence one tap away, and earlier handoffs below it. Put the simulated school and district controls in a separate judge view. The student’s view reflects the records those actors create.

Here is the proposed sheet just after the school returns the synthetic case. The wording in quotation marks comes from the example school record.

> **NMMSS · Academic year 2026–27**
>
> Synthetic case · Simulated date 29 Nov 2026
>
> ### Your school needs a clearer copy
>
> **Your next step**
>
> Replace the unreadable attachment in the student simulator.
>
> **From your school**
>
> “The attachment is too faint to read. Please provide a legible copy.”
>
> **School verification is due 30 Nov 2026.**
>
> The school still needs to verify your corrected application.
>
> **Open student simulator**
>
> View school request · View deadline source

The published date belongs to the school. Only show a personal correction deadline if the case has a separately evidenced one. Opening the simulator lets the student record the correction against this case using a synthetic attachment description. Returning to the sheet should show the resulting receipt or explain that it is still waiting for one.

## What changes on the sheet

| Evidence observed | Student-facing headline | Action or evidence available |
| --- | --- | --- |
| Filed application | **Your school has the next step** | “Your school needs to verify your application by 30 Nov.” Open the filing receipt or the deadline source. |
| School return | **Your school needs a clearer copy** | Show the school’s reason verbatim and offer **Open student simulator**. Pause routine verification nudges. |
| Student correction receipt | **Your correction is back with your school** | Offer **Review follow-up** for the prepared draft. Show the case, local recipient, subject and full message. **Approve and queue locally** or **Skip follow-up** returns to the same handoff. |
| School acknowledgement | **Your school received the correction** | “Verification is still pending. You have nothing to resend.” Keep the school active, with 30 Nov beside it. Retire the unqueued receipt request. A previously queued message stays in history. |
| School verification | **Your district has the next step** | Show the school verification receipt, the district deadline of 15 Dec and the district verification record the case is waiting for. |
| District verification after school verification | **Both verification steps are complete** | Show the school and district records side by side or stacked. The tracked case ends here. Scholarship award and payment are separate decisions. |

These examples assume the clock is set to 29 November and the 31 October notice is in effect. Derive labels from the current case, date and source in the build. Display **Queued locally** only after reading the exact approved message from the outbox. If the draft or case changes during review, preserve the reviewed text for comparison, explain the change and require a fresh review of any still-relevant draft. [Source timeline](sources.md#nmmss-timeline) · [Case and write contracts](architecture.md)

## Reading the route

Give Student, School and District a single line across the sheet. Use an ink outline for a future stop, a blue double ring and the word **Current** for the next owner, and a check with a specific label for a recorded step. When the school returns the case, move **Current** to Student while keeping **Filed** visible in history. After acknowledgement it stays at School. The route should still make sense printed in black and white.

Use deep navy ink on pale blue-grey paper, with ultramarine for the active owner and action. Reserve amber for a specific problem the reader can resolve. A large humanist sans-serif headline, generous space around the next step and tabular numerals for dates give this sheet its rhythm. Keep evidence quieter than the action. A case event opens to the actor, case, sequence and receipt. A deadline opens to the issuer, publication date, stage, cited passage and historical source link. A calendar change opens to the independently read dates and event identities. Avoid putting internal IDs in the headline.

At phone width, stack owner, action, deadline and evidence in that order. Let the route become a vertical list with the same names and reading order. Place focus on the draft heading when it opens and return it to the invoking control on close, or the new handoff heading if the control has retired. Routine background updates announce once and preserve focus. Keep text labels, visible keyboard focus and touch-sized controls throughout. A short highlight can draw attention to a newly confirmed handoff. With reduced motion, change its text and shape immediately.

## When the answer is uncertain

| Situation | What the student sees |
| --- | --- |
| Two equally applicable notices disagree | **School deadline needs review.** Show the last confirmed date, both conflicting passages and which field differs. Keep the corresponding calendar entry at its last confirmed value. |
| A calendar write has an unknown outcome | **Checking your calendar.** Show the confirmed public date and last calendar readback separately. Reconcile the existing event before offering a retry. |
| A case record is missing | **Checking the school record.** Keep the last evidenced handoff visible while rereading the missing sequence. Show which evidence is still missing if the gap persists. |
| The deadline passes with no verification | **School verification was due 30 Nov.** Keep the case open, show the last school record and the state of any local follow-up. |

For design acceptance, give a reader the acknowledgement screen without narration. Ask who acts next, whether the case is verified, and where the date came from. Then ask them to find the school receipt and the Ministry notice using only a keyboard. Repeat at 320 CSS pixels and with 200% text zoom. Record any answer or interaction that depended on colour, a tooltip or the presenter. Run these checks against the eventual interface.
