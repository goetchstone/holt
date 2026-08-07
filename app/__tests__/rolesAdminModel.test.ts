// /app/__tests__/rolesAdminModel.test.ts
//
// Pure tests for the Roles admin GUI's view model
// (src/app/(dashboard)/app/admin/setup/roles/rolesModel.ts). No DOM, no server:
// every function under test is a transform over already-fetched data, which is
// the point of keeping them out of the JSX (CLAUDE.md rule 14).
//
// The cases that matter are the ones where a wrong answer is a broken install
// rather than an ugly screen:
//   - a baseline key must never be offered as a checkbox NOR sent as a grant;
//   - cloning the wildcard role must expand to the catalog, not to nothing;
//   - a permission in a domain the payload never labels must still be shown;
//   - delete must stay disarmed until the reassignment question is answered.

import {
  baselineEntries,
  clonedGrants,
  deleteBlockedReason,
  deriveRoleKey,
  describeGrants,
  grantDiff,
  groupGrantsByDomain,
  isRefusal,
  reassignSentence,
  reassignTargets,
  responseStatus,
  sanitizeGrants,
  sensitiveGrants,
  staffCountPhrase,
  type CatalogPayload,
  type RoleSummary,
} from "../src/app/(dashboard)/app/admin/setup/roles/rolesModel";

const BASELINE = ["staff.self"];

const CATALOG: CatalogPayload = {
  domains: [
    { key: "sales", label: "Sales", description: "Quotes, orders, proposals." },
    { key: "payment", label: "Payments", description: "Taking and returning money." },
    { key: "staff", label: "Staff", description: "People, roles, time." },
  ],
  permissions: [
    {
      key: "sales.read",
      domain: "sales",
      label: "View orders",
      description: "See quotes, orders and proposals.",
      sensitive: false,
    },
    {
      key: "sales.discount",
      domain: "sales",
      label: "Apply discounts",
      description: "Reduce a line or order price below list.",
      sensitive: true,
    },
    {
      key: "payment.refund",
      domain: "payment",
      label: "Refund payment",
      description: "Return money to a customer.",
      sensitive: true,
    },
    {
      key: "staff.self",
      domain: "staff",
      label: "Do your own job",
      description: "See your own schedule and record your own time.",
      sensitive: false,
    },
    {
      key: "staff.manage",
      domain: "staff",
      label: "Manage staff",
      description: "Create staff and assign roles — grants power to others.",
      sensitive: true,
    },
  ],
};

function roleSummary(over: Partial<RoleSummary> = {}): RoleSummary {
  return {
    id: 1,
    key: "FLOOR_LEAD",
    name: "Floor Lead",
    description: null,
    isSystem: false,
    grantsAllPermissions: false,
    grantsCustomized: false,
    rank: 0,
    permissionCount: 2,
    staffCount: 0,
    ...over,
  };
}

describe("deriveRoleKey", () => {
  it("turns an operator's name into the built-ins' shape", () => {
    expect(deriveRoleKey("Floor Lead")).toBe("FLOOR_LEAD");
  });

  it("collapses punctuation runs into single separators", () => {
    expect(deriveRoleKey("front-of-house  (evening)")).toBe("FRONT_OF_HOUSE_EVENING");
  });

  it("strips accents rather than dropping the letter", () => {
    expect(deriveRoleKey("Café Manager")).toBe("CAFE_MANAGER");
  });

  it("trims separators off both ends", () => {
    expect(deriveRoleKey("  lead  ")).toBe("LEAD");
  });

  it("returns empty for a name with nothing to build from", () => {
    expect(deriveRoleKey("!!!")).toBe("");
  });

  it("never ends on a separator after truncation", () => {
    const key = deriveRoleKey("a".repeat(39) + " tail");
    expect(key.length).toBeLessThanOrEqual(40);
    expect(key.endsWith("_")).toBe(false);
  });
});

describe("groupGrantsByDomain", () => {
  it("groups in catalog order and omits the baseline", () => {
    const groups = groupGrantsByDomain(CATALOG, BASELINE);
    expect(groups.map((g) => g.key)).toEqual(["sales", "payment", "staff"]);
    const staff = groups.find((g) => g.key === "staff");
    expect(staff?.permissions.map((p) => p.key)).toEqual(["staff.manage"]);
  });

  it("drops a domain left with nothing grantable", () => {
    const groups = groupGrantsByDomain(CATALOG, ["staff.self", "staff.manage"]);
    expect(groups.map((g) => g.key)).toEqual(["sales", "payment"]);
  });

  it("still shows a permission whose domain the payload never labels", () => {
    const catalog: CatalogPayload = {
      domains: [],
      permissions: [
        {
          key: "future.thing",
          domain: "future",
          label: "Do the new thing",
          description: "Whatever a later release added.",
          sensitive: false,
        },
      ],
    };
    const groups = groupGrantsByDomain(catalog, BASELINE);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("future");
    expect(groups[0].permissions.map((p) => p.key)).toEqual(["future.thing"]);
  });
});

