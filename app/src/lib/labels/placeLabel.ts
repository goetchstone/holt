// /app/src/lib/labels/placeLabel.ts
//
// A place's label (ledger plan phase 12, printed from phase 15): its code and
// name, where it is in the store, and a barcode a handheld scans back to it,
// `L-<id>` (lib/scan/scanCodes.ts). The id, not the place's own code, because
// codes are the deployment's and change; the id never does.

import type { Prisma, PrismaClient } from "@prisma/client";
import { placePath } from "@/lib/inventory/placeTree";
import { placeBarcode } from "@/lib/scan/scanCodes";
import { renderTemplate } from "./renderTemplate";

type Db = PrismaClient | Prisma.TransactionClient;

export async function placeLabelFields(db: Db, placeId: number) {
  const place = await db.stockLocation.findUniqueOrThrow({
    where: { id: placeId },
    select: {
      id: true,
      code: true,
      name: true,
      storeLocationId: true,
      storeLocation: { select: { name: true } },
    },
  });
  const tree = await db.stockLocation.findMany({
    where: { storeLocationId: place.storeLocationId },
    select: { id: true, parentId: true, name: true },
  });
  return {
    storeName: place.storeLocation.name,
    fields: {
      locationCode: place.code,
      locationName: place.name,
      path: placePath(tree, place.id),
      store: place.storeLocation.name,
      barcode: placeBarcode(place.id),
    },
  };
}

export async function renderPlaceLabel(db: Db, placeId: number, zplTemplate: string) {
  const { fields } = await placeLabelFields(db, placeId);
  return renderTemplate(zplTemplate, fields);
}
