// /app/src/lib/vendors/vendorMergeShared.ts
//
// Client-safe shapes for vendor merging (GAP-22), shared by the vendor screen
// and the routes under /api/vendors/[id]/.

/** A name a vendor went by before another was merged into it. */
export interface VendorAliasRow {
  id: number;
  name: string;
  created: string | Date;
  createdBy: string | null;
}

/** What a merge would move and take, and why it can't happen yet. */
export interface VendorMergePreview {
  from: { id: number; name: string };
  into: { id: number; name: string };
  moves: { label: string; count: number }[];
  takes: string[];
  problems: string[];
}
