"use client";

// /app/src/app/print/receipt/[id]/ReceiptPrintView.tsx
//
// Bitmap receipt renderer for thermal printers. Draws the entire receipt onto a
// canvas at 203 DPI, then prints the canvas as an image for pixel-perfect
// thermal output with no browser antialiasing artifacts. App Router port of
// pages/print/receipt/[id].tsx -- the order id arrives as a prop from the server
// page; the print CSS (a global block in the legacy <Head>) is kept as a plain
// <style> tag. Reads the shared /api/print/order/* REST endpoint.

import { useEffect, useState, useRef, useCallback } from "react";
import axios from "axios";
import { parseLocalDate } from "@/lib/dateUtils";
import { useBranding } from "@/components/branding/BrandingProvider";

interface StoreAddress {
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

interface OrderData {
  orderno: string;
  orderDate: string;
  status: string;
  salesperson: string | null;
  storeLocation: string | null;
  storeAddress: StoreAddress | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  lineItems: {
    productName: string | null;
    partNo: string | null;
    orderedQuantity: number;
    netPrice: number;
    vatAmount: number | null;
  }[];
  payments: {
    paymentDate: string;
    paymentType: string;
    paymentAmount: number;
  }[];
  orderNotes: string | null;
}

// 80mm at 203 DPI = 641 pixels
const W = 640;
const PAD = 24;
const CONTENT_W = W - PAD * 2;

const fmt = (v: number) => v.toFixed(2);

const PRINT_STYLES = `
  @media print {
    @page { margin: 0; size: 80mm auto; }
    body { margin: 0; padding: 0; }
    canvas { display: none !important; width: 0; height: 0; overflow: hidden; }
    p { display: none !important; }
    img {
      width: 100%;
      height: auto;
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
      -ms-interpolation-mode: nearest-neighbor;
    }
  }
  body { margin: 0; padding: 0; background: #fff; }
  canvas { display: none !important; width: 0; height: 0; overflow: hidden; }
  img { width: 100%; max-width: 80mm; height: auto; display: block; }
`;

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + "...").width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + "...";
}

const LINE_HEIGHT = 40;
const SMALL_LINE_HEIGHT = 32;
const HEADER_HEIGHT = 56;
const DIVIDER_HEIGHT = 18;

interface ReceiptTotals {
  subtotal: number;
  tax: number;
  total: number;
  paid: number;
  balance: number;
}

function computeReceiptTotals(order: OrderData): ReceiptTotals {
  const subtotal = order.lineItems.reduce((s, li) => s + li.netPrice, 0);
  const tax = order.lineItems.reduce((s, li) => s + (li.vatAmount || 0), 0);
  const total = subtotal + tax;
  const paid = order.payments.reduce((s, p) => s + p.paymentAmount, 0);
  return { subtotal, tax, total, paid, balance: total - paid };
}

/**
 * Pure pre-flight height calculation. The canvas height is computed as the sum
 * of every section's contribution, then the canvas is sized BEFORE drawing.
 * Extracted from renderReceipt so the draw function stays under cog complexity
 * threshold (S3776).
 */
function computeReceiptHeight(order: OrderData, totals: ReceiptTotals): number {
  let y = PAD;
  // Header (3 lines of small text + divider)
  y += HEADER_HEIGHT;
  y += SMALL_LINE_HEIGHT * 2;
  y += DIVIDER_HEIGHT;
  // Order info: orderno + date + (customer?) + (salesperson?) + divider
  y += LINE_HEIGHT * 2;
  if (order.customer) y += LINE_HEIGHT;
  if (order.salesperson) y += LINE_HEIGHT;
  y += DIVIDER_HEIGHT;
  // Line items
  y += order.lineItems.length * LINE_HEIGHT;
  y += DIVIDER_HEIGHT;
  // Totals: subtotal + (tax?) + total
  y += LINE_HEIGHT;
  if (totals.tax > 0) y += LINE_HEIGHT;
  y += LINE_HEIGHT + 4;
  // Payments
  if (order.payments.length > 0) {
    y += DIVIDER_HEIGHT;
    y += order.payments.length * LINE_HEIGHT;
  }
  // Balance due
  if (totals.balance > 0.01) y += LINE_HEIGHT + 4;
  // Notes (assume 2 lines max for height-bound; actual word-wrap may use less)
  if (order.orderNotes) {
    y += DIVIDER_HEIGHT;
    y += SMALL_LINE_HEIGHT * 2;
  }
  // Footer (2 lines + divider)
  y += DIVIDER_HEIGHT;
  y += SMALL_LINE_HEIGHT * 2;
  y += PAD;
  return y;
}

