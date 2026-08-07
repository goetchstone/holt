// /app/__tests__/moduleManifest.test.ts
//
// Pure tests for the module manifest (lib/modules/registry.ts -- the single
// source of truth CLAUDE.md rules 6/37 call for, and docs/domains/modules.md).
// Two jobs:
//
//   1. Pin invariants the manifest itself must hold (unique keys).
//   2. Prove the featureCatalog.ts back-compat shim is behavior-preserving --
//      FEATURES is now DERIVED from MODULES, and this file hardcodes the
//      pre-refactor FEATURES list (key + defaultEnabled, copied from the
//      featureCatalog.ts this replaced) so a future edit to the manifest that
//      silently renames a key or flips a default fails here, independent of
//      MODULES itself.
//
// See also __tests__/featureCatalog.test.ts (the isFeatureEnabled/
// isValidFeatureKey contract, unchanged) and __tests__/navFeatureGating.test.ts
// (nav hiding, unchanged).

import { FEATURES } from "@/lib/featureCatalog";
import {
  MODULES,
  getModule,
  isValidModuleKey,
  isModuleOn,
  getToggleableModules,
  getModulesForSettingsIndex,
  isModuleSettingsRoutable,
} from "@/lib/modules";

// The exact (key, defaultEnabled) pairs featureCatalog.ts's FEATURES exported
// before this refactor -- order and values copied verbatim. This is the
// regression guard: it must NOT be derived from MODULES/FEATURES itself, or
// it would just test the derivation against its own source.
//
// A genuinely new module is added HERE too, in the position it occupies in the
// registry. That is the point: the list is a ledger of deliberate additions, so
// a module appearing by accident -- or a defaultEnabled quietly flipping to true
// on an existing one -- still fails. Every entry below defaultEnabled:false was
// off before and must stay off unless someone says otherwise in a diff.
const PRE_REFACTOR_FEATURES: ReadonlyArray<{ key: string; defaultEnabled: boolean }> = [
  { key: "warehousing", defaultEnabled: true },
  { key: "dispatch", defaultEnabled: false },
  { key: "consignment", defaultEnabled: false },
  { key: "purchasing", defaultEnabled: true },
  { key: "pos", defaultEnabled: true },
  { key: "giftCards", defaultEnabled: true },
  { key: "tills", defaultEnabled: true },
  { key: "accounting", defaultEnabled: false },
  { key: "marketing", defaultEnabled: false },
  { key: "cms", defaultEnabled: true },
  { key: "blog", defaultEnabled: false },
  { key: "booking", defaultEnabled: true },
  { key: "helpdesk", defaultEnabled: true },
  { key: "timeTracking", defaultEnabled: false },
  { key: "blogComments", defaultEnabled: false },
  { key: "billing", defaultEnabled: false },
  { key: "legacyPosImport", defaultEnabled: false },
  { key: "legacyArchive", defaultEnabled: false },
  { key: "clientPortal", defaultEnabled: false },
  // Added with the AI assistant. Off by default: it is text-to-SQL over the
  // deployment's own data, so it is opt-in per deployment, not something a
  // release switches on for everybody.
  { key: "ai", defaultEnabled: false },
  { key: "dmarcTools", defaultEnabled: false },
];

