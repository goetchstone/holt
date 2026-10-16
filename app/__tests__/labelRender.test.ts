// /app/__tests__/labelRender.test.ts
//
// Label templates (lib/labels/renderTemplate.ts): Mustache as templates are
// written, but a label is ZPL, not HTML.

import { LABEL_FIELDS, renderTemplate } from "@/lib/labels/renderTemplate";

describe("renderTemplate", () => {
  it("fills fields and leaves unknown ones empty", () => {
    expect(renderTemplate("^FD{{locationCode}}|{{nope}}^FS", { locationCode: "BAY-1" })).toBe(
      "^FDBAY-1|^FS",
    );
  });

  it("prints & as &, not as HTML would escape it", () => {
    expect(renderTemplate("^FD{{name}}^FS", { name: "Rugs & Runners <wool>" })).toBe(
      "^FDRugs & Runners <wool>^FS",
    );
  });

  it("never lets a value run as a ZPL command", () => {
    expect(renderTemplate("^FD{{name}}^FS", { name: "50^ off ~JA" })).toBe("^FD50  off  JA^FS");
  });

  it("lists the fields each kind of label can use, place and box labels with a scannable barcode", () => {
    expect(LABEL_FIELDS.LOCATION).toContain("barcode");
    expect(LABEL_FIELDS.BOX).toEqual(expect.arrayContaining(["box", "of", "barcode"]));
  });
});
