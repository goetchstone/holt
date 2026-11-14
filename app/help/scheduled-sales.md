Find it under **Inventory › Sales**. It needs the **Change pricing** permission. Printing the tags also needs permission to print tags (**Receive stock** or **Operate warehouse**).

A sale gives its products a sale price from its first day to its last, both included. While it is on, the register, new quotes and price tags use the sale price, and the product's regular price stays as it is. When it ends, the regular price is back the next morning. Nothing has to be run at midnight: Holt works out each day which sales are on, by the store's own day (the time zone in **Admin › Settings**), not the computer's.

## Starting a sale

1. Choose **New sale**.
2. Give it a **name**, its **first day** and **last day**, and a note if you like. A sale can't start before today.
3. **Add products** the way a mass price change chooses them: filter by vendor, department, category, price lock, or part of a name or part number, then tick products (ticks are kept as you page) or **Choose all products matching the filter**. A sale takes at most 2,000 products; if the sale's list grows past that, the screen says how many to remove and won't save until you do.
4. Say how to price them:
   - **A percent off the regular price,** rounded by the store's rule unless you pick another rounding for this sale. 20 takes 20% off.
   - **An amount, the same for each,** used as typed.
5. **Preview** shows each product's regular and sale price. Some are left out, each with its reason:
   - **No regular price** to take a sale price from.
   - **Already in another sale on some of these days,** naming that sale. A product has one sale price a day.
   - **Sale price would not be below the regular price.**
   - **Would round to no price.**
6. **Add to the sale** puts the priced products in the sale's list. You can add more products with another percent or amount, and **Remove** any from the list. Adding a product that's already there gives it the new price.
7. **Schedule the sale.** Holt checks every product again as it saves, and saves nothing if one is now in another sale on those days or its sale price is no longer below its regular price. Preview again and take it out or re-price it.

Set the dates before you preview: whether a product is already in another sale depends on them.

## Changing a sale

Open a sale from the list. What you can change depends on where it stands today:

- **Upcoming:** anything, the name, note, dates and products. **Delete** removes it altogether.
- **On now:** only the name and note. **End early** stops its sale prices straight away. It can't be restarted; schedule a new sale instead.
- **Ended:** only the name and note. Its products and prices stay on it as the record of what was charged.

Changing an upcoming sale's dates checks its products against other sales on the new days.

## Prices at the register and on quotes

While a sale is on, the price shown when you search or scan a product at the register or on a new quote is the sale price, with the regular price struck through beside it. A line added then is at the sale price, and the discount limit is measured from the sale price, so a sale line needs no manager approval and a further discount counts from the sale price. The order records the sale price as the line's list price.

Lines already on a quote or an order keep the price they were added at. Starting or ending a sale doesn't re-price them.

A line still in the register's cart or on a new quote you haven't saved is different: it is checked when you check out or save the quote, against the price at that moment. If the sale has ended since you added the line, its sale price now counts as a discount off the regular price and may need a manager's approval. Remove the line and add it again to take today's price.

If you type a different price over a sale line, it no longer shows **SALE**.

## Tags

While a sale is on, a **sale tag** prints the sale price with the regular price as the "was" price, and can show the day the sale ends. A **regular tag** prints the price the register charges, so during a sale it prints the sale price too.

**Tags to change today**, at the top of the Sales screen, lists:

- **Sale tags:** products in a sale that starts today.
- **Regular tags:** products whose sale ended yesterday or was ended early since, and that aren't on sale today.

Pick the store to print at (or any printer loaded for each tag), and **Print all** sends them to the printer. A tag that can't print is listed with the reason. Nothing prints these by itself: check the list each morning a sale starts or ends.

## In the audit trail

Scheduling, changing, ending early and deleting a sale each appear in the [audit trail](/app/help/audit-trail) under **Prices**, with who did it and when.
