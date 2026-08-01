// /app/__tests__/imports/runnerRegistry.test.ts
//
// Tests the runner registry's resolution (lib/imports/runnerRegistry.ts) --
// the code-backed escape hatch's compile-time switch. Only resolution is
// exercised here (no rows are actually run through a runner, which would
// touch Prisma); the runners themselves are adapters over the existing,
// already-tested genericImportRunner.ts customer/product paths.

import {
  getImportRunner,
  isRegisteredRunnerKey,
  listRegisteredRunnerKeys,
} from "@/lib/imports/runnerRegistry";
import { runCustomerRunner } from "@/lib/imports/runners/customerRunner";
import { runProductRunner } from "@/lib/imports/runners/productRunner";

describe("registered runners", () => {
  test("customer and product are registered, proving the escape hatch with a real consumer", () => {
    expect(listRegisteredRunnerKeys().sort()).toEqual(["customer", "product"]);
    expect(isRegisteredRunnerKey("customer")).toBe(true);
    expect(isRegisteredRunnerKey("product")).toBe(true);
  });

  test("getImportRunner resolves a registered key to its implementation", () => {
    expect(getImportRunner("customer")).toBe(runCustomerRunner);
    expect(getImportRunner("product")).toBe(runProductRunner);
  });
});

describe("unknown runner keys", () => {
  test("isRegisteredRunnerKey is false for an unknown key", () => {
    expect(isRegisteredRunnerKey("ordoriteSales")).toBe(false);
  });

  test("getImportRunner throws a readable error for an unknown key", () => {
    expect(() => getImportRunner("ordoriteSales")).toThrow(
      /Import runner "ordoriteSales" is not registered\. Registered runners: customer, product\./,
    );
  });

  test("getImportRunner throws for an empty key", () => {
    expect(() => getImportRunner("")).toThrow(/is not registered/);
  });
});
