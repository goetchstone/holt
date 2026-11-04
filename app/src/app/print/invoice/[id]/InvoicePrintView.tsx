"use client";

// /app/src/app/print/invoice/[id]/InvoicePrintView.tsx
//
// Full-page invoice/quote template (8.5x11 / Letter). Opens, auto-prints, and is
// designed for standard printers. App Router port of pages/print/invoice/[id].tsx
// -- the order id arrives as a prop from the server page; the print CSS (a global
// block in the legacy <Head>) is kept as a plain <style> tag. Reads the shared
// /api/print/order/* REST endpoint.

import { useEffect, useState } from "react";
import axios from "axios";
import { useBranding } from "@/components/branding/BrandingProvider";
import { lineSaving } from "@/lib/sales/discountPolicyShared";

interface StoreAddress {
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

interface CustomerAddress {
  id: number;
  label: string | null;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  zip: string;
}

interface InvoiceLineItem {
  productName: string | null;
  partNo: string | null;
  description: string | null;
  selectedGrade: string | null;
  selectedOptions: string | null;
  orderedQuantity: number;
  netPrice: number;
  /** The unit price it was listed at (GAP-06); null on older lines. */
  listPrice: number | null;
  vatRate: number | null;
  vatAmount: number | null;
  /** Staff's note on the line (GAP-07). */
  notes: string | null;
  /** The line's picture (lib/sales/linePicture.ts), or null. */
  imageUrl: string | null;
}

interface OrderData {
  orderno: string;
  orderDate: string;
  status: string;
  salesperson: string | null;
  storeLocation: string | null;
  storeAddress: StoreAddress | null;
  customer: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    addresses: CustomerAddress[];
  } | null;
  lineItems: InvoiceLineItem[];
  invoices: {
    invoiceNo: string;
    invoiceDate: string;
    taxAmount: number;
  }[];
  payments: {
    paymentDate: string;
    paymentType: string;
    paymentAmount: number;
  }[];
  orderNotes: string | null;
  /** The order's disclaimers, each as it read when added (GAP-07). */
  disclaimers: string[];
}

const fmt = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD" });

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

const INVOICE_STYLES = `
  @media print {
    @page { margin: 0.75in; size: letter; }
    body { margin: 0; }
    .no-print { display: none; }
  }
  body {
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 11pt;
    color: #0D0D0D;
    max-width: 7.5in;
    margin: 0 auto;
    padding: 20px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 30px;
    padding-bottom: 15px;
    border-bottom: 2px solid #00263E;
  }
  .brand { font-size: 24pt; color: #00263E; letter-spacing: 2px; font-weight: normal; }
  .brand-sub { font-size: 9pt; color: #6D6D6D; margin-top: 4px; }
  .invoice-info { text-align: right; }
  .invoice-title { font-size: 14pt; color: #00263E; margin-bottom: 8px; }
  .meta { font-size: 9pt; color: #6D6D6D; }
  .meta strong { color: #0D0D0D; }
  .bill-to { margin-bottom: 20px; }
  .bill-to-label { font-size: 8pt; text-transform: uppercase; letter-spacing: 1px; color: #6D6D6D; margin-bottom: 4px; }
  .bill-to-name { font-size: 11pt; font-weight: bold; color: #0D0D0D; }
  .bill-to-addr { font-size: 9pt; color: #6D6D6D; line-height: 1.5; }
  .section { margin-bottom: 20px; }
  .section-title { font-size: 10pt; color: #00263E; border-bottom: 1px solid #E5E5E5; padding-bottom: 4px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9pt; color: #6D6D6D; padding: 6px 8px; border-bottom: 1px solid #E5E5E5; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px; border-bottom: 1px solid #F5F5F5; font-size: 10pt; }
  .right { text-align: right; }
  .desc { font-size: 8pt; color: #6D6D6D; margin-top: 2px; }
  .totals { margin-top: 15px; }
  .totals td { border: none; padding: 3px 8px; }
  .totals .total-row { font-size: 12pt; font-weight: bold; border-top: 2px solid #00263E; padding-top: 8px; }
  .totals .balance { color: #A78A5A; }
  .payments th, .payments td { font-size: 9pt; }
  .notes { background: #F7F5F1; padding: 12px; border-radius: 4px; font-size: 9pt; color: #6D6D6D; }
  .line-note { font-size: 8pt; color: #0D0D0D; font-style: italic; margin-top: 3px; white-space: pre-line; }
  .picture { width: 0.9in; }
  .picture img { max-width: 0.8in; max-height: 0.8in; object-fit: contain; display: block; }
  .disclaimers { margin-top: 20px; font-size: 8pt; color: #0D0D0D; }
  .disclaimers p { margin: 0 0 6px; white-space: pre-line; }
  tr { page-break-inside: avoid; }
  .footer { margin-top: 40px; text-align: center; font-size: 8pt; color: #6D6D6D; border-top: 1px solid #E5E5E5; padding-top: 12px; }
`;