/**
 * Draw the body line items. Extracted to keep renderReceipt's cog complexity in
 * check (S3776).
 */
function drawLineItems(
  ctx: CanvasRenderingContext2D,
  items: OrderData["lineItems"],
  startY: number,
): number {
  let cy = startY;
  for (const li of items) {
    let name = li.productName || li.partNo || "Item";
    if (li.orderedQuantity > 1) name += ` x${li.orderedQuantity}`;
    const price = `$${fmt(li.netPrice)}`;
    const priceWidth = ctx.measureText(price).width;
    const nameMaxWidth = CONTENT_W - priceWidth - 12;
    const displayName = truncate(ctx, name, nameMaxWidth);
    ctx.textAlign = "left";
    ctx.fillText(displayName, PAD, cy);
    ctx.textAlign = "right";
    ctx.fillText(price, W - PAD, cy);
    cy += LINE_HEIGHT;
  }
  return cy;
}

/**
 * Draw word-wrapped notes. Each visual line is at most CONTENT_W wide. Returns
 * the cy after the last drawn line.
 */
function drawWrappedNotes(ctx: CanvasRenderingContext2D, notes: string, startY: number): number {
  let cy = startY;
  const words = notes.split(" ");
  let noteLine = "";
  for (const word of words) {
    const test = noteLine ? `${noteLine} ${word}` : word;
    if (ctx.measureText(test).width > CONTENT_W) {
      ctx.fillText(noteLine, PAD, cy);
      cy += SMALL_LINE_HEIGHT;
      noteLine = word;
    } else {
      noteLine = test;
    }
  }
  if (noteLine) {
    ctx.fillText(noteLine, PAD, cy);
    cy += SMALL_LINE_HEIGHT;
  }
  return cy;
}

