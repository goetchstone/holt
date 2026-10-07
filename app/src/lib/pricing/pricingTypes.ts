// /app/src/lib/pricing/pricingTypes.ts
//
// Shared types for structured parse results. No server-only dependencies
// so this can be imported from both server and client code.

export interface ParseDiagnostic {
  level: "warning" | "error";
  row?: number;
  field?: string;
  message: string;
}

export interface ParseSummary {
  totalRowsProcessed: number;
  successCount: number;
  skippedCount: number;
  warningCount: number;
  errorCount: number;
}

export interface ParseResult<T> {
  data: T[];
  diagnostics: ParseDiagnostic[];
  summary: ParseSummary;
}

export function createEmptyParseResult<T>(): ParseResult<T> {
  return {
    data: [],
    diagnostics: [],
    summary: {
      totalRowsProcessed: 0,
      successCount: 0,
      skippedCount: 0,
      warningCount: 0,
      errorCount: 0,
    },
  };
}