describe("baselineEntries", () => {
  it("describes the floor in the catalog's own words", () => {
    expect(baselineEntries(CATALOG, BASELINE)).toEqual([
      {
        key: "staff.self",
        label: "Do your own job",
        description: "See your own schedule and record your own time.",
      },
    ]);
  });

  it("still lists a baseline key the catalog has not caught up with", () => {
    expect(baselineEntries(CATALOG, ["staff.future"])).toEqual([
      { key: "staff.future", label: "staff.future", description: "" },
    ]);
  });
});

describe("sanitizeGrants", () => {
  it("never sends a baseline key", () => {
    expect(sanitizeGrants(["staff.self", "sales.read"], BASELINE)).toEqual(["sales.read"]);
  });

  it("dedupes and sorts so the payload is stable", () => {
    expect(sanitizeGrants(["sales.read", "payment.refund", "sales.read"], BASELINE)).toEqual([
      "payment.refund",
      "sales.read",
    ]);
  });
});

describe("clonedGrants", () => {
  it("copies an ordinary role's grants", () => {
    const grants = clonedGrants(
      { permissions: ["sales.read", "staff.self"], grantsAllPermissions: false },
      CATALOG,
      BASELINE,
    );
    expect(grants).toEqual(["sales.read"]);
  });

  it("expands the wildcard against the catalog instead of copying nothing", () => {
    const grants = clonedGrants({ permissions: [], grantsAllPermissions: true }, CATALOG, BASELINE);
    expect(grants).toEqual(["payment.refund", "sales.discount", "sales.read", "staff.manage"]);
    expect(grants).not.toContain("staff.self");
  });
});

describe("grantDiff", () => {
  it("reports both directions", () => {
    expect(grantDiff(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
  });

  it("is empty when nothing moved", () => {
    expect(grantDiff(["a", "b"], ["a", "b"])).toEqual({ added: [], removed: [] });
  });
});

describe("describeGrants / sensitiveGrants", () => {
  it("resolves keys to catalog defs and drops unknown ones", () => {
    const defs = describeGrants(["payment.refund", "gone.away"], CATALOG);
    expect(defs.map((d) => d.label)).toEqual(["Refund payment"]);
  });

  it("picks out only the ones that move money or hand over power", () => {
    const sensitive = sensitiveGrants(["sales.read", "payment.refund", "staff.manage"], CATALOG);
    expect(sensitive.map((p) => p.key)).toEqual(["payment.refund", "staff.manage"]);
  });
});

describe("reassignSentence", () => {
  it("says nobody moves when nobody holds it", () => {
    expect(reassignSentence(0, null)).toBe("Nobody holds this role, so no one has to move.");
  });

  it("asks the question while the answer is missing", () => {
    expect(reassignSentence(1, null)).toBe(
      "1 staff member holds this role. Choose where they go before deleting it.",
    );
  });

  it("names the destination and the count once answered", () => {
    expect(reassignSentence(3, "Designer")).toBe(
      "3 staff members hold this role and will move to Designer.",
    );
  });
});

describe("staffCountPhrase", () => {
  it("singularises one", () => {
    expect(staffCountPhrase(1)).toBe("1 staff member");
  });

  it("pluralises everything else", () => {
    expect(staffCountPhrase(0)).toBe("0 staff members");
    expect(staffCountPhrase(4)).toBe("4 staff members");
  });
});

describe("deleteBlockedReason", () => {
  it("refuses a shipped role outright", () => {
    const reason = deleteBlockedReason(roleSummary({ isSystem: true }), null);
    expect(reason).toContain("ship with holt");
  });

  it("stays blocked while staff have nowhere to go", () => {
    expect(deleteBlockedReason(roleSummary({ staffCount: 2 }), null)).toBe(
      "Choose the role these staff move to.",
    );
  });

  it("refuses moving staff into the role being deleted", () => {
    expect(deleteBlockedReason(roleSummary({ id: 7, staffCount: 2 }), 7)).toBe(
      "Staff cannot be moved to the role being deleted.",
    );
  });

  it("arms once staff have somewhere to go", () => {
    expect(deleteBlockedReason(roleSummary({ id: 7, staffCount: 2 }), 9)).toBeNull();
  });

  it("arms straight away when nobody holds the role", () => {
    expect(deleteBlockedReason(roleSummary({ staffCount: 0 }), null)).toBeNull();
  });
});

describe("reassignTargets", () => {
  it("excludes the role being deleted", () => {
    const roles = [roleSummary({ id: 1 }), roleSummary({ id: 2 }), roleSummary({ id: 3 })];
    expect(reassignTargets(roles, 2).map((r) => r.id)).toEqual([1, 3]);
  });
});

describe("responseStatus / isRefusal", () => {
  it("reads the status off an axios-shaped error", () => {
    expect(responseStatus({ response: { status: 409 } })).toBe(409);
    expect(isRefusal({ response: { status: 409 } })).toBe(true);
  });

  it("treats anything else as not a refusal", () => {
    expect(isRefusal({ response: { status: 500 } })).toBe(false);
    expect(isRefusal(new Error("Network Error"))).toBe(false);
    expect(isRefusal(null)).toBe(false);
    expect(responseStatus(undefined)).toBeNull();
  });
});
