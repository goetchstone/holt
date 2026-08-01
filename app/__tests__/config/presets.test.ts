// /app/__tests__/config/presets.test.ts
//
// The preset contract: schema validation, YAML/JSON parity, and the disk
// loader's precedence and safety rules. Pure — no database.
//
// The parity block is the load-bearing one. The claim in
// config/presets/README.md is that YAML and JSON are two spellings of one
// document and neither can express something the other cannot; a test that
// parses both and asserts deep equality is what keeps that claim honest as
// the schema grows.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PRESET_SCHEMA_VERSION,
  flattenValueMappings,
  nestValueMappings,
  parsePresetBundle,
} from "@/lib/config/presetSchema";
import {
  MAX_PRESET_BYTES,
  detectFormat,
  parsePresetText,
  serializePresetBundle,
} from "@/lib/config/presetSerialize";
import { loadAllPresets, loadPresetFile, safeJoin } from "@/lib/config/presetFiles";

const VALID_YAML = `
version: 1
presets:
  - kind: import-definition
    name: acme-customers
    targetEntity: customer
    importMode: UPSERT
    naturalKeyFields: [externalId]
    fieldMappings:
      - sourceColumn: Customer Code
        targetField: externalId
        required: true
    valueMappings:
      state:
        Connecticut: CT
`;

