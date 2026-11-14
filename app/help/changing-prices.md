Find it under **Inventory › Mass Price Change**. It needs the **Change pricing** permission.

## Choosing products

1. **Filter** by vendor, department, category, price lock, or part of a name or part number. Only active products are listed.
2. **Tick the products** to change. Ticks are kept as you page through the list. The box at the top of the list ticks the whole page.
3. Or **Choose all products matching the filter**. Holt finds them again when you preview, so a product added since is included.

One change takes at most 2,000 products. Above that, narrow the filter or the selection.

## Saying what changes

- **Retail:**
  - **Cost × markup** prices each product from its cost and the markup that applies to it: its vendor's, its category's, or the store's (see below). It is offered only to someone who also has **View cost**, since the new prices show the cost.
  - **Up or down by a percent:** −10 takes 10% off, 5 adds 5%.
  - **Set to an amount** gives every chosen product the same price, to the cent.
  - **Leave retail as it is** changes only the was price.
- **Was price:** leave it, make today's retail the was price (a markdown, for sale tags), or clear it. A was price has to stay above the new retail, so a product where it wouldn't is left out (see below).
- **Rounding:** the store's rule unless you pick another for this change. Only prices Holt works out are rounded. An amount you set is used as typed.

## Preview, then apply

**Preview** shows each product's retail and was price before and after, and how many will change. Some are left out, each with its reason:

- **Price locked.**
- **No cost to price from.**
- **No markup set** for its vendor, category or store.
- **No retail to change,** for a percent change.
- **Would round to no price:** a small price that the rounding takes to $0, which the register can't sell.
- **Was price would not be above the new retail:** a price going up, or a markdown with retail left as it is. Clear the was price, or leave the product out.
- **Already at that price.**

Changing the products or the change hides the preview until you preview again.

**Apply** saves the preview in one go. You can add a note, which goes in each product's price history. If someone changed a product's price after your preview, Holt leaves that product alone and says how many it left; preview again to include them. A product locked since the preview is kept as well.

There is no undo. To reverse a change, run another mass change.

## Locking prices

**Lock prices** and **Unlock prices** act on the chosen products straight away. A locked price is kept by imports, mass price changes and vendor style edits. Someone editing that one product can still change it, and the product's page says it is locked. You can also lock or unlock a price on the product's page, in **Price history**.

The consignment imports change an existing product's price only for someone who also has **Change pricing**. For anyone else they keep the price and say how many they kept.

## Price history

Each product's page lists its price changes, newest first: retail and was price from and to, what made the change (by hand, a mass price change, an import, the point-of-sale feed, a consignment import or a vendor style edit), who, and when. A change is never edited or deleted.

## Markups and rounding

A markup multiplies cost to give retail: 2.2 prices a $100 item at $220.

- **A vendor's markup** is in **Admin › Vendor Pricing › Price Configurator**, in the vendor's pricing settings.
- **A category's markup** is in **Inventory › Categories**. Empty follows the vendor's or the store's.
- **The store's markup,** used when neither has one, is in **Admin › Settings › Pricing**. So is whether a vendor's or a category's markup wins when both have one (the vendor's, unless you change it), and the store's rounding rule (to the cent, unless you change it).

Changing a vendor's or a category's markup needs **Change pricing**; the store's settings need access to **Settings**. In the [audit trail](/app/help/audit-trail), vendor and category markup changes appear under **Prices**, as do mass price changes and price locks. A change to the store's markup, markup order or rounding rule appears under **Settings**, as **Store settings saved**, naming the pricing fields changed.
