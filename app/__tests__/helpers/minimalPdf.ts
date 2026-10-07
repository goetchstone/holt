// /app/__tests__/helpers/minimalPdf.ts
//
// A real PDF, written by hand, with text at exact coordinates -- for tests of
// readers that care WHERE words sit (readPdfTextItems, positioned layout
// readers). No generator library sits between the test and pdf.js, and no
// binary fixture is committed. Callers use invented words only.

export interface Run {
  /** PDF user-space x of the run's origin, in points. */
  x: number;
  /** Baseline y in points, measured UP from the page bottom. */
  y: number;
  s: string;
  /** Helvetica size in points; 12 when omitted. */
  size?: number;
}

/** One Helvetica run per `Run`, one page per array, US-letter pages. */
export function minimalPdf(pages: Run[][]): Buffer {
  const pageObj = (i: number) => 4 + i * 2;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((runs, i) => {
    const stream = runs
      .map((r) => `BT /F1 ${r.size ?? 12} Tf ${r.x} ${r.y} Td (${r.s}) Tj ET`)
      .join("\n");
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });

  let out = "%PDF-1.4\n";
  const offsets = objs.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
