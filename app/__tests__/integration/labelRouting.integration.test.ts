// /app/__tests__/integration/labelRouting.integration.test.ts
//
// Which printer a place or box label goes to (lib/labelPrinter.ts
// routeContextLabel), against real Postgres: the store's own printer loaded
// with the template's size, and a refusal naming what to set up when the
// store has none -- never another store's printer (rule 63). Found in the
// browser: a warehouse place's label went to a showroom's printer.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { LabelSetupError, routeContextLabel } from "@/lib/labelPrinter";

async function world() {
  await prisma.labelTemplate.create({
    data: { name: "Place label 4x6", context: "LOCATION", tagSize: "4x6", zplTemplate: "^XA^XZ" },
  });
  const printer = (name: string, store: string, currentSize: string) =>
    prisma.printer.create({
      data: {
        name,
        ipAddress: "10.0.0.1",
        tagType: "ZEBRA",
        store,
        supportedSizes: [currentSize],
        currentSize,
      },
    });
  return {
    showroom: await printer("Showroom printer", "Showroom", "4x6"),
    warehouse2x4: await printer("Warehouse small", "Warehouse", "2x4"),
  };
}

describe("label routing (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("prints on the store's own printer loaded with the template's size", async () => {
    const w = await world();
    const route = await routeContextLabel("LOCATION", "Showroom");
    expect(route.printerId).toBe(w.showroom.id);
  });

  it("refuses a store with no printer loaded with that size, rather than use another store's", async () => {
    await world();
    const route = routeContextLabel("LOCATION", "Warehouse");
    await expect(route).rejects.toBeInstanceOf(LabelSetupError);
    await expect(routeContextLabel("LOCATION", "Warehouse")).rejects.toThrow(
      "No printer at Warehouse is loaded with 4x6 labels",
    );
  });

  it("refuses when no template has the context", async () => {
    await world();
    await expect(routeContextLabel("BOX", "Showroom")).rejects.toThrow("No label template for BOX");
  });
});
