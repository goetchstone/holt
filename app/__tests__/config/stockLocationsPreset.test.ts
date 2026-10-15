// /app/__tests__/config/stockLocationsPreset.test.ts
//
// The stock-locations preset's rules that need no database: what the schema
// refuses, how a file is serialised, and the create / update / deactivate plan.

import { parsePresetBundle, stockLocationsPresetSchema } from "@/lib/config/presetSchema";
import { parsePresetText, serializePresetBundle } from "@/lib/config/presetSerialize";
import {
  parsePlaceOwnershipKey,
  placeOwnershipKey as key,
  planStockLocationChanges,
  type StockLocationRow,
} from "@/lib/config/applyPreset";

const preset = (stores: unknown[]) =>
  stockLocationsPresetSchema.safeParse({
    kind: "stock-locations",
    name: "stock-locations",
    stores,
  });

describe("stock-locations preset schema", () => {
  it("fills the defaults: STOCK, no aliases, not holding customers' stock", () => {
    const r = preset([{ storeLocation: "S", locations: [{ code: "A", name: "A" }] }]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.stores[0].locations[0]).toMatchObject({
        locationType: "STOCK",
        aliases: [],
        holdsCommittedStock: false,
      });
    }
  });

  it("refuses a place type the code does not know (rule 62)", () => {
    expect(
      preset([{ storeLocation: "S", locations: [{ code: "A", name: "A", locationType: "ROOF" }] }])
        .success,
    ).toBe(false);
  });

  it("refuses the same code twice in one store", () => {
    const r = preset([
      {
        storeLocation: "S",
        locations: [
          { code: "A", name: "A" },
          { code: "A", name: "B" },
        ],
      },
    ]);
    expect(r.success).toBe(false);
  });

  it("refuses one alias on two places, across stores and regardless of case", () => {
    const r = preset([
      { storeLocation: "S", locations: [{ code: "A", name: "A", aliases: ["Bay 1"] }] },
      { storeLocation: "T", locations: [{ code: "B", name: "B", aliases: ["bay 1"] }] },
    ]);
    expect(r.success).toBe(false);
  });

  it("refuses the same store listed twice", () => {
    const r = preset([
      { storeLocation: "S", locations: [] },
      { storeLocation: "S", locations: [] },
    ]);
    expect(r.success).toBe(false);
  });
});

describe("stock-locations serialisation", () => {
  it("is deterministic and leaves defaults out, so an export and a hand-written file match", () => {
    const parsed = parsePresetBundle({
      version: 1,
      presets: [
        {
          kind: "stock-locations",
          name: "stock-locations",
          stores: [
            {
              storeLocation: "Zeta",
              locations: [
                { code: "B", name: "Back", aliases: ["z", "a"] },
                { code: "A", name: "Floor", locationType: "FLOOR", floor: 0 },
              ],
            },
            { storeLocation: "Alpha", locations: [{ code: "X", name: "X" }] },
          ],
        },
      ],
    });
    if (!parsed.ok) throw new Error("fixture did not parse");
    const yaml = serializePresetBundle(parsed.bundle, "yaml");
    expect(yaml.indexOf("Alpha")).toBeLessThan(yaml.indexOf("Zeta"));
    expect(yaml.indexOf("code: A")).toBeLessThan(yaml.indexOf("code: B"));
    expect(yaml).toContain("floor: 0");
    expect(yaml).not.toContain("locationType: STOCK");
    expect(yaml).not.toContain("holdsCommittedStock");
    // Round trip: parse what we wrote, serialise again, same bytes.
    const again = parsePresetText(yaml, "yaml");
    if (!again.ok) throw new Error("serialised output did not parse");
    expect(serializePresetBundle(again.bundle, "yaml")).toBe(yaml);
  });
});

describe("planStockLocationChanges", () => {
  const parsed = stockLocationsPresetSchema.parse({
    kind: "stock-locations",
    name: "stock-locations",
    stores: [
      {
        storeLocation: "S",
        locations: [
          { code: "NEW", name: "New Bay" },
          { code: "SAME", name: "Same Bay" },
          { code: "EDIT", name: "Edited Bay", squareFootage: 100 },
        ],
      },
    ],
  });
  const row = (over: Partial<StockLocationRow>): StockLocationRow => ({
    id: 1,
    storeLocationId: 10,
    code: "X",
    name: "X",
    description: null,
    locationType: "STOCK",
    building: null,
    floor: null,
    area: null,
    squareFootage: null,
    locationAliases: [],
    holdsCommittedStock: false,
    isActive: true,
    sortOrder: 0,
    ...over,
  });

  it("creates the missing, updates the different, leaves the same, deactivates the dropped", () => {
    const rows = new Map<string, StockLocationRow>([
      [key("S", "SAME"), row({ id: 2, code: "SAME", name: "Same Bay" })],
      [key("S", "EDIT"), row({ id: 3, code: "EDIT", name: "Edited Bay", squareFootage: 90 })],
      [key("S", "GONE"), row({ id: 4, code: "GONE", name: "Gone Bay" })],
      [key("S", "ALREADY-OFF"), row({ id: 5, code: "ALREADY-OFF", isActive: false })],
    ]);
    const plan = planStockLocationChanges(parsed, new Map([["S", 10]]), rows, [
      key("S", "GONE"),
      key("S", "ALREADY-OFF"),
    ]);
    expect(plan.creates.map((c) => c.code)).toEqual(["NEW"]);
    expect(plan.updates.map((u) => u.id)).toEqual([3]);
    expect(plan.deactivations.map((d) => d.id)).toEqual([4]);
    expect(plan.messages).toEqual([
      "S / NEW: created",
      "S / EDIT: updated (squareFootage)",
      'S / GONE: deactivated (no longer listed by preset "stock-locations")',
    ]);
  });

  it("reactivates a listed place that was deactivated", () => {
    const rows = new Map([
      [key("S", "SAME"), row({ id: 2, code: "SAME", name: "Same Bay", isActive: false })],
    ]);
    const plan = planStockLocationChanges(parsed, new Map([["S", 10]]), rows, []);
    expect(plan.updates).toEqual([expect.objectContaining({ id: 2 })]);
    expect(plan.messages).toContain("S / SAME: updated (isActive)");
  });
});

describe("place ownership keys", () => {
  it("round-trip a store name and code that contain the old separator", () => {
    const k = key("North | South Barn", "A|1");
    expect(parsePlaceOwnershipKey(k)).toEqual({ store: "North | South Barn", code: "A|1" });
  });

  it("never confuse two different places that a delimited key would merge", () => {
    expect(key("A|B", "C")).not.toBe(key("A", "B|C"));
  });

  it("reject anything that is not a key this kind wrote", () => {
    expect(parsePlaceOwnershipKey("S|GONE")).toBeNull();
    expect(parsePlaceOwnershipKey('["only one"]')).toBeNull();
  });
});