const VALID_JSON = JSON.stringify({
  version: 1,
  presets: [
    {
      kind: "import-definition",
      name: "acme-customers",
      targetEntity: "customer",
      importMode: "UPSERT",
      naturalKeyFields: ["externalId"],
      fieldMappings: [
        { sourceColumn: "Customer Code", targetField: "externalId", required: true },
      ],
      valueMappings: { state: { Connecticut: "CT" } },
    },
  ],
});

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify((result as never)["errors"])}`);
  }
  return result as Extract<T, { ok: true }>;
}

describe("preset schema", () => {
  it("accepts a well-formed bundle and applies defaults", () => {
    const parsed = expectOk(parsePresetText(VALID_YAML, "yaml"));
    const preset = parsed.bundle.presets[0];
    expect(preset.kind).toBe("import-definition");
    if (preset.kind !== "import-definition") throw new Error("narrowing");
    // Defaults the file did not state.
    expect(preset.sourceFormat).toBe("CSV");
    expect(preset.isActive).toBe(true);
  });

  it("accepts a bare single preset and normalizes it into a bundle", () => {
    const result = expectOk(
      parsePresetBundle({
        kind: "traffic-store-mapping",
        name: "traffic-stores",
        stores: [{ storeLocation: "Downtown", sourceNames: ["DT"] }],
      }),
    );
    expect(result.bundle.version).toBe(PRESET_SCHEMA_VERSION);
    expect(result.bundle.presets).toHaveLength(1);
  });

  it("rejects an unsupported schema version rather than guessing", () => {
    const result = parsePresetBundle({ version: 99, presets: [] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join(" ")).toMatch(/unsupported preset version 99/);
  });

  it("rejects a name that is not kebab-case", () => {
    // The name becomes a filename, a database key and a URL segment; allowing
    // spaces or slashes would mean per-surface escaping rules.
    const result = parsePresetBundle({
      kind: "traffic-store-mapping",
      name: "Traffic Stores",
      stores: [],
    });
    expect(result.ok).toBe(false);
  });

  it("requires a runnerKey for RECONCILE", () => {
    // A full-state re-export must diff against existing data, which is code.
    const result = parsePresetBundle({
      kind: "import-definition",
      name: "x",
      targetEntity: "customer",
      importMode: "RECONCILE",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join(" ")).toMatch(/RECONCILE requires a runnerKey/);
  });

  it("requires naturalKeyFields for UPSERT", () => {
    const result = parsePresetBundle({
      kind: "import-definition",
      name: "x",
      targetEntity: "customer",
      importMode: "UPSERT",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join(" ")).toMatch(/UPSERT requires at least one/);
  });

  it("rejects two source columns feeding the same target field", () => {
    const result = parsePresetBundle({
      kind: "import-definition",
      name: "x",
      targetEntity: "customer",
      fieldMappings: [
        { sourceColumn: "Email", targetField: "email" },
        { sourceColumn: "Email Address", targetField: "email" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join(" ")).toMatch(/duplicate targetField/);
  });

  it("rejects a duplicate (kind, name) inside one bundle", () => {
    // Otherwise the second silently overwrites the first, and in a GitOps
    // flow that reads as "my change did nothing".
    const one = { kind: "traffic-store-mapping", name: "dup", stores: [] };
    const result = parsePresetBundle({ version: 1, presets: [one, one] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join(" ")).toMatch(/duplicate preset/);
  });

  it("refuses a document containing a credential-shaped key", () => {
    // Presets are committed in plaintext; secrets belong in
    // IntegrationCredential, encrypted at rest.
    const result = parsePresetBundle({
      version: 1,
      apiKey: "sk-live-abc123",
      presets: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join(" ")).toMatch(/credential-like keys/);
  });

  it("reports the path of a nested problem so it is findable in a long file", () => {
    const result = parsePresetBundle({
      version: 1,
      presets: [
        {
          kind: "import-definition",
          name: "x",
          targetEntity: "customer",
          fieldMappings: [{ sourceColumn: "", targetField: "email" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join(" ")).toMatch(/presets\.0\.fieldMappings\.0\.sourceColumn/);
  });
});

describe("YAML / JSON parity", () => {
  it("parses both spellings of the same document to an identical bundle", () => {
    const fromYaml = expectOk(parsePresetText(VALID_YAML, "yaml"));
    const fromJson = expectOk(parsePresetText(VALID_JSON, "json"));
    expect(fromYaml.bundle).toEqual(fromJson.bundle);
  });

  it("round-trips through either format without drift", () => {
    const original = expectOk(parsePresetText(VALID_YAML, "yaml")).bundle;
    for (const format of ["yaml", "json"] as const) {
      const text = serializePresetBundle(original, format);
      const reparsed = expectOk(parsePresetText(text, format)).bundle;
      expect(reparsed).toEqual(original);
    }
  });

  it("serializes deterministically so a re-export is not a spurious diff", () => {
    const bundle = expectOk(parsePresetText(VALID_YAML, "yaml")).bundle;
    expect(serializePresetBundle(bundle, "yaml")).toBe(serializePresetBundle(bundle, "yaml"));
    // Key order must not follow insertion order of the parsed object.
    const shuffled = expectOk(
      parsePresetBundle({
        version: 1,
        presets: [
          {
            name: "acme-customers",
            valueMappings: { state: { Connecticut: "CT" } },
            targetEntity: "customer",
            kind: "import-definition",
            importMode: "UPSERT",
            naturalKeyFields: ["externalId"],
            fieldMappings: [
              { targetField: "externalId", sourceColumn: "Customer Code", required: true },
            ],
          },
        ],
      }),
    ).bundle;
    expect(serializePresetBundle(shuffled, "yaml")).toBe(serializePresetBundle(bundle, "yaml"));
  });

  it("reads YAML 1.2, so a store code like NO stays a string", () => {
    // Under YAML 1.1 rules `NO` parses as boolean false, which would silently
    // corrupt a store or payment code. The parser is pinned to 1.2 for this.
    const parsed = expectOk(
      parsePresetText(
        "version: 1\npresets:\n  - kind: traffic-store-mapping\n    name: s\n    stores:\n      - storeLocation: North Outlet\n        sourceNames: [NO, ON]\n",
        "yaml",
      ),
    );
    const preset = parsed.bundle.presets[0];
    if (preset.kind !== "traffic-store-mapping") throw new Error("narrowing");
    expect(preset.stores[0].sourceNames).toEqual(["NO", "ON"]);
  });

  it("detects format from the filename, and only from known extensions", () => {
    expect(detectFormat("a.yaml")).toBe("yaml");
    expect(detectFormat("a.YML")).toBe("yaml");
    expect(detectFormat("a.json")).toBe("json");
    expect(detectFormat("a.txt")).toBeNull();
    expect(detectFormat("README.md")).toBeNull();
  });

  it("refuses a document over the size ceiling instead of parsing it", () => {
    const huge = `version: 1\ndescription: ${"x".repeat(MAX_PRESET_BYTES)}\npresets: []\n`;
    const result = parsePresetText(huge, "yaml");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join(" ")).toMatch(/over the \d+-byte limit/);
  });

  it("bounds YAML alias expansion (billion-laughs defence)", () => {
    // Without maxAliasCount this expands geometrically during parse and takes
    // the process down. It must fail, not hang.
    const bomb = [
      "version: 1",
      "a: &a [x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "e: [*d, *d, *d, *d, *d, *d, *d, *d, *d]",
      "presets: []",
    ].join("\n");
    const result = parsePresetText(bomb, "yaml");
    expect(result.ok).toBe(false);
  });

  it("reports a parse error rather than throwing", () => {
    const result = parsePresetText("version: 1\n  bad: [indent\n", "yaml");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]).toMatch(/could not parse/);
  });
});

describe("value mapping shape conversion", () => {
  it("round-trips authoring shape through storage shape", () => {
    // Authoring is a nested map (write the field name once); storage is one
    // row per triple. A round trip must not lose or reorder anything.
    const nested = {
      paymentType: { "Card Connect": "CARD", "Credit Note": "STORE_CREDIT" },
      state: { Connecticut: "CT" },
    };
    expect(nestValueMappings(flattenValueMappings(nested))).toEqual(nested);
  });

  it("flattens to one row per source value", () => {
    const rows = flattenValueMappings({ paymentType: { A: "CARD", B: "CASH" } });
    expect(rows).toEqual([
      { targetField: "paymentType", sourceValue: "A", targetValue: "CARD" },
      { targetField: "paymentType", sourceValue: "B", targetValue: "CASH" },
    ]);
  });
});

describe("disk loader", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "holt-presets-"));
    await fs.mkdir(path.join(root, "presets"), { recursive: true });
    await fs.mkdir(path.join(root, "local"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const shipped = (name: string, body: string) =>
    fs.writeFile(path.join(root, "presets", name), body, "utf8");
  const local = (name: string, body: string) =>
    fs.writeFile(path.join(root, "local", name), body, "utf8");

  const trafficPreset = (name: string, store: string) =>
    `version: 1\npresets:\n  - kind: traffic-store-mapping\n    name: ${name}\n    stores:\n      - storeLocation: ${store}\n        sourceNames: [X]\n`;

  it("loads YAML and JSON files side by side from one directory", async () => {
    await shipped("a.yaml", trafficPreset("alpha", "A"));
    await shipped("b.json", VALID_JSON);
    const report = await loadAllPresets(root);
    expect(report.errors).toEqual([]);
    expect(report.presets.map((p) => p.preset.name).sort()).toEqual(["acme-customers", "alpha"]);
  });

  it("lets a local preset override a shipped one and reports the override", async () => {
    await shipped("t.yaml", trafficPreset("traffic-stores", "Shipped Store"));
    await local("t.yaml", trafficPreset("traffic-stores", "Local Store"));

    const report = await loadAllPresets(root);
    expect(report.presets).toHaveLength(1);
    const [loaded] = report.presets;
    expect(loaded.origin).toBe("local");
    if (loaded.preset.kind !== "traffic-store-mapping") throw new Error("narrowing");
    expect(loaded.preset.stores[0].storeLocation).toBe("Local Store");

    // A silent override is how a deployment ends up running config nobody
    // remembers writing, so it is reported by name.
    expect(report.overrides).toEqual([
      {
        kind: "traffic-store-mapping",
        name: "traffic-stores",
        shippedFile: "config/presets/t.yaml",
        localFile: "config/local/t.yaml",
      },
    ]);
  });

  it("skips a malformed file without losing the good ones", async () => {
    await shipped("good.yaml", trafficPreset("good", "A"));
    await shipped("bad.yaml", "version: 1\npresets:\n  - kind: nope\n");
    const report = await loadAllPresets(root);
    expect(report.presets.map((p) => p.preset.name)).toEqual(["good"]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].sourceFile).toBe("config/presets/bad.yaml");
  });

  it("treats a missing config/local as normal, not an error", async () => {
    await fs.rm(path.join(root, "local"), { recursive: true, force: true });
    await shipped("a.yaml", trafficPreset("alpha", "A"));
    const report = await loadAllPresets(root);
    expect(report.errors).toEqual([]);
    expect(report.presets).toHaveLength(1);
  });

  it("ignores non-preset and dotfile entries", async () => {
    await shipped("README.md", "# not a preset");
    await shipped(".hidden.yaml", trafficPreset("hidden", "A"));
    await shipped("a.yaml", trafficPreset("alpha", "A"));
    const report = await loadAllPresets(root);
    expect(report.presets.map((p) => p.preset.name)).toEqual(["alpha"]);
    expect(report.errors).toEqual([]);
  });

  it("records which file each preset came from", async () => {
    await shipped("a.yaml", trafficPreset("alpha", "A"));
    const report = await loadAllPresets(root);
    expect(report.presets[0].sourceFile).toBe("config/presets/a.yaml");
    expect(report.presets[0].origin).toBe("shipped");
  });
});

describe("path safety", () => {
  it("blocks traversal out of the config root", () => {
    // Both the CLI and the GUI turn user input into a path; this is the one
    // choke point that keeps ../../.env from being one of them.
    expect(() => safeJoin("/tmp/root", "..")).toThrow(/invalid path segment/);
    expect(() => safeJoin("/tmp/root", "../etc/passwd")).toThrow(/invalid path segment/);
    expect(() => safeJoin("/tmp/root", "a/b")).toThrow(/invalid path segment/);
    expect(() => safeJoin("/tmp/root", "a\0b")).toThrow(/NUL byte/);
  });

  it("permits an ordinary nested lookup under the root", () => {
    expect(safeJoin("/tmp/root", "local", "x.yaml")).toBe("/tmp/root/local/x.yaml");
  });

  it("accepts both the repo-relative and config-root-relative spellings", async () => {
    // Every doc and CLI error message shows `--file config/local/x.yaml`.
    // Joining that onto a root that already IS config/ resolved to
    // config/config/local/x.yaml — a bug the first round of these tests
    // missed because they only ever used the root-relative form.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "holt-presets-dual-"));
    try {
      await fs.mkdir(path.join(root, "local"), { recursive: true });
      const body =
        "version: 1\npresets:\n  - kind: traffic-store-mapping\n    name: t\n    stores: []\n";
      await fs.writeFile(path.join(root, "local", "x.yaml"), body, "utf8");

      for (const spelling of [`${path.basename(root)}/local/x.yaml`, "local/x.yaml"]) {
        const result = await loadPresetFile(spelling, root);
        if ("errors" in result) throw new Error(`${spelling}: ${result.errors.join(", ")}`);
        expect(result.bundle.presets).toHaveLength(1);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a traversing path in loadPresetFile", async () => {
    const result = await loadPresetFile("../../../etc/passwd", "/tmp/holt-config-root");
    expect("errors" in result).toBe(true);
  });

  it("refuses a file whose extension is not a known format", async () => {
    const result = await loadPresetFile("local/notes.txt", "/tmp/holt-config-root");
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected failure");
    expect(result.errors.join(" ")).toMatch(/expected a \.yaml, \.yml or \.json file/);
  });
});

describe("the presets this repo actually ships", () => {
  // A tripwire, not a unit test: config/presets/ is committed and applied by
  // a fresh clone, so a typo there breaks setup for everyone. Kept honest by
  // loading the real directory rather than a fixture.
  const repoConfigRoot = path.resolve(__dirname, "..", "..", "..", "config");

  // shippedOnly: a developer machine has a real config/local/ overlay, and
  // without this the assertions below would pass in CI (where that directory
  // is empty, being gitignored) and fail locally — a red build caused by the
  // override feature working correctly.
  it("all parse, with no errors", async () => {
    const report = await loadAllPresets(repoConfigRoot, { shippedOnly: true });
    expect(report.errors).toEqual([]);
    expect(report.presets.length).toBeGreaterThan(0);
  });

  it("a developer's local overlay does not leak into the shipped set", async () => {
    const shipped = await loadAllPresets(repoConfigRoot, { shippedOnly: true });
    expect(shipped.overrides).toEqual([]);
    expect(shipped.presets.every((p) => p.origin === "shipped")).toBe(true);
  });

  it("does not load the example template as live configuration", async () => {
    // config/example.yaml is documentation: fictional stores and an
    // "acme-customer-export" importer. It originally sat in config/local/,
    // where the loader DID pick it up — it appeared in the override report and
    // would have been applied to a fresh clone's database. It now lives at
    // config root, which is scanned by nothing. This test is the tripwire that
    // stops it drifting back.
    const full = await loadAllPresets(repoConfigRoot);
    const names = full.presets.map((p) => p.preset.name);
    expect(names).not.toContain("acme-customer-export");
    expect(
      full.presets.some(
        (p) =>
          p.preset.kind === "traffic-store-mapping" &&
          p.preset.stores.some((st) => st.storeLocation === "Downtown Showroom"),
      ),
    ).toBe(false);
  });

  it("ships an example template that is nonetheless valid", async () => {
    // Not loaded is not the same as not checked — a template that does not
    // parse is worse than no template, because it is the first thing someone
    // copies.
    const text = await fs.readFile(path.join(repoConfigRoot, "example.yaml"), "utf8");
    const result = parsePresetText(text, "yaml");
    if (!result.ok) throw new Error(`config/example.yaml is invalid: ${result.errors.join("; ")}`);
    expect(result.bundle.presets.length).toBeGreaterThan(0);
  });

  it("keeps the ordorite preset and the TS data module in agreement", async () => {
    // Two representations of one mapping now exist: the shipped YAML preset
    // and lib/imports/data/ordoritePaymentMode.ts (which prisma/seed and
    // __tests__/imports both consume). That is exactly the duplication this
    // system is meant to remove, and the consolidation is a follow-up — until
    // then this tripwire is what stops them drifting silently, which for a
    // payment-type-to-GL mapping means money quietly landing in the wrong
    // account.
    const {
      ORDORITE_PAYMENT_MODE_FIELD_MAPPING,
      ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS,
    } = await import("@/lib/imports/data/ordoritePaymentMode");

    const report = await loadAllPresets(repoConfigRoot, { shippedOnly: true });
    const found = report.presets.find((p) => p.preset.name === "ordorite-payment-modes");
    expect(found).toBeDefined();
    if (!found || found.preset.kind !== "import-definition") throw new Error("narrowing");

    expect(found.preset.fieldMappings).toHaveLength(1);
    expect(found.preset.fieldMappings[0].sourceColumn).toBe(
      ORDORITE_PAYMENT_MODE_FIELD_MAPPING.sourceColumn,
    );
    expect(found.preset.fieldMappings[0].targetField).toBe(
      ORDORITE_PAYMENT_MODE_FIELD_MAPPING.targetField,
    );

    const fromPreset = flattenValueMappings(found.preset.valueMappings);
    const key = (r: { targetField: string; sourceValue: string; targetValue: string }) =>
      `${r.targetField}|${r.sourceValue}|${r.targetValue}`;
    expect(fromPreset.map(key).sort()).toEqual(
      ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS.map(key).sort(),
    );
  });

  it("includes a traffic mapping whose stores match the demo seed", async () => {
    // prisma/seed/demo/locations.ts creates exactly these showrooms. If the
    // seed's store names change and this preset does not, a fresh clone gets
    // a mapping that silently resolves nothing.
    const report = await loadAllPresets(repoConfigRoot, { shippedOnly: true });
    const traffic = report.presets.find((p) => p.preset.kind === "traffic-store-mapping");
    expect(traffic).toBeDefined();
    if (!traffic || traffic.preset.kind !== "traffic-store-mapping") throw new Error("narrowing");
    expect(traffic.preset.stores.map((s) => s.storeLocation).sort()).toEqual([
      "Millbrook Falls Showroom",
      "Wintergreen Harbor Showroom",
    ]);
  });
});
