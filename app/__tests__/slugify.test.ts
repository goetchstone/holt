// /app/__tests__/slugify.test.ts
//
// lib/slugify.ts is the one slug maker for services and CMS pages and posts.
// It replaced three copies of a replace-then-trim version whose trailing-dash
// pattern CodeQL flagged as polynomial (alert 68). These pin that the rewrite
// changed no slug, and that a long run of dashes or separators stays cheap.

import fc from "fast-check";
import { slugify } from "@/lib/slugify";
import { bookingUid } from "@/lib/booking/event";

// The version every caller used before, kept here as the oracle.
function previousSlugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

describe("slugify", () => {
  it("joins the lowercase words with single dashes", () => {
    expect(slugify("Design Consultation")).toBe("design-consultation");
    expect(slugify("  A/B  Test! ")).toBe("a-b-test");
    expect(slugify("Spring 2027 Sale -- 20% off")).toBe("spring-2027-sale-20-off");
  });

  it("is empty when there is nothing to keep, so callers' fallbacks apply", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify("---")).toBe("");
    expect(slugify("¿¡!?")).toBe("");
  });

  it("drops letters outside a-z rather than guessing a transliteration", () => {
    expect(slugify("Café Crème")).toBe("caf-cr-me");
  });

  it("gives the same slug as the version it replaced, for any input", () => {
    const separators = fc.constantFrom("-", " ", "--", "_", "/", "\t", "é", "!", "İ", " ");
    const word = fc.stringMatching(/^[A-Za-z0-9]{1,6}$/);
    const name = fc
      .array(fc.oneof(word, separators), { maxLength: 20 })
      .map((parts) => parts.join(""));
    fc.assert(
      fc.property(fc.oneof(name, fc.string(), fc.string({ unit: "binary" })), (input) => {
        expect(slugify(input)).toBe(previousSlugify(input));
      }),
      { numRuns: 2000 },
    );
  });

  it("only ever returns dash-joined lowercase words", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (input) => {
        expect(slugify(input)).toMatch(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/);
      }),
      { numRuns: 1000 },
    );
  });

  it("stays linear on long runs of dashes and separators", () => {
    const dashes = "-".repeat(200_000);
    const started = performance.now();
    expect(slugify(`a${dashes}b${dashes}`)).toBe("a-b");
    expect(slugify(" !".repeat(100_000))).toBe("");
    // A long run of one separator between words: a regex trim such as
    // /\s+$/ is quadratic here even where it is cheap at the end of a string.
    expect(slugify(`a${" ".repeat(200_000)}b`)).toBe("a-b");
    // A quadratic pattern takes seconds here; a linear pass takes milliseconds.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

// The other place that made a slug the same replace-then-trim way, with the
// /^-+|-+$/ pattern alert 68 flagged.
describe("bookingUid", () => {
  function previousUid(id: number, organizerName: string): string {
    const domain = organizerName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `booking-${id}@${domain || "holt"}`;
  }

  it("is unchanged now that it slugs the organizer with slugify", () => {
    expect(bookingUid(7, "Holt Home & Rug")).toBe("booking-7@holt-home-rug");
    expect(bookingUid(7, "!!!")).toBe("booking-7@holt");
    fc.assert(
      fc.property(fc.nat(), fc.string({ unit: "binary" }), (id, name) => {
        expect(bookingUid(id, name)).toBe(previousUid(id, name));
      }),
      { numRuns: 2000 },
    );
  });
});
