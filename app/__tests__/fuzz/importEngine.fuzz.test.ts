// /app/__tests__/fuzz/importEngine.fuzz.test.ts
//
// Property-based fuzzing of the configurable import engine
// (lib/imports/engine.ts) and its value transforms (lib/imports/transforms.ts).
// The rows are whatever a vendor or a previous system put in a CSV/XLSX: any
// header, any cell. The engine is the import preview, so its classification
// and summary are what an operator approves before anything is written.
//
// Found a real bug on its first run: the engine read a source column with
// `row[column]`, so a configured column whose name is an Object.prototype
// member ("constructor", "toString", ...) and that is absent from the file
// read the INHERITED function instead of "missing". A blank row then imported
// as name = "function Object() { [native code] }" instead of being skipped.
// Counterexample: sourceColumn "constructor", row {}.

import fc from "fast-check";
import { computeNaturalKey, runImportEngine } from "@/lib/imports/engine";
import { applyTransform, TRANSFORM_KEYS } from "@/lib/imports/transforms";
import type {
  FieldMappingInput,
  ImportTransformKey,
  RawRow,
  ValueMappingInput,
} from "@/lib/imports/types";
import { anyString, nastyString, PROTO_KEYS, withoutPrototypePollution } from "./support";

const columnName = fc.oneof(
  fc.constantFrom("Name", "SKU", "Price", "Status", "Qty", " name ", ...PROTO_KEYS),
  anyString(12),
);
const targetField = fc.constantFrom("name", "sku", "price", "status", "qty", "vendor");
const transform = fc.oneof(
  { arbitrary: fc.constant(null), weight: 2 },
  { arbitrary: fc.constantFrom(...(TRANSFORM_KEYS as ImportTransformKey[])), weight: 1 },
);
// Values a value map knows ("ACTIVE"), values it does not ("other"), and junk.
const cell = fc.oneof(
  fc.constantFrom(
    "ACTIVE",
    "inactive",
    "1",
    "x",
    "other",
    "$1,234.56",
    "(50.00)",
    "2026-03-01",
    "",
    "  ",
  ),
  nastyString(4),
  fc.integer().map(String),
  fc.anything({ maxDepth: 1 }),
);

const fieldMappings = fc.uniqueArray(
  fc.record({
    sourceColumn: columnName,
    targetField,
    transform,
    required: fc.boolean(),
    sortOrder: fc.integer({ min: -5, max: 5 }),
  }),
  { maxLength: 5, selector: (m) => m.targetField },
);
const valueMappings = fc.array(
  fc.record({
    targetField,
    sourceValue: fc.constantFrom("ACTIVE", "inactive", "1", "x"),
    targetValue: fc.constantFrom("Active", "Inactive", "Y"),
  }),
  { maxLength: 6 },
);

