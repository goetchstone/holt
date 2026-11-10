Find it under **Admin › Vendor Pricing › Import Price Books**. It needs the **Change pricing** permission.

## Before you start

1. **Choose the vendor** under **Vendor for this book**. If a vendor Holt has a format for isn't in your vendor list yet, the screen says to create it in **Admin Setup** first.
2. **Put the book in the standard layout** if it isn't already a format Holt reads: one row per style, one column per grade (such as "Fabric 14" or "Leather D"), and one per option. **Download the template** gives you the columns.
3. **If the vendor has more than one kind of book,** such as fabrics, choose which one this is.
4. **Name the price list** and give its **Effective Date**, so you can tell books apart later. Fabric books don't ask for these.

## Importing

1. **Upload:** drop the file in, or choose **Choose File**. PDF, CSV and XLSX all work.
2. **Preview:** check what Holt read. Rows it couldn't read show as warnings with their row number. For a PDF, you can also extract its line drawings as images.
3. **Choose what happens to old styles.** For a plain price list, **On import** decides what happens to styles from the vendor's last book that the new one leaves out. Fabric books and vendors with their own format don't ask.
   - **Delete & Renew** (the default) retires them, so the catalog matches the new book.
   - **Update** only adds and updates, and retires nothing.
4. **Import** the rows.

When it finishes, **Import Complete** shows how many rows were imported and skipped, and any errors and warnings.

## Afterwards

Each import appears in the [audit trail](/app/help/audit-trail) under **Prices**, with who imported it.
