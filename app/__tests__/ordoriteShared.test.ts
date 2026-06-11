// /app/__tests__/ordoriteShared.test.ts
//
// Pure-helper coverage of the Ordorite adapter's CSV row normalizers
// (@/lib/adapters/ordorite/shared) plus the source-agnostic coercion +
// customer-name helpers (@/lib/importHelpers) the adapter re-exports.
// Ported from the upstream ordoriteImport.test.ts suite. The runner
// orchestration that exercises Prisma queries lives in the integration
// suites — the fake-Prisma block at the bottom only pins the create-call
// SHAPE for findProduct's auto-create path.

import {
  parseTaxLabel,
  resolvePaymentMode,
  isRefundPayment,
  isReturnOrder,
  isRewriteOrder,
  rewriteBaseOrderno,
  deriveSalesOrderStatus,
  isValidEmail,
  normalizeEmail,
  parseOrdoriteAddress,
  parseDateFlexible,
  derivePOStatus,
  classifyPOReceiptStatus,
  findProduct,
  clearAutoCreateCachesForTesting,
} from "@/lib/adapters/ordorite/shared";
import {
  safeString,
  safeFloat,
  safeDate,
  splitCustomerName,
  isUntrustedMergeEmail,
} from "@/lib/importHelpers";

// ─── safeString ─────────────────────────────────────────────────────

