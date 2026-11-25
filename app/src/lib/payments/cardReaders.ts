// /app/src/lib/payments/cardReaders.ts
//
// The store's card readers: registering one with the card processor, which
// register it sits at, and removing it (Admin > Setup > Card readers). Holt
// keeps the processor's reference to the reader and nothing about any card.
// Taking a payment on one is lib/payments/cardReaderPayments.ts.
//
// NOT YET RUN AGAINST STRIPE OR A READER (docs/domains/pos.md, "Card readers").

import type { CardReader } from "@prisma/client";
import { ApiError } from "@/lib/apiResponse";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import {
  assertCapability,
  getActiveProvider,
  getProviderForPayment,
  type PaymentProvider,
  type ReaderLocation,
  type ReaderLocationInput,
} from "@/lib/payments";

/** A simulated reader (test mode) is one the processor's device type says is. */
export function isSimulatedReader(reader: Pick<CardReader, "deviceType">): boolean {
  return (reader.deviceType ?? "").startsWith("simulated");
}

/** The processor new readers are registered with: the one taking new payments. */
function providerForNewReaders(): PaymentProvider {
  const provider = getActiveProvider();
  assertCapability(provider, "terminal");
  return provider;
}

/**
 * A processor's own refusal, worded for the person at the screen. The
 * processor's message is shown as it is: it says what to fix ("registration
 * code not found", "reader is offline"), and it is the processor's public
 * wording, not Holt's internals.
 */
export function processorRefusal(what: string, err: unknown): ApiError {
  logError(what, err);
  const detail = err instanceof Error && err.message ? `: ${err.message}` : ".";
  return new ApiError(502, `${what}${detail}`);
}

export interface CardReaderRow {
  id: number;
  label: string;
  registerId: number | null;
  registerName: string | null;
  storeName: string | null;
  processor: string;
  deviceType: string | null;
  serialNumber: string | null;
  simulated: boolean;
  isActive: boolean;
  /** As the processor reports it now; null when it does not say or could not be asked. */
  online: boolean | null;
  /** The processor no longer has this reader: it was removed there. */
  missingAtProcessor: boolean;
}

/** Every reader, with what the processor says about each right now. */
export async function listCardReaders(): Promise<CardReaderRow[]> {
  const readers = await prisma.cardReader.findMany({
    orderBy: [{ isActive: "desc" }, { label: "asc" }],
    include: {
      register: { select: { name: true, storeLocation: { select: { name: true } } } },
    },
  });
  return Promise.all(
    readers.map(async (reader) => {
      let online: boolean | null = null;
      let missingAtProcessor = false;
      try {
        const live = await getProviderForPayment(reader.processorType).getReader?.(
          reader.processorReaderId,
        );
        if (live === null) missingAtProcessor = true;
        else online = live?.online ?? null;
      } catch (err) {
        // The list still shows; the reader's state is unknown.
        logError("Could not ask the card processor about a reader", err, { readerId: reader.id });
      }
      return {
        id: reader.id,
        label: reader.label,
        registerId: reader.registerId,
        registerName: reader.register?.name ?? null,
        storeName: reader.register?.storeLocation.name ?? null,
        processor: getProviderForPayment(reader.processorType).displayName,
        deviceType: reader.deviceType,
        serialNumber: reader.serialNumber,
        simulated: isSimulatedReader(reader),
        isActive: reader.isActive,
        online,
        missingAtProcessor,
      };
    }),
  );
}

export async function listReaderLocations(): Promise<ReaderLocation[]> {
  const provider = providerForNewReaders();
  try {
    return await provider.listReaderLocations!();
  } catch (err) {
    throw processorRefusal(`${provider.displayName} couldn't list its reader locations`, err);
  }
}

function required(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ApiError(400, `${name} is required.`);
  return text;
}

