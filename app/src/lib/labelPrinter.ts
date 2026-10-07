// /app/src/lib/labelPrinter.ts

import { prisma } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";
import Mustache from "mustache";
import net from "net";

const CONNECT_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 2000;
const RETRYABLE_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH"]);

// Human-readable error messages keyed by socket error code.
const ERROR_MESSAGES: Record<string, string> = {
  ECONNREFUSED: "is not responding. Check that it is powered on and connected to the network.",
  ETIMEDOUT: "could not be reached. Check the network connection.",
  ECONNRESET: "dropped the connection. Try printing again.",
  EHOSTUNREACH: "is unreachable. Check the network connection and IP address.",
};

function printerError(ipAddress: string, code: string): Error {
  const detail = ERROR_MESSAGES[code] || `returned an unexpected error (${code}).`;
  return new Error(`Printer at ${ipAddress} ${detail}`);
}

function attemptSend(ipAddress: string, port: number, zpl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const timeout = setTimeout(() => {
      client.destroy();
      reject(printerError(ipAddress, "ETIMEDOUT"));
    }, CONNECT_TIMEOUT_MS);

    client.connect(port, ipAddress, () => {
      clearTimeout(timeout);
      client.write(zpl, (err) => {
        if (err) {
          client.destroy();
          return reject(err);
        }
        client.end();
        resolve();
      });
    });

    client.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      reject(printerError(ipAddress, err.code || "UNKNOWN"));
    });
  });
}

// Sends ZPL to a printer with a 5-second connection timeout and a single
// retry on transient network errors (ECONNREFUSED, ETIMEDOUT, etc.).
//
// NOT EXPORTED: server-side SSRF protection. Every caller must look up
// a Printer row by id and pass the DB-stored ipAddress, never a value
// from req.body. The only legitimate caller is `printLabel()` below,
// which loads a printer from the DB before connecting. CodeQL
// js/request-forgery on `client.connect(port, ipAddress)` was real
// because the deleted legacy endpoints `pages/api/print.ts` and
// `pages/api/print-template.ts` passed `req.body.printerIp` straight
// through. See post-failure log entry 2026-04-30 (B-class SSRF
// closure).
async function sendToPrinter(ipAddress: string, port: number, zpl: string): Promise<void> {
  try {
    await attemptSend(ipAddress, port, zpl);
  } catch (firstErr: unknown) {
    const code = firstErr instanceof Error ? ((firstErr as NodeJS.ErrnoException).code ?? "") : "";
    if (!RETRYABLE_CODES.has(code)) throw firstErr;

    logger.warn("Printer connection failed, retrying", { ipAddress, port, code });
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    await attemptSend(ipAddress, port, zpl);
  }
}

export async function renderLabel(productId: number, templateId: number): Promise<string> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { vendor: true },
  });
  if (!product) throw new Error(`Product ${productId} not found`);

  const template = await prisma.labelTemplate.findUnique({
    where: { id: templateId },
  });
  if (!template) throw new Error(`Template ${templateId} not found`);

  return Mustache.render(template.zplTemplate, {
    name: product.name,
    sku: product.productNumber,
    vendor: product.vendor.name,
    width: product.width ?? "",
    depth: product.depth ?? "",
    height: product.height ?? "",
    baseCost: product.baseCost ? Number(product.baseCost).toFixed(2) : "0.00",
    baseRetail: product.baseRetail ? Number(product.baseRetail).toFixed(2) : "0.00",
  });
}

export async function printLabel(
  productId: number,
  templateId: number,
  printerId: number,
): Promise<string> {
  const printer = await prisma.printer.findUnique({
    where: { id: printerId },
  });
  if (!printer) throw new Error(`Printer ${printerId} not found`);

  const zpl = await renderLabel(productId, templateId);
  try {
    await sendToPrinter(printer.ipAddress, printer.port || 9100, zpl);
  } catch (err: unknown) {
    // Re-throw with printer name for actionable UI messages
    const detail = err instanceof Error ? err.message : "Unknown printer error";
    throw new Error(`${printer.name}: ${detail}`);
  }
  return zpl;
}

interface AutoRouteResult {
  templateId: number;
  printerId: number;
  templateName: string;
  printerName: string;
}

// Resolves the correct template and printer for a product based on its category.
// Chain: product -> category -> labelTemplate (via labelTemplateId) -> printer (match tagSize to currentSize)
export async function resolveRoute(productId: number): Promise<AutoRouteResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      category: {
        include: {
          labelTemplate: true,
        },
      },
    },
  });

  if (!product) throw new Error(`Product ${productId} not found`);

  const template = product.category?.labelTemplate;
  if (!template) {
    const categoryName = product.category?.name || "none";
    throw new Error(
      `No label template assigned to category "${categoryName}" for product ${product.productNumber}`,
    );
  }

  // Find a printer whose currentSize matches the template's tagSize
  const printer = await prisma.printer.findFirst({
    where: { currentSize: template.tagSize },
  });

  if (!printer) {
    throw new Error(
      `No printer configured for tag size "${template.tagSize}" (template "${template.name}")`,
    );
  }

  return {
    templateId: template.id,
    printerId: printer.id,
    templateName: template.name,
    printerName: printer.name,
  };
}

// Prints a label using auto-routing: product -> category -> template -> printer
export async function autoRoutePrint(productId: number): Promise<string> {
  const route = await resolveRoute(productId);
  return printLabel(productId, route.templateId, route.printerId);
}
