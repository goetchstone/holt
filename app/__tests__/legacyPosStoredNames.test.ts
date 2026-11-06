// /app/__tests__/legacyPosStoredNames.test.ts
//
// A deployment may have set these settings before they had neutral names, and
// its environment is not in this repo. Each case goes through the code that
// reads the setting, because all three fail closed when unset: reports stop
// routing and returns stop being recognised, with no error to say why.

import { resolveImportRoute } from "@/lib/adapters/legacyPos/reportRouter";
import { isReturnOrder } from "@/lib/adapters/legacyPos/shared";
import { legacyPosEnv } from "@/lib/adapters/legacyPos/storedNames";

const NAMES = [
  "LEGACY_POS_REPORT_PREFIX",
  "LEGACY_POS_STORE_CODES",
  "LEGACY_POS_RETURN_PREFIXES",
  "ORDORITE_REPORT_PREFIX",
  "ORDORITE_STORE_CODES",
  "ORDORITE_RETURN_PREFIXES",
];

describe("a deployment's POS settings", () => {
  const saved = new Map(NAMES.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
  });

  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe("set under the earlier name", () => {
    it("still routes prefixed report filenames", () => {
      expect(resolveImportRoute("RH_Item_Export.csv")).toBeNull();
      process.env.ORDORITE_REPORT_PREFIX = "Riverbend_Home,RH";
      expect(resolveImportRoute("RH_Item_Export.csv")).toMatchObject({ importType: "products" });
    });

    it("still recognises returns by store code", () => {
      expect(isReturnOrder("AAOA1234")).toBe(false);
      process.env.ORDORITE_STORE_CODES = "AA,BB";
      expect(isReturnOrder("AAOA1234")).toBe(true);
    });

    it("still recognises returns by prefix", () => {
      expect(isReturnOrder("RT1234")).toBe(false);
      process.env.ORDORITE_RETURN_PREFIXES = "RT";
      expect(isReturnOrder("RT1234")).toBe(true);
    });
  });

  describe("set under both names", () => {
    it("takes the current name", () => {
      process.env.LEGACY_POS_STORE_CODES = "AA";
      process.env.ORDORITE_STORE_CODES = "BB";
      expect(isReturnOrder("AAOA1234")).toBe(true);
      expect(isReturnOrder("BBOA1234")).toBe(false);
    });

    it("takes an explicitly empty current name, so a setting can be turned off", () => {
      process.env.LEGACY_POS_STORE_CODES = "";
      process.env.ORDORITE_STORE_CODES = "AA";
      expect(legacyPosEnv("LEGACY_POS_STORE_CODES")).toBe("");
      expect(isReturnOrder("AAOA1234")).toBe(false);
    });
  });

  it("reads as unset when neither name is set", () => {
    expect(legacyPosEnv("LEGACY_POS_RETURN_PREFIXES")).toBeUndefined();
  });
});
