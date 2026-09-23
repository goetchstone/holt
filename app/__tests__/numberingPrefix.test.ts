// /app/__tests__/numberingPrefix.test.ts
//
// USE-12: the prefix on a business's order numbers and barcodes is its own --
// set in Settings, else its initials -- and never one pilot's, which every
// order and generated barcode carried before.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { derivePrefix, effectivePrefix, parsePrefix, PREFIX_PATTERN } from "@/lib/numberingPrefix";

const settings = (over: Partial<Parameters<typeof effectivePrefix>[0]> = {}) => ({
  appName: "Holt",
  companyName: null,
  orderNumberPrefix: null,
  barcodePrefix: null,
  ...over,
});

describe("derivePrefix", () => {
  it("takes the initials of the business's name, at most four", () => {
    expect(derivePrefix("Harbor Rugs")).toBe("HR");
    expect(derivePrefix("north & south home co.")).toBe("NSHC");
    expect(derivePrefix("A Very Long Business Name Inc")).toBe("AVLB");
    expect(derivePrefix("Holt")).toBe("H");
  });

  it("falls back to ORD for a name with no letters or digits", () => {
    expect(derivePrefix("")).toBe("ORD");
    expect(derivePrefix(" -- & -- ")).toBe("ORD");
  });

  it("always produces a prefix the pattern accepts", () => {
    for (const name of ["Harbor Rugs", "", "x", "1st Street Furniture", "A B C D E F G"]) {
      expect(derivePrefix(name)).toMatch(PREFIX_PATTERN);
    }
  });
});

describe("parsePrefix", () => {
  it("accepts 1-6 letters or digits, upper-cased and trimmed", () => {
    expect(parsePrefix("hr")).toBe("HR");
    expect(parsePrefix("  ab12  ")).toBe("AB12");
    expect(parsePrefix("ABCDEF")).toBe("ABCDEF");
  });

  it("refuses anything else", () => {
    for (const bad of ["", "   ", "ABCDEFG", "H-R", "H R", "HR-", "Ø", 12, null, undefined, {}]) {
      expect(parsePrefix(bad)).toBeNull();
    }
  });
});

describe("effectivePrefix", () => {
  it("uses the prefix set in Settings", () => {
    const s = settings({
      companyName: "Harbor Rugs",
      orderNumberPrefix: "XY",
      barcodePrefix: "BC",
    });
    expect(effectivePrefix(s, "orderNumberPrefix")).toBe("XY");
    expect(effectivePrefix(s, "barcodePrefix")).toBe("BC");
  });

  it("falls back to the company's initials, then the app name's", () => {
    expect(effectivePrefix(settings({ companyName: "Harbor Rugs" }), "orderNumberPrefix")).toBe(
      "HR",
    );
    expect(effectivePrefix(settings({ companyName: "   " }), "barcodePrefix")).toBe("H");
    expect(effectivePrefix(settings(), "orderNumberPrefix")).toBe("H");
  });
});

// Strict on purpose: zero hits anywhere under src, comments included. A
// comment-stripping scan has hidden real code before; there is no legitimate
// reason for this literal to reappear in the source.
describe("no source file stamps the pilot's prefix", () => {
  it("finds no SH- literal under src", () => {
    let hits: string[] = [];
    try {
      hits = execFileSync("grep", ["-rnE", "\\bSH-", "src"], {
        cwd: join(__dirname, ".."),
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch (err) {
      // grep exits 1 on no match -- the passing case. Anything else (a bad
      // pattern, a missing directory) is an error, not a pass.
      if ((err as { status?: number }).status !== 1) throw err;
    }
    expect(hits).toEqual([]);
  });
});
