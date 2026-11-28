A card reader at a register takes that register's card payments. The cashier sends the amount to the reader, the customer taps, inserts or swipes their card, and the payment goes on the order when the card is approved. Holt keeps the card's brand and last four digits and nothing else about it.

**New, and not yet proven on a physical reader.** Card readers have been run against Stripe in test mode with its simulated reader: a payment approved, one cancelled, one declined, and a refund. They have not yet been run on a physical reader. Try it in test mode first (see "Trying it without a reader" below) before taking a real card on it.

A register with no reader still takes cards the way it did before: you take the card on your own terminal, then record the payment at the register.

## What you need

- A Stripe account, with its key saved in **Admin › Settings › Integrations**. Readers are registered on that account.
- One of Stripe's countertop readers. Stripe's Bluetooth mobile readers aren't supported.
- At Stripe, the webhook that reports paid payment links should also send **payment_intent.succeeded**. That is how a card payment is recorded if the register's screen is closed before the card goes through.

## Adding a reader

Readers are under **Admin › Setup › Card readers**. Choose **Add a reader** and fill in:

- **Code shown on the reader:** the reader shows a pairing code when you ask it to; type it as shown.
- **Name for the reader:** what your staff will see at the register, such as "Front counter".
- **Register it sits at:** each register has one reader at most. You can leave this empty and pick the register later.
- **Where the reader is (at Stripe):** pick one of your Stripe locations, or choose **A new location...** and type the store's name and address. The country is its two-letter code, such as US.

If the form says a reader can't be added yet, check the Stripe key in **Admin › Settings › Integrations** and try again.

## The list of readers

Each reader shows its register and how Stripe sees it: **Online**, **Offline**, or **Removed at Stripe**. From the list you can:

- move a reader to another register, or to no register;
- switch a reader off without removing it, and on again, under **In use**. A register whose reader is off records card payments by hand;
- **Remove** a reader. It is removed from Stripe too, and has to be registered again to be used.

Adding a reader and each of these changes is recorded in the [audit trail](/app/help/audit-trail), under **Settings**, as **Card reader added, changed or removed**.

## Taking a card at the register

Ring up the sale and choose the card tender. At a register with a reader, the button reads **Send $… to the card reader**. Press it, and the screen says it is waiting for the card on that reader.

- **Approved:** the payment is recorded on the order with the card's brand and last four digits, and the sale finishes as usual.
- **Declined:** the screen says why, and no payment is taken. You can send it again or take another kind of payment.
- **Cancel card payment** clears the reader. If the card went through just before you pressed it, the payment is recorded, not cancelled. If the card is being authorized at that moment it can't be stopped, and the screen keeps waiting for the answer.

To take a card for an order written earlier, such as the balance on a deposit order, open the order and choose **Take payment at the register**. Or find it from the register itself: choose **Look up a sale or a gift card**, search by order number or customer name, and press **Take payment** on the sale. Either way the register opens on that order's balance, and the card tender works the same way.

The payment screen says which register you are at and what it has, such as "Till open · Card reader". If that register has no reader, choose **Change register** and pick the one that does. You can't change register while a payment is out on a reader.

While a payment is out on a reader, the order can't be sent a payment link, so the customer can't pay twice. Cancel the card payment first.

Someone who may **Void payment** can also cancel it from the order: **Void** on the pending payment there cancels it on the reader first. If the card had already gone through, the payment is recorded and the order says so.

If a register is closed while a payment is still out on its reader, Holt checks with Stripe before giving up on it: a card that was approved is recorded, and one nobody paid is cancelled.

## Trying it without a reader

With a Stripe **test** key you can add a simulated reader: use the code **simulated-wpe**. At its register, the waiting screen has two buttons that stand in for the customer's card: **Present a test card**, which is approved, and **Present a declined card**, which shows what a decline looks like. No money moves in test mode.

## Refunds

A card payment taken on a reader is refunded from the order like any other card payment, back to the same card. Open the order, find the payment under **Payments**, and choose **Refund**: enter the amount (all of it, or part) and why. Someone who may **Refund payment** sees the button.