describe("module manifest (lib/modules/registry.ts)", () => {
  it("has a unique key for every module", () => {
    const keys = MODULES.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every module a non-empty name and description", () => {
    for (const m of MODULES) {
      expect(m.name.trim().length).toBeGreaterThan(0);
      expect(m.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("only uses the two documented categories", () => {
    for (const m of MODULES) {
      expect(["core", "addon"]).toContain(m.category);
    }
  });

  it("has exactly the pre-refactor module set, nothing added or removed", () => {
    expect(MODULES.map((m) => m.key).sort()).toEqual(
      PRE_REFACTOR_FEATURES.map((f) => f.key).sort(),
    );
  });
});

describe("FEATURES derived from MODULES is behavior-preserving", () => {
  it("matches the pre-refactor (key, defaultEnabled) list exactly, in order", () => {
    expect(FEATURES.map(({ key, defaultEnabled }) => ({ key, defaultEnabled }))).toEqual(
      PRE_REFACTOR_FEATURES,
    );
  });

  it("carries no extra fields beyond the original FeatureDef shape", () => {
    for (const f of FEATURES) {
      expect(Object.keys(f).sort()).toEqual(["defaultEnabled", "description", "key", "name"]);
    }
  });
});

describe("getModule / isValidModuleKey", () => {
  it("resolves a known key to its full ModuleDef", () => {
    const mod = getModule("dmarcTools");
    expect(mod?.name).toBe("Email Auth Tools (DMARC)");
    expect(mod?.category).toBe("addon");
  });

  it("rejects an unknown key", () => {
    expect(getModule("not-a-module")).toBeUndefined();
    expect(isValidModuleKey("not-a-module")).toBe(false);
    expect(isValidModuleKey("dmarcTools")).toBe(true);
  });
});

describe("isModuleOn", () => {
  it("resolves via explicit AppSettings value, else the manifest default", () => {
    expect(isModuleOn({ warehousing: false }, "warehousing")).toBe(false);
    expect(isModuleOn({}, "warehousing")).toBe(true); // unset -> default ON
    expect(isModuleOn({}, "dmarcTools")).toBe(false); // unset -> default OFF
    expect(isModuleOn({ dmarcTools: true }, "dmarcTools")).toBe(true);
  });
});

describe("getToggleableModules -- the Settings > Modules grid", () => {
  it("always includes core modules, on or off", () => {
    const keys = getToggleableModules({}).map((m) => m.key);
    expect(keys).toContain("warehousing"); // core, default on
    expect(keys).toContain("dispatch"); // core, default off
  });

  it("hides an addon module (dmarcTools) when it's off -- a furniture retailer never sees it", () => {
    const keys = getToggleableModules({}).map((m) => m.key);
    expect(keys).not.toContain("dmarcTools");

    const keysExplicitOff = getToggleableModules({ dmarcTools: false }).map((m) => m.key);
    expect(keysExplicitOff).not.toContain("dmarcTools");
  });

  it("surfaces an addon module once it's enabled (the Akritos case)", () => {
    const keys = getToggleableModules({ dmarcTools: true }).map((m) => m.key);
    expect(keys).toContain("dmarcTools");
  });
});

describe("getModulesForSettingsIndex -- the Settings sub-nav", () => {
  it("a disabled module contributes no nav/settings entry, even one with nav declared", () => {
    // dmarcTools declares `nav`, but defaults to off -- must not appear.
    const keys = getModulesForSettingsIndex({}).map((m) => m.key);
    expect(keys).not.toContain("dmarcTools");
  });

  it("an enabled module with nav appears in the index (dmarcTools, the Akritos case)", () => {
    const keys = getModulesForSettingsIndex({ dmarcTools: true }).map((m) => m.key);
    expect(keys).toContain("dmarcTools");
  });

  it("an enabled module with neither settings nor nav does not appear", () => {
    // warehousing is on by default and has no settings/nav manifest entry.
    const keys = getModulesForSettingsIndex({}).map((m) => m.key);
    expect(keys).not.toContain("warehousing");
  });
});

describe("isModuleSettingsRoutable -- /admin/settings/[module] gate", () => {
  it("false for an unknown key", () => {
    expect(isModuleSettingsRoutable({}, "not-a-module")).toBe(false);
  });

  it("false for a disabled module even if it declares nav", () => {
    expect(isModuleSettingsRoutable({}, "dmarcTools")).toBe(false);
  });

  it("true for an enabled module that declares nav", () => {
    expect(isModuleSettingsRoutable({ dmarcTools: true }, "dmarcTools")).toBe(true);
  });

  it("false for an enabled module with neither settings nor nav", () => {
    expect(isModuleSettingsRoutable({}, "warehousing")).toBe(false);
  });
});

describe("dmarcTools module -- the first manifest-driven module", () => {
  const dmarc = getModule("dmarcTools")!;

  it("is an addon, off by default", () => {
    expect(dmarc.category).toBe("addon");
    expect(dmarc.defaultEnabled).toBe(false);
  });

  it("declares its two public routes and its runbook, and no settings fields", () => {
    expect(dmarc.nav?.map((n) => n.href).sort()).toEqual([
      "/tools/dmarc-check",
      "/tools/dmarc-report",
    ]);
    expect(dmarc.docs).toBe("docs/domains/dmarc-tools.md");
    expect(dmarc.settings).toBeUndefined();
  });
});
