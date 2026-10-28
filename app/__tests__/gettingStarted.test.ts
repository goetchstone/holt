// /app/__tests__/gettingStarted.test.ts
//
// The getting-started checklist (lib/gettingStarted.ts), every item both ways,
// and the tax edge the checklist exists for: a deployment with no district
// resolvable charges 0% tax (resolveTaxRate.ts step 5), so "tax" must stay
// undone until every sale resolves one -- including the vacuous case of no
// stores at all.

import {
  buildGettingStarted,
  remainingItems,
  taxDistrictConfigured,
  type GettingStartedFacts,
  type GettingStartedItem,
  type GettingStartedKey,
} from "@/lib/gettingStarted";

/** A deployment with everything configured. Each test breaks one thing. */
function ready(over: Partial<GettingStartedFacts> = {}): GettingStartedFacts {
  return {
    activeStoreCount: 2,
    storesWithoutTaxDistrict: { count: 0, names: [] },
    activeTaxDistrictCount: 1,
    defaultTaxDistrictId: 7,
    setupConfirmedAt: "2026-10-27T14:00:00.000Z",
    vendorsWithMarkupCount: 3,
    storeWideDefaultMarkup: null,
    activeStaffCount: 4,
    paymentProvider: { name: "Stripe", configured: true },
    cashOnlyAcknowledgedAt: null,
    ...over,
  };
}

function item(facts: GettingStartedFacts, key: GettingStartedKey): GettingStartedItem {
  const found = buildGettingStarted(facts).find((i) => i.key === key);
  if (!found) throw new Error(`no ${key} item`);
  return found;
}

