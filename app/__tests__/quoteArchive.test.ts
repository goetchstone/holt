// /app/__tests__/quoteArchive.test.ts

import {
  ARCHIVE_REASONS,
  REPLACEMENT_REASONS,
  isValidArchiveReason,
  validateArchiveReplacementRequirement,
} from "@/lib/quoteArchive";

describe("quoteArchive — shared constants", () => {
  it("exposes a non-empty list of reasons", () => {
    expect(ARCHIVE_REASONS.length).toBeGreaterThan(0);
  });

  it("has no duplicate reasons", () => {
    const set = new Set<string>(ARCHIVE_REASONS);
    expect(set.size).toBe(ARCHIVE_REASONS.length);
  });

  it("includes the full set the pipeline UI chip group expects", () => {
    // These three were the ones missing on the server side that caused
    // GitHub #111 — freeze them into a test so the class can't regress.
    expect(ARCHIVE_REASONS).toContain("Budget constraint");
    expect(ARCHIVE_REASONS).toContain("No longer interested");
    expect(ARCHIVE_REASONS).toContain("Converted to order");
  });

  it("keeps the legacy reasons intact", () => {
    expect(ARCHIVE_REASONS).toContain("Updated Quote");
    expect(ARCHIVE_REASONS).toContain("Duplicate");
    expect(ARCHIVE_REASONS).toContain("Customer Passed");
    expect(ARCHIVE_REASONS).toContain("Stale");
    expect(ARCHIVE_REASONS).toContain("Lost to competitor");
    expect(ARCHIVE_REASONS).toContain("Customer unresponsive");
    expect(ARCHIVE_REASONS).toContain("Other");
  });

  describe("REPLACEMENT_REASONS", () => {
    it("only includes reasons that exist in ARCHIVE_REASONS", () => {
      for (const r of REPLACEMENT_REASONS) {
        expect(ARCHIVE_REASONS).toContain(r);
      }
    });

    it("includes the two canonical replacement triggers", () => {
      expect(REPLACEMENT_REASONS.has("Updated Quote")).toBe(true);
      expect(REPLACEMENT_REASONS.has("Duplicate")).toBe(true);
    });
  });

  describe("isValidArchiveReason", () => {
    it("accepts every ARCHIVE_REASONS entry", () => {
      for (const r of ARCHIVE_REASONS) {
        expect(isValidArchiveReason(r)).toBe(true);
      }
    });

    it("rejects unknown strings", () => {
      expect(isValidArchiveReason("Bogus")).toBe(false);
      expect(isValidArchiveReason("")).toBe(false);
    });

    it("rejects non-strings", () => {
      expect(isValidArchiveReason(undefined)).toBe(false);
      expect(isValidArchiveReason(null)).toBe(false);
      expect(isValidArchiveReason(123)).toBe(false);
      expect(isValidArchiveReason({})).toBe(false);
    });
  });

  // Issue #129: SO-38985 was archived as "Updated Quote" with a NULL
  // replacedByOrderId. That orphan-archive shape made the quote invisible
  // from any pipeline view with no link back to whatever quote replaced
  // it -- effectively a black-hole archive. The validator below makes
  // the API reject this combination at the boundary.
  describe("validateArchiveReplacementRequirement", () => {
    it("accepts when reason is not in REPLACEMENT_REASONS even with null replacement", () => {
      expect(validateArchiveReplacementRequirement("Customer Passed", null).ok).toBe(true);
      expect(validateArchiveReplacementRequirement("Stale", undefined).ok).toBe(true);
      expect(validateArchiveReplacementRequirement("Other", null).ok).toBe(true);
    });

    it("accepts when reason is undefined / not provided", () => {
      expect(validateArchiveReplacementRequirement(undefined, null).ok).toBe(true);
      expect(validateArchiveReplacementRequirement(null, null).ok).toBe(true);
      expect(validateArchiveReplacementRequirement("", null).ok).toBe(true);
    });

    it("accepts when reason is unknown (handled by isValidArchiveReason elsewhere)", () => {
      expect(validateArchiveReplacementRequirement("Bogus reason", null).ok).toBe(true);
    });

    it("REJECTS Updated Quote with null replacedByOrderId", () => {
      const result = validateArchiveReplacementRequirement("Updated Quote", null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("replacedByOrderId is required");
        expect(result.error).toContain("Updated Quote");
      }
    });

    it("REJECTS Updated Quote with undefined replacedByOrderId", () => {
      const result = validateArchiveReplacementRequirement("Updated Quote", undefined);
      expect(result.ok).toBe(false);
    });

    it("REJECTS Duplicate with null replacedByOrderId", () => {
      const result = validateArchiveReplacementRequirement("Duplicate", null);
      expect(result.ok).toBe(false);
    });

    it("accepts Updated Quote when a replacement is linked", () => {
      expect(validateArchiveReplacementRequirement("Updated Quote", 12345).ok).toBe(true);
    });

    it("accepts Duplicate when a replacement is linked", () => {
      expect(validateArchiveReplacementRequirement("Duplicate", 67890).ok).toBe(true);
    });
  });
});