export function ReceiptPrintView({ id }: { id: string }) {
  const branding = useBranding();
  const storeName = branding.companyName ?? branding.appName;
  const [order, setOrder] = useState<OrderData | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!id) return;
    axios
      .get(`/api/print/order/${encodeURIComponent(String(id))}`)
      .then((res) => setOrder(res.data))
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    document.title = `Receipt ${order?.orderno || ""}`;
  }, [order?.orderno]);

  const renderReceipt = useCallback(() => {
    if (!order || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Font sizes in pixels at 203 DPI
    const FONT_HEADER = "bold 48px Arial, Helvetica, sans-serif";
    const FONT_NORMAL = "bold 32px Arial, Helvetica, sans-serif";
    const FONT_SMALL = "bold 26px Arial, Helvetica, sans-serif";
    const FONT_LARGE = "bold 36px Arial, Helvetica, sans-serif";

    const totals = computeReceiptTotals(order);
    const { subtotal, tax, total, balance } = totals;

    // Set canvas size from pre-flight height
    canvas.width = W;
    canvas.height = computeReceiptHeight(order, totals);
    const lineHeight = LINE_HEIGHT;
    const smallLineHeight = SMALL_LINE_HEIGHT;
    const headerHeight = HEADER_HEIGHT;
    const dividerHeight = DIVIDER_HEIGHT;

    // White background
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, canvas.height);

    // All text is black
    ctx.fillStyle = "#000";
    ctx.textBaseline = "top";
    // Disable image smoothing for crisp pixels
    ctx.imageSmoothingEnabled = false;

    // --- Draw receipt ---
    let cy = PAD;

    // Store info
    const storeLine = order.storeAddress
      ? [
          order.storeAddress.name,
          [order.storeAddress.city, order.storeAddress.state].filter(Boolean).join(", "),
        ]
          .filter(Boolean)
          .join(" - ")
      : order.storeLocation || "";

    // Header
    ctx.font = FONT_HEADER;
    ctx.textAlign = "center";
    ctx.fillText(storeName.toUpperCase(), W / 2, cy);
    cy += headerHeight;

    ctx.font = FONT_SMALL;
    ctx.fillText(storeLine, W / 2, cy);
    cy += smallLineHeight;
    ctx.fillText(branding.tagline ?? "", W / 2, cy);
    cy += smallLineHeight;

    // Divider
    cy += 4;
    drawDivider(ctx, cy);
    cy += dividerHeight;

    // Order info
    ctx.font = FONT_NORMAL;
    ctx.textAlign = "left";
    drawRow(ctx, "Order:", order.orderno, cy);
    cy += lineHeight;
    drawRow(ctx, "Date:", parseLocalDate(order.orderDate).toLocaleDateString(), cy);
    cy += lineHeight;
    if (order.customer) {
      drawRow(
        ctx,
        "Customer:",
        `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim(),
        cy,
      );
      cy += lineHeight;
    }
    if (order.salesperson) {
      drawRow(ctx, "Sales:", order.salesperson, cy);
      cy += lineHeight;
    }

    // Divider
    cy += 4;
    drawDivider(ctx, cy);
    cy += dividerHeight;

    // Line items
    ctx.font = FONT_NORMAL;
    cy = drawLineItems(ctx, order.lineItems, cy);

    // Divider
    cy += 4;
    drawDivider(ctx, cy);
    cy += dividerHeight;

    // Totals
    ctx.font = FONT_NORMAL;
    drawRow(ctx, "Subtotal:", `$${fmt(subtotal)}`, cy);
    cy += lineHeight;

    if (tax > 0) {
      drawRow(ctx, "Tax:", `$${fmt(tax)}`, cy);
      cy += lineHeight;
    }

    ctx.font = FONT_LARGE;
    drawRow(ctx, "TOTAL:", `$${fmt(total)}`, cy);
    cy += lineHeight + 4;

    // Payments
    if (order.payments.length > 0) {
      cy += 4;
      drawDivider(ctx, cy);
      cy += dividerHeight;

      ctx.font = FONT_NORMAL;
      for (const p of order.payments) {
        drawRow(ctx, `${p.paymentType}:`, `$${fmt(p.paymentAmount)}`, cy);
        cy += lineHeight;
      }
    }

    // Balance
    if (balance > 0.01) {
      ctx.font = FONT_LARGE;
      drawRow(ctx, "BALANCE DUE:", `$${fmt(balance)}`, cy);
      cy += lineHeight + 4;
    }

    // Notes
    if (order.orderNotes) {
      cy += 4;
      drawDivider(ctx, cy);
      cy += dividerHeight;
      ctx.font = FONT_SMALL;
      ctx.textAlign = "left";
      cy = drawWrappedNotes(ctx, order.orderNotes, cy);
    }

    // Footer
    cy += 4;
    drawDivider(ctx, cy);
    cy += dividerHeight;

    ctx.font = FONT_SMALL;
    ctx.textAlign = "center";
    ctx.fillText(`Thank you for shopping at ${storeName}!`, W / 2, cy);
    cy += smallLineHeight;
    ctx.fillText("Returns within 7 days with receipt.", W / 2, cy);

    // Convert to image URL
    setImageUrl(canvas.toDataURL("image/png"));
  }, [order, storeName, branding.tagline]);

  useEffect(() => {
    renderReceipt();
  }, [renderReceipt]);

  useEffect(() => {
    if (!imageUrl) return;
    const timer = setTimeout(() => {
      globalThis.print();
    }, 300);
    const onAfterPrint = () => globalThis.close();
    globalThis.addEventListener("afterprint", onAfterPrint);
    return () => {
      clearTimeout(timer);
      globalThis.removeEventListener("afterprint", onAfterPrint);
    };
  }, [imageUrl]);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PRINT_STYLES }} />
      <canvas ref={canvasRef} />
      {imageUrl && <img src={imageUrl} alt="Receipt" />}
      {!imageUrl && !order && <p>Loading...</p>}
    </>
  );
}

function drawDivider(ctx: CanvasRenderingContext2D, y: number) {
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawRow(ctx: CanvasRenderingContext2D, left: string, right: string, y: number) {
  ctx.textAlign = "left";
  ctx.fillText(left, PAD, y);
  ctx.textAlign = "right";
  ctx.fillText(right, W - PAD, y);
}