describe("buildGettingStarted", () => {
  it("lists every item, in order, all done for a configured deployment", () => {
    const items = buildGettingStarted(ready());
    expect(items.map((i) => i.key)).toEqual([
      "stores",
      "tax",
      "region",
      "markup",
      "staff",
      "payments",
    ]);
    expect(items.every((i) => i.done)).toBe(true);
    expect(remainingItems(items)).toEqual([]);
    // A done item carries no "what is missing" line.
    expect(items.every((i) => i.detail === undefined)).toBe(true);
  });

  it("a fresh install has every item to do", () => {
    const fresh = buildGettingStarted({
      activeStoreCount: 0,
      storesWithoutTaxDistrict: { count: 0, names: [] },
      activeTaxDistrictCount: 0,
      defaultTaxDistrictId: null,
      setupConfirmedAt: null,
      vendorsWithMarkupCount: 0,
      storeWideDefaultMarkup: null,
      activeStaffCount: 1,
      paymentProvider: { name: "Stripe", configured: false },
      cashOnlyAcknowledgedAt: null,
    });
    expect(remainingItems(fresh)).toHaveLength(6);
    expect(fresh.every((i) => typeof i.detail === "string" && i.detail.length > 0)).toBe(true);
  });

  describe("stores", () => {
    it("is done with at least one active store", () => {
      expect(item(ready({ activeStoreCount: 1 }), "stores").done).toBe(true);
    });
    it("is not done with none, and links to store setup", () => {
      const stores = item(ready({ activeStoreCount: 0 }), "stores");
      expect(stores.done).toBe(false);
      expect(stores.href).toBe("/app/admin/setup/stores");
    });
  });

  describe("tax", () => {
    it("is not done with no active tax district, whatever else is set, and links to district setup", () => {
      const tax = item(ready({ activeTaxDistrictCount: 0, defaultTaxDistrictId: 7 }), "tax");
      expect(tax.done).toBe(false);
      expect(tax.href).toBe("/app/admin/setup/tax");
      expect(tax.detail).toMatch(/0% tax/);
    });

    it("is done with a default district even when stores have none of their own", () => {
      const facts = ready({
        defaultTaxDistrictId: 7,
        storesWithoutTaxDistrict: { count: 2, names: ["Main", "Annex"] },
      });
      expect(item(facts, "tax").done).toBe(true);
    });

    it("is done with no default when every active store has its own district", () => {
      const facts = ready({
        defaultTaxDistrictId: null,
        activeStoreCount: 2,
        storesWithoutTaxDistrict: { count: 0, names: [] },
      });
      expect(item(facts, "tax").done).toBe(true);
    });

    it("is not done with no default and a store without a district, naming it", () => {
      const tax = item(
        ready({
          defaultTaxDistrictId: null,
          activeStoreCount: 2,
          storesWithoutTaxDistrict: { count: 1, names: ["Annex"] },
        }),
        "tax",
      );
      expect(tax.done).toBe(false);
      expect(tax.href).toBe("/app/admin/settings#sales-tax");
      expect(tax.detail).toBe(
        "Annex has no tax district and there is no default, so sales there are charged 0% tax.",
      );
    });

    it("names the first stores and counts the rest", () => {
      const tax = item(
        ready({
          defaultTaxDistrictId: null,
          activeStoreCount: 5,
          storesWithoutTaxDistrict: { count: 5, names: ["A", "B", "C"] },
        }),
        "tax",
      );
      expect(tax.detail).toMatch(/^A, B, C and 2 more stores have no tax district/);
    });

    it("is not done with no default and no stores -- 'every store' is not vacuously true", () => {
      const tax = item(
        ready({
          defaultTaxDistrictId: null,
          activeStoreCount: 0,
          storesWithoutTaxDistrict: { count: 0, names: [] },
        }),
        "tax",
      );
      expect(tax.done).toBe(false);
      expect(tax.detail).toMatch(/no default tax district/);
    });
  });

  describe("region", () => {
    it("is done once currency and timezone are confirmed", () => {
      expect(item(ready(), "region").done).toBe(true);
    });
    it("is not done while they are only defaults, and links to Localization", () => {
      const region = item(ready({ setupConfirmedAt: null }), "region");
      expect(region.done).toBe(false);
      expect(region.href).toBe("/app/admin/settings#localization");
    });
  });

  describe("markup", () => {
    it("is done with a vendor markup", () => {
      expect(item(ready({ vendorsWithMarkupCount: 1 }), "markup").done).toBe(true);
    });
    it("is done with only the store-wide markup", () => {
      const facts = ready({ vendorsWithMarkupCount: 0, storeWideDefaultMarkup: 2.2 });
      expect(item(facts, "markup").done).toBe(true);
    });
    it("is not done with neither, and links to the markup editor", () => {
      const markup = item(
        ready({ vendorsWithMarkupCount: 0, storeWideDefaultMarkup: null }),
        "markup",
      );
      expect(markup.done).toBe(false);
      expect(markup.href).toBe("/app/admin/pricing/configurator");
    });
  });

  describe("staff", () => {
    it("is done with someone besides the first account", () => {
      expect(item(ready({ activeStaffCount: 2 }), "staff").done).toBe(true);
    });
    it("is not done with only the bootstrap admin", () => {
      const staff = item(ready({ activeStaffCount: 1 }), "staff");
      expect(staff.done).toBe(false);
      expect(staff.href).toBe("/app/admin/staff");
    });
    it("is not done with no active staff at all", () => {
      expect(item(ready({ activeStaffCount: 0 }), "staff").done).toBe(false);
    });
  });

  describe("payments", () => {
    it("is done when the active processor is configured", () => {
      expect(item(ready(), "payments").done).toBe(true);
    });
    it("is done when the owner says cash and checks only, with no processor", () => {
      const facts = ready({
        paymentProvider: { name: "Square", configured: false },
        cashOnlyAcknowledgedAt: "2026-10-27T15:00:00.000Z",
      });
      expect(item(facts, "payments").done).toBe(true);
    });
    it("is not done with neither, names the processor, and links to Integrations", () => {
      const payments = item(
        ready({ paymentProvider: { name: "Square", configured: false } }),
        "payments",
      );
      expect(payments.done).toBe(false);
      expect(payments.href).toBe("/app/admin/settings/integrations");
      expect(payments.detail).toMatch(/^Square /);
    });
  });
});

describe("taxDistrictConfigured (the POS / New Quote banner)", () => {
  it("is true when the store has its own district, with or without a default", () => {
    expect(taxDistrictConfigured(3, null)).toBe(true);
    expect(taxDistrictConfigured(3, 7)).toBe(true);
  });
  it("is true when the store has none but the deployment default is set", () => {
    expect(taxDistrictConfigured(null, 7)).toBe(true);
  });
  it("is false when neither resolves -- the sale is charged 0% tax", () => {
    expect(taxDistrictConfigured(null, null)).toBe(false);
  });
  it("with no active store at all, only the default can answer", () => {
    expect(taxDistrictConfigured(undefined, 7)).toBe(true);
    expect(taxDistrictConfigured(undefined, null)).toBe(false);
  });
});
