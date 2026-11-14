// /app/__tests__/searchAsYouTypeStatus.test.ts
//
// Create Variant's master-product picker said "No matching products." for the
// 300 ms debounce window after the first two letters, before any search had
// run, and on later keystrokes offered the previous query's results as
// clickable choices. A user told "no match" may create a duplicate master.
// The picker now goes by whether the held results answer what is typed.

import { searchAsYouTypeStatus } from "@/lib/searchAsYouTypeStatus";

describe("search-as-you-type status", () => {
  it("is idle until enough is typed", () => {
    expect(searchAsYouTypeStatus("", null, 2)).toBe("idle");
    expect(searchAsYouTypeStatus("s", "s", 2)).toBe("idle");
  });

  it("is searching in the debounce window before the first search", () => {
    // Typed "so"; the debounce has not fired, so nothing answers it yet.
    expect(searchAsYouTypeStatus("so", null, 2)).toBe("searching");
    // The debounce fired earlier for the one-letter text, which never searches.
    expect(searchAsYouTypeStatus("so", "s", 2)).toBe("searching");
  });

  it("is searching while the held results answer an older query", () => {
    expect(searchAsYouTypeStatus("sofa", "sof", 2)).toBe("searching");
  });

  it("is done only when the held results answer exactly what is typed", () => {
    expect(searchAsYouTypeStatus("sofa", "sofa", 2)).toBe("done");
  });
});