describe("safeString", () => {
  it("returns undefined for null", () => {
    expect(safeString(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(safeString(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(safeString("")).toBeUndefined();
  });

  it("returns undefined for @ placeholder", () => {
    expect(safeString("@")).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(safeString("  hello  ")).toBe("hello");
  });

  it("collapses CR/LF into spaces", () => {
    expect(safeString("line1\r\nline2\nline3")).toBe("line1 line2 line3");
  });

  it("converts numbers to strings", () => {
    expect(safeString(42)).toBe("42");
  });

  it("returns undefined for whitespace-only strings", () => {
    expect(safeString("   ")).toBeUndefined();
  });
});

// ─── safeFloat ──────────────────────────────────────────────────────

describe("safeFloat", () => {
  it("returns 0 for null", () => {
    expect(safeFloat(null)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(safeFloat(undefined)).toBe(0);
  });

  it("parses plain numbers", () => {
    expect(safeFloat("123.45")).toBe(123.45);
  });

  it("strips dollar signs and commas", () => {
    expect(safeFloat("$1,299.99")).toBe(1299.99);
  });

  it("handles negative values", () => {
    expect(safeFloat("-50.25")).toBe(-50.25);
  });

  it("returns 0 for non-numeric strings", () => {
    expect(safeFloat("not a number")).toBe(0);
  });

  it("returns 0 for Infinity", () => {
    expect(safeFloat("Infinity")).toBe(0);
  });

  it("passes through numeric values", () => {
    expect(safeFloat(42)).toBe(42);
  });
});

// ─── safeDate ───────────────────────────────────────────────────────

describe("safeDate", () => {
  it("returns undefined for null", () => {
    expect(safeDate(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(safeDate("")).toBeUndefined();
  });

  it("parses ISO date strings", () => {
    const d = safeDate("2026-03-15");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2026);
  });

  it("returns undefined for garbage strings", () => {
    expect(safeDate("not a date")).toBeUndefined();
  });
});

// ─── parseTaxLabel ──────────────────────────────────────────────────

describe("parseTaxLabel", () => {
  it("parses CT 6.35% tax label", () => {
    const result = parseTaxLabel("CT 6.35%");
    expect(result.districtShortName).toBe("CT");
    expect(result.taxRate).toBeCloseTo(0.0635);
    expect(result.exemptReasonName).toBeNull();
  });

  it("parses NY 8% tax label", () => {
    const result = parseTaxLabel("NY 8%");
    expect(result.districtShortName).toBe("NY");
    expect(result.taxRate).toBeCloseTo(0.08);
  });

  it("parses Tax Exempt - Resale", () => {
    const result = parseTaxLabel("Tax Exempt - Resale");
    expect(result.districtShortName).toBeNull();
    expect(result.taxRate).toBe(0);
    expect(result.exemptReasonName).toBe("Resale");
  });

  it("parses Tax Exempt - Out of State", () => {
    const result = parseTaxLabel("Tax Exempt - Out of State");
    expect(result.exemptReasonName).toBe("Out of State");
  });

  it("returns nulls for empty/missing label", () => {
    const result = parseTaxLabel(null);
    expect(result.districtShortName).toBeNull();
    expect(result.taxRate).toBeNull();
    expect(result.exemptReasonName).toBeNull();
  });

  it("returns nulls for unrecognized format", () => {
    const result = parseTaxLabel("something weird");
    expect(result.districtShortName).toBeNull();
    expect(result.taxRate).toBeNull();
  });
});

// ─── resolvePaymentMode ─────────────────────────────────────────────

describe("resolvePaymentMode", () => {
  it("maps Ordorite code 5 to Cash", () => {
    expect(resolvePaymentMode("5")).toBe("Cash");
  });

  it("maps Ordorite code 4 to Check", () => {
    expect(resolvePaymentMode("4")).toBe("Check");
  });

  it("maps Ordorite code 6 to Gift Card", () => {
    expect(resolvePaymentMode("6")).toBe("Gift Card");
  });

  it("maps Refund to Refund", () => {
    expect(resolvePaymentMode("Refund")).toBe("Refund");
  });

  it("returns Unknown for empty input", () => {
    expect(resolvePaymentMode(null)).toBe("Unknown");
    expect(resolvePaymentMode("")).toBe("Unknown");
  });

  it("passes through unmapped values", () => {
    expect(resolvePaymentMode("99")).toBe("99");
  });

  it("strips trailing decimals from Ordorite codes", () => {
    expect(resolvePaymentMode("27.00")).toBe("Card Connect");
    expect(resolvePaymentMode("28.00")).toBe("Card Not Present");
    expect(resolvePaymentMode("5.00")).toBe("Cash");
    expect(resolvePaymentMode("6.00")).toBe("Gift Card");
  });

  it("maps new codes: Credit Note, Charity, Marketing", () => {
    expect(resolvePaymentMode("29")).toBe("Credit Note");
    expect(resolvePaymentMode("30")).toBe("Charity");
    expect(resolvePaymentMode("32")).toBe("Marketing");
  });
});

// ─── isRefundPayment ────────────────────────────────────────────────

describe("isRefundPayment", () => {
  it("detects refund by payment type", () => {
    expect(isRefundPayment("Refund", 100)).toBe(true);
    expect(isRefundPayment("Credit Note", 50)).toBe(true);
  });

  it("detects refund by negative amount", () => {
    expect(isRefundPayment("Card Connect", -200)).toBe(true);
  });

  it("returns false for normal payments", () => {
    expect(isRefundPayment("Card Connect", 500)).toBe(false);
    expect(isRefundPayment("Cash", 100)).toBe(false);
  });
});

// ─── isValidEmail ───────────────────────────────────────────────────

describe("isValidEmail", () => {
  it("accepts valid emails", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("first.last@company.co")).toBe(true);
  });

  it("rejects emails without @", () => {
    expect(isValidEmail("notanemail")).toBe(false);
  });

  it("rejects emails without domain", () => {
    expect(isValidEmail("user@")).toBe(false);
  });

  it("rejects emails with spaces", () => {
    expect(isValidEmail("user @example.com")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });
});

// ─── isUntrustedMergeEmail ──────────────────────────────────────────

describe("isUntrustedMergeEmail", () => {
  // Staff sometimes type their OWN email when entering customer records
  // in the POS. The shared-email merge in findOrCreateCustomer would then
  // wrongly cluster distinct customers. The guard blocks any email whose
  // DOMAIN contains COMPANY_EMAIL_DOMAIN. A short stem ("sayb") covers
  // the canonical company domain plus every typo variant seen in prod
  // data (saybrookhome.com, saybrokkhome.com, saybrookhome.comf, ...).
  const ORIGINAL_DOMAIN = process.env.COMPANY_EMAIL_DOMAIN;

  beforeAll(() => {
    process.env.COMPANY_EMAIL_DOMAIN = "sayb";
  });

  afterAll(() => {
    if (ORIGINAL_DOMAIN === undefined) {
      delete process.env.COMPANY_EMAIL_DOMAIN;
    } else {
      process.env.COMPANY_EMAIL_DOMAIN = ORIGINAL_DOMAIN;
    }
  });

  it("flags canonical staff emails", () => {
    expect(isUntrustedMergeEmail("joneil@saybrookhome.com")).toBe(true);
    expect(isUntrustedMergeEmail("gstone@saybrookhome.com")).toBe(true);
  });

  it("flags case-insensitively", () => {
    expect(isUntrustedMergeEmail("JONEIL@SAYBROOKHOME.COM")).toBe(true);
    expect(isUntrustedMergeEmail("GStone@SaybrookHome.com")).toBe(true);
  });

  it("flags known typo domains seen in prod", () => {
    expect(isUntrustedMergeEmail("wcope@saybrokkhome.com")).toBe(true);
    expect(isUntrustedMergeEmail("joneil@saybrookhome.comf")).toBe(true);
  });

  it("flags any company-like internal domain (defense in depth)", () => {
    expect(isUntrustedMergeEmail("user@oldsaybrook-home.com")).toBe(true);
    expect(isUntrustedMergeEmail("user@saybrookbarn.com")).toBe(true);
  });

  it("passes external customer emails through", () => {
    expect(isUntrustedMergeEmail("jane@gmail.com")).toBe(false);
    expect(isUntrustedMergeEmail("john.doe@comcast.net")).toBe(false);
    expect(isUntrustedMergeEmail("first.last@example.org")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isUntrustedMergeEmail(null)).toBe(false);
    expect(isUntrustedMergeEmail(undefined)).toBe(false);
    expect(isUntrustedMergeEmail("")).toBe(false);
  });

  it("does not flag external emails that mention the company in the local part", () => {
    // The stem appearing BEFORE the @ is fine — only the domain part is
    // checked (the guard slices on lastIndexOf("@") for this reason).
    expect(isUntrustedMergeEmail("saybrook.fan@gmail.com")).toBe(false);
    expect(isUntrustedMergeEmail("loves-saybrook@yahoo.com")).toBe(false);
  });

  it("is disabled entirely when COMPANY_EMAIL_DOMAIN is unset", () => {
    // Holt-specific contract: without the env var the guard is a no-op,
    // so deployments that never configure it keep plain email matching.
    delete process.env.COMPANY_EMAIL_DOMAIN;
    try {
      expect(isUntrustedMergeEmail("joneil@saybrookhome.com")).toBe(false);
    } finally {
      process.env.COMPANY_EMAIL_DOMAIN = "sayb";
    }
  });
});

// ─── splitCustomerName ──────────────────────────────────────────────

describe("splitCustomerName", () => {
  // Used by findOrCreateCustomer's name-and-email match guard.

  it("splits 'First Last' into firstName + lastName", () => {
    expect(splitCustomerName("Aimee Sorbo")).toEqual({
      firstName: "Aimee",
      lastName: "Sorbo",
    });
  });

  it("treats everything after the first token as lastName", () => {
    expect(splitCustomerName("Sandy and David Favale")).toEqual({
      firstName: "Sandy",
      lastName: "and David Favale",
    });
  });

  it("collapses multiple internal spaces", () => {
    expect(splitCustomerName("First    Last")).toEqual({
      firstName: "First",
      lastName: "Last",
    });
  });

  it("returns nulls for empty/null input", () => {
    expect(splitCustomerName(null)).toEqual({ firstName: null, lastName: null });
    expect(splitCustomerName("")).toEqual({ firstName: null, lastName: null });
    expect(splitCustomerName("   ")).toEqual({ firstName: null, lastName: null });
  });

  it("single-token name has firstName but no lastName", () => {
    expect(splitCustomerName("Madonna")).toEqual({ firstName: "Madonna", lastName: null });
  });
});

// ─── normalizeEmail ─────────────────────────────────────────────────

describe("normalizeEmail", () => {
  it("lowercases and returns valid email", () => {
    expect(normalizeEmail("User@Example.COM")).toBe("user@example.com");
  });

  it("returns null for empty/null input", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });

  it("returns null for @ placeholder", () => {
    expect(normalizeEmail("@")).toBeNull();
  });

  it("returns null for invalid email", () => {
    expect(normalizeEmail("notanemail")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(normalizeEmail("  user@test.com  ")).toBe("user@test.com");
  });
});

// ─── parseOrdoriteAddress ───────────────────────────────────────────

describe("parseOrdoriteAddress", () => {
  it("parses street, city, state, country format", () => {
    const result = parseOrdoriteAddress("123 Main St, Hartford, CT, United States");
    expect(result).toEqual({
      address1: "123 Main St",
      city: "Hartford",
      state: "CT",
    });
  });

  it("parses without country (3 parts)", () => {
    const result = parseOrdoriteAddress("45 Oak Ave, Glastonbury, CT");
    expect(result).toEqual({
      address1: "45 Oak Ave",
      city: "Glastonbury",
      state: "CT",
    });
  });

  it("returns null for empty input", () => {
    expect(parseOrdoriteAddress(null)).toBeNull();
    expect(parseOrdoriteAddress("")).toBeNull();
  });

  it("returns null for fewer than 3 parts", () => {
    expect(parseOrdoriteAddress("just a street")).toBeNull();
    expect(parseOrdoriteAddress("street, city")).toBeNull();
  });

  it("trims whitespace from parts", () => {
    const result = parseOrdoriteAddress("  123 Main St ,  Hartford ,  CT  ");
    expect(result).toEqual({
      address1: "123 Main St",
      city: "Hartford",
      state: "CT",
    });
  });

  it("handles apartment/unit prefix in address", () => {
    const result = parseOrdoriteAddress("Apt B, 298 Highland Avenue, Cheshire, CT, United States");
    expect(result).toEqual({
      address1: "Apt B, 298 Highland Avenue",
      city: "Cheshire",
      state: "CT",
    });
  });

  it("handles PO Box prefix in address", () => {
    const result = parseOrdoriteAddress("PO Box 84, 22 Robin Rd, Marion, CT, USA");
    expect(result).toEqual({
      address1: "PO Box 84, 22 Robin Rd",
      city: "Marion",
      state: "CT",
    });
  });

  it("handles unit prefix without country", () => {
    const result = parseOrdoriteAddress("Unit 5, 8 Saint Andrews Circle, Wallingford, CT");
    expect(result).toEqual({
      address1: "Unit 5, 8 Saint Andrews Circle",
      city: "Wallingford",
      state: "CT",
    });
  });

  it("handles building/suite style prefix", () => {
    const result = parseOrdoriteAddress("D13 North, 140 Lodge Road, Ludlow, VT, United States");
    expect(result).toEqual({
      address1: "D13 North, 140 Lodge Road",
      city: "Ludlow",
      state: "VT",
    });
  });

  it("strips zip code merged into state field", () => {
    const result = parseOrdoriteAddress("57 Princeton Lane, Glastonbury, CT 06033");
    expect(result).toEqual({
      address1: "57 Princeton Lane",
      city: "Glastonbury",
      state: "CT",
    });
  });

  it("drops trailing zip code as separate part", () => {
    const result = parseOrdoriteAddress("57 Sunrise Dr., Glastonbury, CT, 06033");
    expect(result).toEqual({
      address1: "57 Sunrise Dr.",
      city: "Glastonbury",
      state: "CT",
    });
  });
});

// ─── parseDateFlexible ──────────────────────────────────────────────

describe("parseDateFlexible", () => {
  it("parses MM/DD/YYYY format", () => {
    const d = parseDateFlexible("03/15/2026");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(2); // March = 2 (0-indexed)
    expect(d!.getDate()).toBe(15);
  });

  it("parses YYYY-MM-DD format", () => {
    const d = parseDateFlexible("2026-03-15");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(2);
    expect(d!.getDate()).toBe(15);
  });

  it("parses single-digit month/day", () => {
    const d = parseDateFlexible("1/5/2026");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getMonth()).toBe(0); // January
    expect(d!.getDate()).toBe(5);
  });

  it("returns undefined for empty input", () => {
    expect(parseDateFlexible(null)).toBeUndefined();
    expect(parseDateFlexible("")).toBeUndefined();
  });

  it("returns undefined for garbage", () => {
    expect(parseDateFlexible("not a date")).toBeUndefined();
  });
});

// ─── derivePOStatus ─────────────────────────────────────────────────

describe("derivePOStatus", () => {
  it("maps 'received' to RECEIVED_FULL", () => {
    expect(derivePOStatus("received")).toBe("RECEIVED_FULL");
  });

  it("maps 'Received' (case-insensitive) to RECEIVED_FULL", () => {
    expect(derivePOStatus("Received")).toBe("RECEIVED_FULL");
  });

  it("maps 'cancelled' to CANCELLED", () => {
    expect(derivePOStatus("cancelled")).toBe("CANCELLED");
  });

  it("maps 'part received' to RECEIVED_PARTIAL", () => {
    expect(derivePOStatus("part received")).toBe("RECEIVED_PARTIAL");
  });

  // Ordorite's Daily Quote Temp Purchase Orders report emits
  // `Postatus = "Temporary"` for POs that exist but haven't been
  // finalized yet. Map to DRAFT so they're distinguishable from real
  // confirmed POs in reports and dispatch boards.
  it("maps 'Temporary' to DRAFT (Ordorite temp-items Postatus)", () => {
    expect(derivePOStatus("Temporary")).toBe("DRAFT");
  });

  it("maps 'temporary' (case-insensitive) to DRAFT", () => {
    expect(derivePOStatus("temporary")).toBe("DRAFT");
  });

  it("defaults to CONFIRMED for empty input", () => {
    expect(derivePOStatus(null)).toBe("CONFIRMED");
    expect(derivePOStatus("")).toBe("CONFIRMED");
  });

  it("defaults to CONFIRMED for unknown status", () => {
    expect(derivePOStatus("something else")).toBe("CONFIRMED");
  });
});

// ─── isReturnOrder ──────────────────────────────────────────────────

describe("isReturnOrder", () => {
  it("detects R-prefixed order numbers", () => {
    expect(isReturnOrder("R12345")).toBe(true);
    expect(isReturnOrder("R-12345")).toBe(true);
    expect(isReturnOrder("r12345")).toBe(true);
  });

  it("detects CR-prefixed order numbers", () => {
    expect(isReturnOrder("CR12345")).toBe(true);
    expect(isReturnOrder("CR-12345")).toBe(true);
    expect(isReturnOrder("cr12345")).toBe(true);
  });

  it("detects A-suffix store codes as returns", () => {
    expect(isReturnOrder("SBOA11221")).toBe(true);
    expect(isReturnOrder("GTOA10076")).toBe(true);
    expect(isReturnOrder("CHOA1234")).toBe(true);
    expect(isReturnOrder("BBOA10012")).toBe(true);
    expect(isReturnOrder("WSOA10001")).toBe(true);
  });

  it("does not flag M-suffix store codes (regular sales)", () => {
    expect(isReturnOrder("SBOM38510")).toBe(false);
    expect(isReturnOrder("GTOM3614")).toBe(false);
    expect(isReturnOrder("CHOM1599")).toBe(false);
  });

  it("does not flag split shipment suffixes as returns", () => {
    expect(isReturnOrder("SBOM38549 - A")).toBe(false);
    expect(isReturnOrder("SBOM38351 - B")).toBe(false);
  });

  it("does not flag normal order numbers", () => {
    expect(isReturnOrder("12345")).toBe(false);
    expect(isReturnOrder("SO-12345")).toBe(false);
    expect(isReturnOrder("ORDER12345")).toBe(false);
  });
});

// ─── isRewriteOrder / rewriteBaseOrderno ────────────────────────────

describe("isRewriteOrder", () => {
  it("detects single-letter A-D suffixes", () => {
    expect(isRewriteOrder("SBOM38549 - A")).toBe(true);
    expect(isRewriteOrder("SBOM38549 - B")).toBe(true);
    expect(isRewriteOrder("SBOM38549 - C")).toBe(true);
    expect(isRewriteOrder("SBOM38549 - D")).toBe(true);
  });

  it("tolerates missing or extra whitespace around the dash", () => {
    expect(isRewriteOrder("SBOM38549- A")).toBe(true);
    expect(isRewriteOrder("SBOM38549 -A")).toBe(true);
    expect(isRewriteOrder("SBOM38549-A")).toBe(true);
    expect(isRewriteOrder("SBOM38549   -   A")).toBe(true);
  });

  it("rejects base orders without a suffix", () => {
    expect(isRewriteOrder("SBOM38549")).toBe(false);
    expect(isRewriteOrder("GTOM1234")).toBe(false);
  });

  it("rejects non-rewrite suffixes", () => {
    expect(isRewriteOrder("SBOM38549 - E")).toBe(false);
    expect(isRewriteOrder("SBOM38549 - AA")).toBe(false);
    expect(isRewriteOrder("SBOM38549 - 1")).toBe(false);
  });

  it("rejects A-suffix store codes (returns, not rewrites)", () => {
    expect(isRewriteOrder("SBOA12345")).toBe(false);
    expect(isRewriteOrder("GTOA12345")).toBe(false);
  });
});

describe("rewriteBaseOrderno", () => {
  it("extracts the base orderno from a rewrite", () => {
    expect(rewriteBaseOrderno("SBOM38549 - A")).toBe("SBOM38549");
    expect(rewriteBaseOrderno("SBOM38549 - B")).toBe("SBOM38549");
    expect(rewriteBaseOrderno("GTOM1234 - C")).toBe("GTOM1234");
  });

  it("handles compact and spaced suffix variants", () => {
    expect(rewriteBaseOrderno("SBOM38549-A")).toBe("SBOM38549");
    expect(rewriteBaseOrderno("SBOM38549 -A")).toBe("SBOM38549");
    expect(rewriteBaseOrderno("SBOM38549   -   A")).toBe("SBOM38549");
  });

  it("returns null for non-rewrite ordernos", () => {
    expect(rewriteBaseOrderno("SBOM38549")).toBeNull();
    expect(rewriteBaseOrderno("SBOA12345")).toBeNull();
    expect(rewriteBaseOrderno("")).toBeNull();
  });
});

// ─── deriveSalesOrderStatus ─────────────────────────────────────────

describe("deriveSalesOrderStatus", () => {
  it("returns RETURNED for R-prefixed order numbers", () => {
    expect(deriveSalesOrderStatus("R12345", [{ netprice: 100 }])).toBe("RETURNED");
  });

  it("returns RETURNED for CR-prefixed order numbers", () => {
    expect(deriveSalesOrderStatus("CR-999", [{ netprice: 50 }])).toBe("RETURNED");
  });

  it("returns RETURNED for negative net total", () => {
    const lines = [{ netprice: -200 }, { netprice: 50 }];
    expect(deriveSalesOrderStatus("12345", lines)).toBe("RETURNED");
  });

  it("returns RETURNED when status field is 'Return'", () => {
    expect(deriveSalesOrderStatus("12345", [{ netprice: 100 }], "Return")).toBe("RETURNED");
  });

  it("returns CANCELLED when status field is 'Cancelled'", () => {
    expect(deriveSalesOrderStatus("12345", [{ netprice: 100 }], "Cancelled")).toBe("CANCELLED");
  });

  it("returns ORDER for normal orders", () => {
    const lines = [{ netprice: 500 }, { netprice: 300 }];
    expect(deriveSalesOrderStatus("12345", lines)).toBe("ORDER");
  });

  it("returns ORDER for zero-total orders (not negative)", () => {
    const lines = [{ netprice: 0 }];
    expect(deriveSalesOrderStatus("12345", lines)).toBe("ORDER");
  });
});

// ─── classifyPOReceiptStatus ────────────────────────────────────────
//
// 0-qty PO lines are cancelled lines from the source system and must
// never block a PO from reaching RECEIVED_FULL. The caller is
// responsible for filtering to orderedQuantity > 0 before passing the
// counts in.

describe("classifyPOReceiptStatus", () => {
  it("returns null when there are no non-zero items (nothing to receive)", () => {
    expect(classifyPOReceiptStatus(0, 0)).toBeNull();
  });

  it("returns RECEIVED_FULL when every non-zero line has a receiving record", () => {
    expect(classifyPOReceiptStatus(3, 3)).toBe("RECEIVED_FULL");
  });

  it("returns RECEIVED_PARTIAL when some but not all non-zero lines are received", () => {
    expect(classifyPOReceiptStatus(3, 1)).toBe("RECEIVED_PARTIAL");
  });

  it("returns null when none of the non-zero lines are received yet", () => {
    expect(classifyPOReceiptStatus(3, 0)).toBeNull();
  });

  it("returns RECEIVED_FULL for a PO with one real received line + one 0-qty line", () => {
    // Caller pre-filters out the 0-qty line, so itemCount==1 and
    // receivedItemCount==1 — the 0-qty line must not block auto-close.
    expect(classifyPOReceiptStatus(1, 1)).toBe("RECEIVED_FULL");
  });

  it("treats more-received-than-ordered as RECEIVED_FULL (defensive, not a bug)", () => {
    // Shouldn't normally happen, but if receivingRecords somehow outpace
    // line count the PO should be considered fully received rather than
    // silently dropped.
    expect(classifyPOReceiptStatus(2, 3)).toBe("RECEIVED_FULL");
  });
});

// ─── findProduct auto-create — Prisma create-call shape tripwire ────

describe("findProduct autoCreate fallback", () => {
  // Product requires vendor + department + category as required
  // relations; Prisma 7 demands the relation form
  // ("vendor: { connect: { id } }") not the scalar form ("vendorId: 229")
  // when any required relation in the create input is absent. A
  // "simplify to scalars" refactor would fail here before reaching prod.
  let capturedCreateData: Record<string, unknown> | null = null;
  const fakePrisma = {
    product: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }) => {
        capturedCreateData = data;
        return { id: 9999 };
      }),
    },
    vendor: {
      findFirst: jest.fn().mockResolvedValue({ id: 1 }),
      create: jest.fn(),
    },
    department: {
      findFirst: jest.fn().mockResolvedValue({ id: 2 }),
      create: jest.fn(),
    },
    category: {
      findFirst: jest.fn().mockResolvedValue({ id: 3 }),
      create: jest.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  beforeEach(() => {
    // The Unknown Vendor / Uncategorized lookups are cached at module
    // level for the life of the process; clear so each test re-resolves
    // against the fake and the assertions are order-independent.
    clearAutoCreateCachesForTesting();
    capturedCreateData = null;
    fakePrisma.product.findUnique.mockClear();
    fakePrisma.product.findFirst.mockClear();
    fakePrisma.product.create.mockClear();
    fakePrisma.vendor.findFirst.mockClear();
    fakePrisma.department.findFirst.mockClear();
    fakePrisma.category.findFirst.mockClear();
  });

  it("uses the relation form for vendor / department / category when auto-creating", async () => {
    const result = await findProduct(fakePrisma, {
      partNo: "FAE-MARY-XS-Linen Blue",
      productName: "FAE-MARY-XS-Linen Blue",
      unitCost: 143,
      vendorId: 229,
      autoCreate: true,
      createdBy: "test",
    });

    expect(result).toEqual({ id: 9999 });
    expect(fakePrisma.product.create).toHaveBeenCalledTimes(1);
    expect(capturedCreateData).toBeTruthy();

    // Required relations MUST be in connect form so Prisma 7 doesn't
    // reject "Argument vendor is missing" when departmentId/categoryId
    // are absent from input.
    expect(capturedCreateData!.vendor).toEqual({ connect: { id: 229 } });
    expect(capturedCreateData!.department).toEqual({ connect: { id: 2 } });
    expect(capturedCreateData!.category).toEqual({ connect: { id: 3 } });

    // And NEVER bare scalar foreign keys, which mix forms and confuse
    // Prisma 7 input matcher.
    expect(capturedCreateData!.vendorId).toBeUndefined();
    expect(capturedCreateData!.departmentId).toBeUndefined();
    expect(capturedCreateData!.categoryId).toBeUndefined();
  });

  it("falls back to Unknown Vendor when no vendorId is passed (POR / temp-items path)", async () => {
    await findProduct(fakePrisma, {
      partNo: "BTLA-C3171-38-High Tide",
      autoCreate: true,
      createdBy: "test",
    });

    // findFirst on Vendor was called because no vendorId was supplied
    // (ensureUnknownVendorId resolves the shared fallback row)
    expect(fakePrisma.vendor.findFirst).toHaveBeenCalled();
    expect(capturedCreateData!.vendor).toEqual({ connect: { id: 1 } });
  });
});
