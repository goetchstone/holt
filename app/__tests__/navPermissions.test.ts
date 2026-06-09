// /app/__tests__/navPermissions.test.ts

import { getVisibleNavItems, NAV_ITEMS, DEFAULT_NAV_PERMISSIONS } from "@/lib/auth/navPermissions";
import type { NavItem, DbPermission } from "@/lib/auth/navPermissions";

describe("getVisibleNavItems", () => {
  describe("ADMIN role", () => {
    it("returns all nav items regardless of permissions", () => {
      const items = getVisibleNavItems("ADMIN");
      expect(items).toHaveLength(NAV_ITEMS.length);
      const labels = items.map((i: NavItem) => i.label);
      expect(labels).toEqual(NAV_ITEMS.map((i) => i.label));
    });

    it("ignores dbPermissions when role is ADMIN", () => {
      const dbPerms: DbPermission[] = [{ navItem: "Sales", role: "WAREHOUSE" }];
      const items = getVisibleNavItems("ADMIN", dbPerms);
      expect(items).toHaveLength(NAV_ITEMS.length);
    });
  });

  describe("MANAGER role", () => {
    it("returns only items that include MANAGER in defaults", () => {
      const items = getVisibleNavItems("MANAGER");
      const labels = items.map((i: NavItem) => i.label);
      expect(labels).toContain("Sales");
      expect(labels).toContain("Service");
      expect(labels).toContain("Reports");
      expect(labels).toContain("Admin");
      expect(labels).toContain("Tools");
    });

    it("respects dbPermissions when provided", () => {
      const dbPerms: DbPermission[] = [
        { navItem: "Sales", role: "MANAGER" },
        { navItem: "Reports", role: "MANAGER" },
      ];
      const items = getVisibleNavItems("MANAGER", dbPerms);
      const labels = items.map((i: NavItem) => i.label);
      expect(labels).toEqual(["Sales", "Reports"]);
    });
  });

  describe("DESIGNER role with default permissions", () => {
    it("returns Sales, Reports, and Tools (designer-facing configurator)", () => {
      const items = getVisibleNavItems("DESIGNER");
      const labels = items.map((i: NavItem) => i.label);
      expect(labels).toContain("Sales");
      expect(labels).toContain("Reports");
      // Tools is exposed to designers so they can reach the Product
      // Configurator (retail-only price exploration). Query Builder card
      // on the /tools index page is still ADMIN-only via its own
      // `roles` filter.
      expect(labels).toContain("Tools");
      expect(labels).not.toContain("Service");
      expect(labels).not.toContain("Inventory");
      expect(labels).not.toContain("Admin");
      expect(labels).not.toContain("Purchasing");
      expect(labels).not.toContain("Warehouse");
    });
  });

  describe("WAREHOUSE role with default permissions", () => {
    it("returns Service, Purchasing, Warehouse, Inventory only", () => {
      const items = getVisibleNavItems("WAREHOUSE");
      const labels = items.map((i: NavItem) => i.label);
      expect(labels).toEqual(["Service", "Purchasing", "Warehouse", "Inventory"]);
    });
  });

  describe("REGISTER role with default permissions", () => {
    it("returns only Sales", () => {
      const items = getVisibleNavItems("REGISTER");
      const labels = items.map((i: NavItem) => i.label);
      expect(labels).toEqual(["Sales"]);
    });
  });

  describe("MARKETING role with default permissions", () => {
    it("returns Sales and Reports", () => {
      const items = getVisibleNavItems("MARKETING");
      const labels = items.map((i: NavItem) => i.label);
      expect(labels).toEqual(["Sales", "Reports"]);
    });
  });

  describe("unknown role with default permissions", () => {
    it("returns no items", () => {
      const items = getVisibleNavItems("INTERN");
      expect(items).toHaveLength(0);
    });
  });

  describe("database-driven permissions", () => {
    it("uses dbPermissions when provided and non-empty", () => {
      const dbPerms: DbPermission[] = [
        { navItem: "Sales", role: "DESIGNER" },
        { navItem: "Admin", role: "DESIGNER" },
      ];
      const items = getVisibleNavItems("DESIGNER", dbPerms);
      const labels = items.map((i: NavItem) => i.label);
      expect(labels).toContain("Sales");
      expect(labels).toContain("Admin");
      expect(labels).not.toContain("Reports");
    });

    it("falls back to defaults when dbPermissions is empty array", () => {
      const items = getVisibleNavItems("DESIGNER", []);
      const defaultItems = getVisibleNavItems("DESIGNER");
      expect(items).toEqual(defaultItems);
    });

    it("attaches correct roles from dbPermissions", () => {
      const dbPerms: DbPermission[] = [
        { navItem: "Sales", role: "DESIGNER" },
        { navItem: "Sales", role: "WAREHOUSE" },
      ];
      const items = getVisibleNavItems("DESIGNER", dbPerms);
      const sales = items.find((i: NavItem) => i.label === "Sales");
      expect(sales?.roles).toEqual(["DESIGNER", "WAREHOUSE"]);
    });
  });
});
