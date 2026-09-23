// /app/src/types/vendor-modules.d.ts
//
// Type declarations for third-party modules that lack @types packages.

declare module "pdf-parse" {
  interface PDFInfo {
    PDFFormatVersion?: string;
    IsAcroFormPresent?: boolean;
    Title?: string;
    Author?: string;
    Creator?: string;
    Producer?: string;
    CreationDate?: string;
    ModDate?: string;
  }

  interface PDFData {
    numpages: number;
    numrender: number;
    info: PDFInfo;
    metadata: unknown;
    text: string;
    version: string;
  }

  // Uint8Array, not Buffer: the bundled pdf.js 1.10 was written for plain typed
  // arrays and can misread a Buffer -- call it through pdfUtils.parsePdf.
  function pdfParse(dataBuffer: Uint8Array, options?: Record<string, unknown>): Promise<PDFData>;
  export = pdfParse;
}

declare module "mustache" {
  const Mustache: {
    render(
      template: string,
      view: Record<string, unknown>,
      partials?: Record<string, string>,
    ): string;
    parse(template: string): void;
    escape(value: string): string;
  };
  export default Mustache;
}