export async function createReaderLocation(body: Record<string, unknown>): Promise<ReaderLocation> {
  const input: ReaderLocationInput = {
    name: required(body.name, "A name for the location"),
    line1: required(body.line1, "The street address"),
    city: required(body.city, "The city"),
    state: required(body.state, "The state or province"),
    postalCode: required(body.postalCode, "The postal code"),
    country: required(body.country, "The country").toUpperCase(),
  };
  if (!/^[A-Z]{2}$/.test(input.country)) {
    throw new ApiError(400, "The country is its two-letter code, for example US or CA.");
  }
  const provider = providerForNewReaders();
  try {
    return await provider.createReaderLocation!(input);
  } catch (err) {
    throw processorRefusal(`${provider.displayName} didn't create the location`, err);
  }
}

/** The register a reader is being put at: it must exist and have no other reader. */
async function assertRegisterFree(registerId: number, exceptReaderId?: number): Promise<void> {
  const register = await prisma.register.findUnique({
    where: { id: registerId },
    select: { name: true, cardReader: { select: { id: true, label: true } } },
  });
  if (!register) throw new ApiError(400, "That register doesn't exist.");
  if (register.cardReader && register.cardReader.id !== exceptReaderId) {
    throw new ApiError(
      409,
      `${register.name} already has the reader "${register.cardReader.label}". ` +
        "Move or remove that one first.",
    );
  }
}

function parseRegisterId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "That register doesn't exist.");
  return id;
}

/**
 * Register a reader with the processor and record it. The reader exists at the
 * processor first; if recording it here then fails, it is removed there again
 * so no reader is left that Holt doesn't know about.
 */
export async function addCardReader(
  body: Record<string, unknown>,
  actor: string | null,
): Promise<CardReader> {
  const registrationCode = required(body.registrationCode, "The code shown on the reader");
  const label = required(body.label, "A name for the reader");
  const locationId = required(body.locationId, "The reader's location");
  const registerId = parseRegisterId(body.registerId);
  if (registerId !== null) await assertRegisterFree(registerId);

  const provider = providerForNewReaders();
  let registered;
  try {
    registered = await provider.registerReader!({ registrationCode, label, locationId });
  } catch (err) {
    throw processorRefusal(`${provider.displayName} didn't register the reader`, err);
  }
  try {
    return await prisma.cardReader.create({
      data: {
        label,
        registerId,
        processorType: provider.id.toUpperCase(),
        processorReaderId: registered.id,
        processorLocationId: registered.locationId ?? locationId,
        deviceType: registered.deviceType,
        serialNumber: registered.serialNumber,
        createdBy: actor,
      },
    });
  } catch (err) {
    await provider.removeReader!(registered.id).catch((removeErr) =>
      logError("A reader registered at the processor could not be recorded or removed", removeErr, {
        processorReaderId: registered.id,
      }),
    );
    throw err;
  }
}

/** Rename a reader, move it to another register (or none), or switch it off. */
export async function updateCardReader(
  id: number,
  body: Record<string, unknown>,
  actor: string | null,
): Promise<CardReader> {
  const reader = await prisma.cardReader.findUnique({ where: { id } });
  if (!reader) throw new ApiError(404, "That card reader doesn't exist.");
  const data: { label?: string; registerId?: number | null; isActive?: boolean } = {};
  if (body.label !== undefined) data.label = required(body.label, "A name for the reader");
  if (body.registerId !== undefined) {
    data.registerId = parseRegisterId(body.registerId);
    if (data.registerId !== null) await assertRegisterFree(data.registerId, id);
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") throw new ApiError(400, "isActive is true or false.");
    data.isActive = body.isActive;
  }
  return prisma.cardReader.update({ where: { id }, data: { ...data, updatedBy: actor } });
}

/** Remove a reader from the processor and from Holt. Its past payments keep their own record. */
export async function removeCardReader(id: number): Promise<CardReader> {
  const reader = await prisma.cardReader.findUnique({ where: { id } });
  if (!reader) throw new ApiError(404, "That card reader doesn't exist.");
  const provider = getProviderForPayment(reader.processorType);
  try {
    await provider.removeReader?.(reader.processorReaderId);
  } catch (err) {
    throw processorRefusal(`${provider.displayName} didn't remove the reader`, err);
  }
  return prisma.cardReader.delete({ where: { id } });
}

/** The reader that takes a register's card payments, if it has a working one. */
export async function readerAtRegister(registerId: number): Promise<CardReader | null> {
  return prisma.cardReader.findFirst({ where: { registerId, isActive: true } });
}
