// /app/__tests__/tagsOwedNotice.test.ts
//
// The tags a receipt left to print stay on the Receive PO screen until the
// receiver dismisses them. They were a toast, which closed after three seconds
// alongside the receipt's own toasts, and nothing else kept which products were
// short or by how many: the receipt row records the tags as printed before they
// print, the PO is fetched again, and a fully received line leaves the list.
//
// The screen holds the notes in its state (withTagsOwed) and shows them in
// TagsOwedNotice. A browser is needed to click Dismiss; here the state rule and
// what the notice renders are checked, as clientActionChip.test.ts does.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TagsOwedNotice,
  withTagsOwed,
} from "@/app/(dashboard)/app/purchasing/orders/[id]/receive/TagsOwedNotice";

const SOFA = "Sofa: 10 tags printed, 4 still to print. A print takes at most 10 of one tag.";
const CHAIR = "Chair: 10 tags printed, 20 still to print. A print takes at most 10 of one tag.";

describe("withTagsOwed", () => {
  it("keeps what a receipt left to print, after the receipts that follow it", () => {
    const afterFirst = withTagsOwed([], SOFA);
    expect(afterFirst).toEqual([SOFA]);
    // A later receipt that owes nothing leaves the earlier note where it is.
    expect(withTagsOwed(afterFirst, null)).toEqual([SOFA]);
    expect(withTagsOwed(afterFirst, CHAIR)).toEqual([SOFA, CHAIR]);
  });
});

describe("TagsOwedNotice", () => {
  const render = (notes: string[]) =>
    renderToStaticMarkup(createElement(TagsOwedNotice, { notes, onDismiss: () => undefined }));

  it("shows each note, and a Dismiss button for the receiver to close it", () => {
    const html = render([SOFA, CHAIR]);
    expect(html).toContain("Tags still to print");
    expect(html).toContain("Sofa: 10 tags printed, 4 still to print.");
    expect(html).toContain("Chair: 10 tags printed, 20 still to print.");
    expect(html).toMatch(/<button[^>]*>Dismiss<\/button>/);
  });

  it("shows nothing when nothing is owed", () => {
    expect(render([])).toBe("");
  });
});