// Rows as a CSV parser hands them over: JSON-shaped objects whose headers may
// include __proto__ as an OWN key (an object literal cannot express that).
// Headers are mostly the definition's own source columns, so rows exercise
// the mapping rather than missing it.
const rowFor = (mapped: string[]): fc.Arbitrary<RawRow> =>
  fc
    .array(
      fc.tuple(
        mapped.length > 0 ? fc.oneof(fc.constantFrom(...mapped), columnName) : columnName,
        cell,
      ),
      { maxLength: 6 },
    )
    .map((pairs) => {
      const json = pairs.map(
        ([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v ?? null) ?? "null"}`,
      );
      return JSON.parse(`{${json.join(",")}}`) as RawRow;
    });

const options = fieldMappings.chain((fms) =>
  fc.record({
    importMode: fc.constantFrom("INSERT_ONLY" as const, "UPSERT" as const, "RECONCILE" as const),
    naturalKeyFields: fc.option(fc.uniqueArray(targetField, { maxLength: 2 }), { nil: undefined }),
    fieldMappings: fc.constant(fms),
    valueMappings,
    rows: fc.array(rowFor(fms.map((m) => m.sourceColumn)), { maxLength: 10 }),
  }),
);

describe("runImportEngine (lib/imports/engine.ts)", () => {
  it("never throws, never pollutes, and the summary partitions every row", () => {
    fc.assert(
      fc.property(options, (opts) => {
        const result = withoutPrototypePollution(() => runImportEngine(opts));
        const { summary } = result;
        expect(summary.total).toBe(opts.rows.length);
        expect(summary.wouldCreate + summary.wouldUpdate + summary.skipped + summary.errors).toBe(
          summary.total,
        );
        result.rows.forEach((r, i) => expect(r.index).toBe(i));
        for (const u of result.unmappedValues) {
          expect(u.count).toBeGreaterThanOrEqual(u.rowIndexes.length);
          expect(u.rowIndexes.length).toBeLessThanOrEqual(20);
        }
      }),
    );
  });

  it("a field is set only from a column the row actually has, and a blank row is skipped", () => {
    fc.assert(
      fc.property(options, (opts) => {
        const result = runImportEngine(opts);
        result.rows.forEach((outcome, i) => {
          const source = opts.rows[i];
          // A cell String() cannot convert ({"toString": ""}) still holds
          // something, so it counts as present rather than crashing the oracle.
          const text = (v: unknown): string => {
            try {
              return String(v);
            } catch {
              return "?";
            }
          };
          const present = (col: string) =>
            Object.hasOwn(source, col) &&
            source[col] !== null &&
            source[col] !== undefined &&
            text(source[col]).trim() !== "";
          for (const fm of opts.fieldMappings) {
            if (!present(fm.sourceColumn)) {
              expect(Object.hasOwn(outcome.record, fm.targetField)).toBe(false);
            }
          }
          if (
            opts.fieldMappings.length > 0 &&
            !opts.fieldMappings.some((fm) => present(fm.sourceColumn))
          ) {
            expect(outcome.outcome).toBe("skipped");
          }
        });
      }),
    );
  });

  it("a value-mapped field never passes the raw source value through", () => {
    fc.assert(
      fc.property(options, (opts) => {
        const result = runImportEngine(opts);
        const targets = new Map<string, Set<string>>();
        for (const vm of opts.valueMappings) {
          if (!targets.has(vm.targetField)) targets.set(vm.targetField, new Set());
          targets.get(vm.targetField)!.add(vm.targetValue);
        }
        for (const outcome of result.rows) {
          for (const fm of opts.fieldMappings) {
            const allowed = targets.get(fm.targetField);
            const value = outcome.record[fm.targetField];
            // Untransformed, a mapped field holds a configured target value.
            if (allowed && !fm.transform && value !== undefined) {
              expect(allowed.has(String(value))).toBe(true);
            }
          }
        }
      }),
    );
  });

  it("classifies UPSERT rows by natural key, and distinct keys never collide", () => {
    const part = fc.oneof(fc.stringMatching(/^[A-Z0-9]{1,4}$/), nastyString(2));
    const keyed = fc.record({ a: part, b: part });
    // Two DIFFERENT records that a delimiter join would merge: the same text
    // split either side of a separator ("A" | "B,C" vs "A,B" | "C").
    const resplit = fc
      .tuple(part, part, part, fc.constantFrom(",", "|", '","', "]["))
      .map(([x, y, z, sep]) => [
        { a: x, b: `${y}${sep}${z}` },
        { a: `${x}${sep}${y}`, b: z },
      ]);
    fc.assert(
      fc.property(fc.oneof(fc.tuple(keyed, keyed), resplit), ([r1, r2]) => {
        const k1 = computeNaturalKey(["a", "b"], r1);
        const k2 = computeNaturalKey(["a", "b"], r2);
        if ("key" in k1 && "key" in k2 && k1.key === k2.key) {
          expect([r1.a, r1.b]).toEqual([r2.a, r2.b]);
        }
        const fm: FieldMappingInput[] = [
          { sourceColumn: "A", targetField: "a" },
          { sourceColumn: "B", targetField: "b" },
        ];
        const vm: ValueMappingInput[] = [];
        const existing = "key" in k1 ? new Set([k1.key]) : new Set<string>();
        const result = runImportEngine({
          importMode: "UPSERT",
          naturalKeyFields: ["a", "b"],
          fieldMappings: fm,
          valueMappings: vm,
          rows: [{ A: r2.a, B: r2.b }],
          existingNaturalKeys: existing,
        });
        const outcome = result.rows[0].outcome;
        if (outcome === "would-update") {
          expect(result.rows[0].naturalKey).toBeDefined();
          expect(existing.has(result.rows[0].naturalKey!)).toBe(true);
        }
        if (outcome === "would-create" && result.rows[0].naturalKey) {
          expect(existing.has(result.rows[0].naturalKey)).toBe(false);
        }
      }),
    );
  });
});

describe("applyTransform (lib/imports/transforms.ts)", () => {
  it("is total on any cell text: a finite value or a reported error, never a throw", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(TRANSFORM_KEYS as ImportTransformKey[])),
        fc.oneof(nastyString(), anyString()),
        (key, raw) => {
          const result = applyTransform(key, raw);
          if (result.error !== undefined) {
            expect(result.value).toBeUndefined();
            expect(result.error.length).toBeGreaterThan(0);
          } else if (typeof result.value === "number") {
            expect(Number.isFinite(result.value)).toBe(true);
          } else if (key === "DATE") {
            expect(new Date(result.value as string).toISOString()).toBe(result.value);
          }
        },
      ),
    );
  });

  it("CURRENCY reads back every amount in the formats accounting exports use", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -(10 ** 12), max: 10 ** 12 }),
        fc.nat(4),
        (centsValue, style) => {
          const abs = Math.abs(centsValue) / 100;
          const plain = abs.toFixed(2);
          const grouped = abs.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          const negative = centsValue < 0;
          const text = [
            `${negative ? "-" : ""}${plain}`,
            `${negative ? "-" : ""}$${grouped}`,
            negative ? `($${grouped})` : `$${grouped}`,
            negative ? `(${grouped})` : ` ${grouped} `,
            negative ? `-$${plain}` : `$${plain}`,
          ][style];
          const result = applyTransform("CURRENCY", text);
          expect(result.error).toBeUndefined();
          expect(Math.round((result.value as number) * 100)).toBe(centsValue);
        },
      ),
    );
  });

  it("the text transforms are idempotent", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ImportTransformKey>("TRIM", "UPPERCASE", "LOWERCASE"),
        fc.oneof(nastyString(), anyString()),
        (key, raw) => {
          const once = applyTransform(key, raw).value as string;
          expect(applyTransform(key, once).value).toBe(once);
        },
      ),
    );
  });
});
