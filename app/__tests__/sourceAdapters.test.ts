// /app/__tests__/sourceAdapters.test.ts
//
// The registry's contract. These are the assertions that make "replace the
// source system with anything" checkable rather than aspirational: the seam
// holds if a second adapter is a registration, `none` is a real answer, and
// nothing outside lib/adapters/ names an adapter directly.

import {
  getSourceAdapter,
  isSourceAdapterId,
  listSourceAdapters,
  getActiveSourceAdapter,
} from "@/lib/adapters";
import { noneAdapter } from "@/lib/adapters/noneAdapter";
import { ordoriteAdapter, ORDORITE_ADAPTER_ID } from "@/lib/adapters/ordorite/adapter";
import { DEFAULT_APP_SETTINGS } from "@/lib/appSettings";

jest.mock("@/lib/appSettings", () => {
  const actual = jest.requireActual("@/lib/appSettings");
  return { ...actual, getAppSettings: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAppSettings } = require("@/lib/appSettings") as {
  getAppSettings: jest.Mock;
};

function settings(over: Partial<typeof DEFAULT_APP_SETTINGS>) {
  return { ...DEFAULT_APP_SETTINGS, features: {}, ...over };
}

describe("source adapter registry", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ships 'none' as the default, and it is a real adapter, not a null", async () => {
    // The whole reason the seam exists: before it, "no source system" and
    // "Ordorite, misconfigured" were the same state.
    expect(DEFAULT_APP_SETTINGS.sourceAdapterId).toBe("none");
    expect(isSourceAdapterId("none")).toBe(true);
    const summary = await noneAdapter.runImport({ dryRun: false, createdBy: "test" });
    expect(summary.errors).toEqual([]);
    expect(summary.imports).toEqual([]);
    expect(summary.message).toMatch(/no source system/i);
  });

  it("'none' is always ready — a deployment that imports nothing is not broken", async () => {
    await expect(noneAdapter.checkReadiness()).resolves.toEqual({ ready: true });
  });

  it("lists every adapter with an operator-readable label and description", () => {
    const list = listSourceAdapters();
    expect(list.map((a) => a.id).sort()).toEqual(["none", "ordorite"]);
    for (const a of list) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown id loudly instead of silently importing nothing", () => {
    expect(isSourceAdapterId("netsuite")).toBe(false);
    // Naming the known ids in the message is the difference between "why is
    // the import dead" and "this image doesn't ship that adapter".
    expect(() => getSourceAdapter("netsuite")).toThrow(/not available in this build/);
    expect(() => getSourceAdapter("netsuite")).toThrow(/none, ordorite/);
  });

  it("resolves the configured adapter when its module flag is on", async () => {
    getAppSettings.mockResolvedValue(
      settings({ sourceAdapterId: ORDORITE_ADAPTER_ID, features: { legacyPosImport: true } }),
    );
    await expect(getActiveSourceAdapter()).resolves.toBe(ordoriteAdapter);
  });

  it("falls back to 'none' when the adapter's module is switched off", async () => {
    // Turning a module off is how an operator disables a feature. It would be
    // perverse for that to start throwing on a nightly cron -- and the
    // selection stays in AppSettings, so re-enabling restores it.
    getAppSettings.mockResolvedValue(
      settings({ sourceAdapterId: ORDORITE_ADAPTER_ID, features: { legacyPosImport: false } }),
    );
    await expect(getActiveSourceAdapter()).resolves.toBe(noneAdapter);
  });

  it("throws when the stored id is not in this build", async () => {
    // Distinct from the module-off case on purpose: this is a wrong image or a
    // botched rename, and importing nothing while reporting success is how
    // reports go stale with nobody told.
    getAppSettings.mockResolvedValue(settings({ sourceAdapterId: "sap" }));
    await expect(getActiveSourceAdapter()).rejects.toThrow(/not available in this build/);
  });

  it("every adapter satisfies the interface, including ones added later", () => {
    for (const { id } of listSourceAdapters()) {
      const a = getSourceAdapter(id);
      expect(typeof a.checkReadiness).toBe("function");
      expect(typeof a.runImport).toBe("function");
      expect(a.id).toBe(id);
      // null is meaningful (needs no flag); undefined means someone forgot.
      expect(a.moduleFlag === null || typeof a.moduleFlag === "string").toBe(true);
    }
  });
});
