## Cancelling a whole sale

Open the order and choose **Cancel order** (on a quote, **Cancel quote**). Say why, then:

- **If money has been paid,** choose where it goes: **Back the way it was paid**, or **Leave it as credit on the customer's account**. Credit needs a customer on the sale. Giving money back needs the **Refund payment** permission. Without it, the screen tells you to ask someone who has it.
- **If a card refund fails,** the sale stays open. Try again, and only what hasn't gone back yet is refunded.
- **If a special order's purchase order has gone to the vendor** but they haven't acknowledged it, the PO is cancelled with the sale, and the screen reminds you to tell the vendor. Holt doesn't contact them.
- **If the vendor has acknowledged the PO** (it's Confirmed, with their number), choose one: **They agreed to cancel it, so cancel the PO**, or **Keep the piece: it arrives as stock to sell off the floor**. This choice needs the **Cancel with an acknowledged PO** permission.

When it's done, the lines are cancelled so nothing is owed, stock goes back, and the sale leaves the schedule and the pickup queue. The sale stays on record as cancelled. It can't be reopened: to sell the same things again, use **Duplicate**.

### When a sale can't be cancelled

The screen says why, and what to do instead:

- **Some of it has gone to the customer.** Cancel the lines that haven't, and do a return for the rest.
- **A payment is still going through.** Wait for it, or void it.
- **It has a live invoice.** Void the invoice first, since sales tax and revenue are booked from it.
- **A return is tied to it,** **stock for it is moving between stores,** or **it's out for delivery.**

## Cancelling one line

Choose **Cancel item** (the ×) on the line, and pick a reason.

- **If the customer has paid more than the sale now costs,** you're asked where the extra goes: back the way it was paid, or onto their account. Only the amount that's over goes back. A deposit smaller than what's still owed isn't touched.
- **If the line's purchase order is acknowledged,** you're asked the same question as for a whole sale: did the vendor agree, or does the store keep the piece?
- **A line that has gone to the customer** can't be cancelled. Do a return for it.

## Replacing a line

Choose **Replace item** (the circling arrows) to swap a line for something else, such as the same frame in a new fabric. Name the replacement. It keeps the line's quantity and price. The old line shows as replaced and no longer counts in any total.

A replaced line can't be changed or replaced again. Change its replacement instead.

## Deleting

Only a quote with no payment can be deleted, with **Delete**. Everything else is cancelled, so its record stays.

Every cancel, refund and credit appears in the order's **History** and in the [audit trail](/app/help/audit-trail).
