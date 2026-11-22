# Sources and limits

## Who carries the work

Lucie Martin, Liam Delaney and Orla Doyle studied everyday administrative work in an original survey of 2,243 UK adults across ten domains. Bills and goods or services were among the areas that took substantial time. Recall period affected the estimates. The study supports looking across household chores. It does not establish local demand for Relay Desk, people's willingness to delegate, or how much time the product would save. The proposed household study measures those separately. [Original study](https://onlinelibrary.wiley.com/doi/full/10.1111/puar.13709) · [Product brief](problem.md)

## What a provider can establish

| Question in the proposal | Public reference | How the demo would use it |
| --- | --- | --- |
| Did a promised refund actually arrive? | A processor documents pending and failed refunds and the references used to trace them. [Stripe refund lifecycle](https://docs.stripe.com/refunds) | Model a merchant message and a separate synthetic incoming credit. Only a credit matching the delegated reference, amount and currency can settle the example. Access to a merchant's processor is outside the household's assumed permissions. |
| Can the technician take the Tuesday slot? | A free/busy query returns occupied intervals for selected calendars. [Google Calendar free/busy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query) | Use busy intervals without event titles. A free interval says the household can attend. The service provider must separately confirm the booking. |
| Can a corrected write overwrite a newer record? | Calendar resources support version checking and conditional changes. Clients can supply event IDs on creation. [Google Calendar resource versions](https://developers.google.com/workspace/calendar/api/guides/version-resources) | Use one stable calendar key per booking, read the result from its owner and reconcile after a lost response. |
| Who can change the amount of a bill? | For this proposed test, the issuer's invoice and the household's spending permission are separately versioned synthetic records. | A new invoice may change what is owed. Only the household can change its mandate. The ledger, invoice and approval have separate roles in the acceptance test. |

The portfolio amounts, invoices, messages, calendar entries, counterparties and settlement records are invented for the fixture. The references above inform the simulator contracts. Production access to mail, service providers, calendars or financial records would need to be established separately for each integration.

## A specialist case with real dates

The scholarship study remains a regression case for dated evidence, scoped revisions and two independent verifying officers. Four public Ministry notices provide historical schedule changes. Synthetic case records supply the individual handoffs. [NMMSS source register](scholarship-sources.md#nmmss-timeline)

## What the judges require

The A3 brief asks for a personal assistant that can take responsibility for people's administrative work. The edition rubric covers problem fit and impact, technical depth, reliability and evaluation, product and experience, and demo and communication. Its rules require open or synthetic data and a short working-demo video. [Problem statements](https://hackathon.homingo.co.in/hackathons/edition-01/problem-statements#a3) · [Judging and submission](https://hackathon.homingo.co.in/hackathons/edition-01#judging)