// The description cell prefers grade/options; falls back to the raw description.
// Extracted to avoid a logical-chain conditional inline in the table JSX.
function lineDescription(li: InvoiceLineItem) {
  if (li.selectedGrade || li.selectedOptions) {
    return (
      <>
        {li.selectedGrade && <div>{li.selectedGrade}</div>}
        {li.selectedOptions && <div>{li.selectedOptions}</div>}
      </>
    );
  }
  return li.description || "";
}

const PICTURE_WAIT_MS = 3000;

/** Every picture on the page loaded or failed, or `ms` gone by. */
function picturesLoaded(doc: Document, ms: number): Promise<void> {
  const pending = [...doc.images]
    .filter((img) => !img.complete)
    .map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
    );
  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

export function InvoicePrintView({ id }: { id: string }) {
  const branding = useBranding();
  const storeName = branding.companyName ?? branding.appName;
  const [order, setOrder] = useState<OrderData | null>(null);

  useEffect(() => {
    if (!id) return;
    axios
      .get(`/api/print/order/${encodeURIComponent(String(id))}`)
      .then((res) => setOrder(res.data))
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!order) return;
    document.title = `${order.status === "QUOTE" ? "Quote" : "Invoice"} ${order.orderno}`;
    // Print once the line pictures have arrived (GAP-07), or after a few
    // seconds whatever they are doing: printing first left them blank.
    let cancelled = false;
    const timer = setTimeout(() => {
      void picturesLoaded(document, PICTURE_WAIT_MS).then(() => {
        if (!cancelled) globalThis.print();
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [order]);

  if (!order) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: INVOICE_STYLES }} />
        <p style={{ fontFamily: "sans-serif", padding: 40 }}>Loading...</p>
      </>
    );
  }

  const subtotal = order.lineItems.reduce((s, li) => s + li.netPrice, 0);
  // What the customer saved below list (GAP-06).
  const saved = order.lineItems.reduce(
    (s, li) =>
      s +
      lineSaving({ listUnit: li.listPrice, quantity: li.orderedQuantity, netPrice: li.netPrice }),
    0,
  );
  const tax = order.lineItems.reduce((s, li) => s + (li.vatAmount || 0), 0);
  // A picture column only when some line has a picture to print (GAP-07).
  const pictures = order.lineItems.some((li) => li.imageUrl);
  const total = subtotal + tax;
  const paid = order.payments.reduce((s, p) => s + p.paymentAmount, 0);
  const balance = total - paid;
  const customerName = order.customer
    ? `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim()
    : null;
  const billingAddress = order.customer?.addresses?.[0] || null;

  const storeAddressLine = order.storeAddress
    ? [
        order.storeAddress.address,
        [order.storeAddress.city, order.storeAddress.state, order.storeAddress.zip]
          .filter(Boolean)
          .join(", "),
      ]
        .filter(Boolean)
        .join(" | ")
    : null;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: INVOICE_STYLES }} />

      {/* Header */}
      <div className="header">
        <div>
          <div className="brand">{storeName.toUpperCase()}</div>
          <div className="brand-sub">
            {storeAddressLine || order.storeLocation || ""}
            {branding.tagline && (
              <>
                <br />
                {branding.tagline}
              </>
            )}
          </div>
        </div>
        <div className="invoice-info">
          <div className="invoice-title">{order.status === "QUOTE" ? "QUOTE" : "INVOICE"}</div>
          <div className="meta">
            <strong>{order.orderno}</strong>
            <br />
            {fmtDate(order.orderDate)}
          </div>
        </div>
      </div>

      {/* Bill-to + sales info */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          {customerName && (
            <div className="bill-to">
              <div className="bill-to-label">Bill To</div>
              <div className="bill-to-name">{customerName}</div>
              {billingAddress && (
                <div className="bill-to-addr">
                  {billingAddress.address1}
                  {billingAddress.address2 && (
                    <>
                      <br />
                      {billingAddress.address2}
                    </>
                  )}
                  <br />
                  {billingAddress.city}, {billingAddress.state} {billingAddress.zip}
                </div>
              )}
              {order.customer?.phone && <div className="bill-to-addr">{order.customer.phone}</div>}
              {order.customer?.email && <div className="bill-to-addr">{order.customer.email}</div>}
            </div>
          )}
        </div>
        <div className="meta" style={{ textAlign: "right" }}>
          {order.salesperson && (
            <>
              <strong>Sales Associate</strong>
              <br />
              {order.salesperson}
            </>
          )}
        </div>
      </div>

      {/* Line items */}
      <div className="section">
        <table>
          <thead>
            <tr>
              {pictures && <th className="picture" aria-label="Picture" />}
              <th>Item</th>
              <th>Description</th>
              <th className="right">Qty</th>
              <th className="right">Unit Price</th>
              {tax > 0 && <th className="right">Tax</th>}
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {order.lineItems.map((li, i) => {
              // Round the derived unit price to cents — netPrice is the LINE
              // total, and a 3-way split would otherwise print 83.33333.
              const unitPrice =
                li.orderedQuantity > 0
                  ? Math.round((li.netPrice / li.orderedQuantity) * 100) / 100
                  : 0;
              return (
                <tr key={i}>
                  {pictures && (
                    <td className="picture">
                      {li.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element -- a print page: next/image loads lazily, and the page prints as soon as its pictures are in
                        <img
                          src={li.imageUrl}
                          alt={li.productName || ""}
                          // A picture since removed from disk prints nothing,
                          // not a broken-image box.
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      )}
                    </td>
                  )}
                  <td>
                    {li.productName || "Item"}
                    {li.partNo && (
                      <div style={{ color: "#6D6D6D", fontSize: "8pt" }}>{li.partNo}</div>
                    )}
                    {li.notes && <div className="line-note">{li.notes}</div>}
                  </td>
                  <td style={{ color: "#6D6D6D", fontSize: "9pt" }}>{lineDescription(li)}</td>
                  <td className="right">{li.orderedQuantity}</td>
                  <td className="right">{fmt(unitPrice)}</td>
                  {tax > 0 && (
                    <td className="right" style={{ color: "#6D6D6D" }}>
                      {li.vatAmount ? fmt(li.vatAmount) : "-"}
                    </td>
                  )}
                  <td className="right">{fmt(li.netPrice)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Totals */}
        <table className="totals">
          <tbody>
            <tr>
              <td></td>
              <td className="right" style={{ color: "#6D6D6D" }}>
                Subtotal:
              </td>
              <td className="right" style={{ width: 100 }}>
                {fmt(subtotal)}
              </td>
            </tr>
            {saved > 0 && (
              <tr>
                <td></td>
                <td className="right" style={{ color: "#6D6D6D" }}>
                  You saved:
                </td>
                <td className="right">{fmt(saved)}</td>
              </tr>
            )}
            {tax > 0 && (
              <tr>
                <td></td>
                <td className="right" style={{ color: "#6D6D6D" }}>
                  Tax:
                </td>
                <td className="right">{fmt(tax)}</td>
              </tr>
            )}
            <tr className="total-row">
              <td></td>
              <td className="right">Total:</td>
              <td className="right">{fmt(total)}</td>
            </tr>
            {paid > 0 && (
              <tr>
                <td></td>
                <td className="right" style={{ color: "#6D6D6D" }}>
                  Paid:
                </td>
                <td className="right">{fmt(paid)}</td>
              </tr>
            )}
            {balance > 0.01 && (
              <tr className="balance">
                <td></td>
                <td className="right">Balance Due:</td>
                <td className="right" style={{ fontWeight: "bold" }}>
                  {fmt(balance)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Payments */}
      {order.payments.length > 0 && (
        <div className="section">
          <div className="section-title">Payment History</div>
          <table className="payments">
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {order.payments.map((p, i) => (
                <tr key={i}>
                  <td>{fmtDate(p.paymentDate)}</td>
                  <td>{p.paymentType}</td>
                  <td className="right">{fmt(p.paymentAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Notes */}
      {order.orderNotes && (
        <div className="section">
          <div className="section-title">Notes</div>
          <div className="notes">{order.orderNotes}</div>
        </div>
      )}

      {/* The order's own disclaimers (GAP-07), above the store-wide footer. */}
      {order.disclaimers.length > 0 && (
        <div className="disclaimers">
          {order.disclaimers.map((text, i) => (
            <p key={i}>{text}</p>
          ))}
        </div>
      )}

      {/* Footer -- the store's own returns/warranty note when it has written
          one (AppSettings.receiptFooter), as on the receipt. */}
      <div className="footer">
        {storeName}
        <br />
        Thank you for your business.
        {branding.receiptFooter && (
          <>
            <br />
            <span style={{ whiteSpace: "pre-line" }}>{branding.receiptFooter}</span>
          </>
        )}
      </div>
    </>
  );
}
