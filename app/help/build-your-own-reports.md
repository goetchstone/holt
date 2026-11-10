Find it under **Reports › Build Your Own**. It needs the **Build your own reports** permission, which owners and administrators start with. It can be granted to other roles in **Roles**. It shows customer names and contact details, so grant it with care.

## Listing rows

1. Under **Report on**, choose what to look at: sales orders, order lines, purchase orders and their lines, products, customers, receiving records, consignment items, service cases or stock transfers.
2. Leave **Show** on **Rows**.
3. Under **Include**, add related details, such as each order line's sales order.
4. Add filters, then choose **Run Query**. A list shows up to 500 rows.

The list shows rows as they are, including cancelled ones.

## Totals and pivots

Switch **Show** to **Totals**.

- **Group by** picks the rows of the table, for example Salesperson.
- **Across** (optional) adds a column for each value of a second thing, for example Order month. Going across shows one total at a time.
- **Totals** picks what to add up: a count, money, quantities.

Under the totals, the screen says which rows count. For order lines that means lines on orders, leaving out quotes, cancelled orders, cancelled and replaced lines, and zero quantities. Returned orders stay in, so returns net out. A sales order only totals a count: for money, use order lines.

Rows with nothing in the grouped column, such as a sale with no salesperson, are grouped under **(none)** and still counted.

A total over more than 100,000 rows is refused. Narrow it with a filter, such as a date range.

## Filters

- **Dates** are days in your store's time. Two filters on the same date give you a range, for example _on or after_ the 1st and _on or before_ the 30th.
- **Not equal** keeps rows that are empty in that column.

## Cost and exporting

- **Cost** columns and totals appear only with the **View cost** permission.
- **Export CSV** needs the **Export data** permission. Each export appears in the [audit trail](/app/help/audit-trail), with what was exported and how many rows.
