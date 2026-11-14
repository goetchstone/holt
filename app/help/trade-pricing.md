A trade customer, such as a designer, can be given a **trade tier**: a name and a percent, say "Designer, 20%". On each item that can take it, that customer's price is the retail less the tier's percent. Their salesperson doesn't need a manager to sell at that price.

## Setting up tiers

Tiers are under **Admin › Setup › Trade Tiers**. Each has a name and a discount percent from 0 to 100, to two decimal places: 20 takes 20% off retail. A tier at 0 takes nothing off.

A tier's percent is a standing discount, so making a tier, changing its percent or turning it back on needs **Apply discounts** as well. Each of those, and turning a tier off, is recorded in the [audit trail](/app/help/audit-trail), under **Prices**, as **Trade tier made, changed or turned off**.

**Deactivate** turns a tier off. A customer who has a tier that's turned off keeps it on their record, but it takes nothing off until it's turned on again, and a tier that's off can't be given to anyone.

## Giving a customer a tier

On the customer's page, open **Trade & Tax** and choose **Edit**. Pick the **Trade Tier** and save. Only a manager or an administrator can change it, and each change is recorded in the [audit trail](/app/help/audit-trail), under **Customers**, as **Customer's trade tier changed**.

Ticking **Trade Account** alone takes nothing off. The tier decides.

## What a tier takes off

The tier comes off an item's retail, rounded to the cent. It doesn't apply to:

- items from a vendor whose **Trade discounts apply** box is cleared (**Inventory › Vendors**, the vendor's details, **Edit**);
- configured or custom items, which are priced by hand;
- protection plans, gift cards and delivery fees;
- returns.

**Items on sale:** by default the tier takes nothing more off an item that's on sale. To take it off the sale price too, tick **Trade tiers apply to items on sale** in **Admin › Settings › Pricing**.

## At the register and on a new quote

When you pick a customer with a tier, the screen shows their tier under their name, and each item that can take it is re-priced, with **Trade 20%** under its price. Items added after that are priced the same way. Changing the customer re-prices them for the new one, and removing the customer puts retail back.

A price you type on an item stays as you typed it: picking or changing the customer won't move it.

Anything more you take off is a discount like any other, measured from the trade price, so it follows your store's discount rules and may need a manager's PIN.

## On the order

An item sold at a trade price shows its list price, what was saved and the tier's percent, such as "List $1,000.00 · saved $200.00 · Trade 20%". The receipt and the invoice show the whole saving from retail.

If you link a customer to a quote that nothing has been paid on, the quote's items are re-priced for that customer's tier, and the tax follows. Items whose price someone typed or discounted keep their price, and the message says how many of each. If one of those prices is a bigger discount for the new customer than it was for the old one, such as a trade customer's discounted item moving to a customer with no tier, it follows your store's discount rules and may need a manager's PIN before the customer is changed. Once a payment has been taken, the prices stay as they are.

**Duplicate** on an order prices the copy at today's prices and the customer's tier today.
