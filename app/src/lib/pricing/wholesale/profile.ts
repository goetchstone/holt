// /app/src/lib/pricing/wholesale/profile.ts
//
// What a wholesale price book needs to declare about itself.
//
// A manufacturer prints one book layout and puts several brands on it — Hooker
// Furnishings prints Hooker, Sam Moore and Bradington-Young on the same
// column-transposed grid. So the reusable unit is the LAYOUT, and a vendor is a
// set of parameters against it. Before this seam existed there were three
// near-identical extractor modules, each with its own copy of the money parser,
// the dimension parser and the grid walk.
//
// A profile is CODE, not config: it lives in `vendors/`, it is compiled, and it
// goes through review. That is deliberate. The alternative — a YAML schema
// expressive enough to describe a PDF layout — is a programming language with a
// worse type checker, and CLAUDE.md rule 62 exists because that road ends at an
// RCE surface wearing a config file's clothes. What a DEPLOYMENT configures is
// which vendors it carries and what markup it applies; what a VENDOR fixes is
// its grade ladder and its label spellings, and those are the same for every
// dealer who opens the same book.

/**
 * One rung of a vendor's price ladder.
 *
 * `kind` is DECLARED, never inferred. The import engine used to guess it from
 * the shape of the code — a single letter meant leather, digits meant fabric —
 * and then patch the guess with per-vendor allowlists when a vendor disagreed.
 * Sam Moore and Hooker both ladder fabric as B..J, so under that guess their
 * entire fabric range filed as leather. A vendor that states its own grades
 * cannot be misread, and there is nothing left to patch.
 */
export interface GradeSpec {
  /** Code as stored and displayed: "B", "L1", "NVPR", "Prem 1". */
  readonly code: string;
  readonly kind: "fabric" | "leather";
  /** Display name, when the code alone reads badly ("NVPR"). */
  readonly displayName?: string;
}

/** Maps a labelled row to the field it fills. */
export interface RowSpec {
  /** Field on the parsed product. */
  readonly key: string;
  /** Matched against the row's label cell. */
  readonly match: RegExp;
  /**
   * Values start after a SECOND tab rather than the first. Some books nest a
   * label inside a labelled row, e.g.
   * `COM\t54" PLAIN COM FABRIC Required (Yds.):\t7\t...`.
   */
  readonly deep?: boolean;
}

export interface WholesaleVendorProfile {
  /** Stable key. Also the value the upload UI posts as `vendor`. */
  readonly id: string;
  /** Vendor's own name, for humans. */
  readonly label: string;
  /** Ordered ladder, in book order. Order is meaningful: it is tier order. */
  readonly grades: readonly GradeSpec[];
  /** Starts a new style grid. Every line matching it begins a chunk. */
  readonly gridHeader: RegExp;
  /** Grade code this row prices, or null when the row is not a price row. */
  gradeOfRow(label: string): string | null;
  /** Non-price rows worth keeping. */
  readonly rows: readonly RowSpec[];
  /** Cell values meaning "no price at this grade": "--", "N/A". */
  readonly emptyCells: readonly string[];
  /**
   * Grade whose price is also emitted as COM (Customer's Own Material). On the
   * books that have it the row reads "Grade: E and COM", so E and COM are one
   * price, not two.
   */
  readonly comGrade?: string;
  /**
   * Every pattern must appear on a page for it to be treated as a price grid.
   * Books that mix schematic and price pages need this; others leave it unset
   * and every page with a grid header is tried.
   */
  readonly pageRequires?: readonly RegExp[];
  /**
   * Where this vendor's leather prices live.
   *
   * `combined`   — leather is a higher tier of the SAME frame, so both ladders
   *                land on one style.
   * `separate`   — leather is its own style, keyed off the base style number.
   * `none`       — no leather ladder, or no fabric ladder to be separate from.
   *
   * Declared, because it used to be a one-vendor allowlist in the import route.
   */
  readonly leatherPlacement: "combined" | "separate" | "none";
  /**
   * Expand one price column into the SKUs it covers. Default is one SKU per
   * column. Bradington-Young overrides it: a column headed "770/771/772/773/774"
   * with a per-column suffix row "-87" covers five real SKUs that share a frame
   * and a price.
   */
  expandSkus?(itemCell: string, gridLines: readonly string[], column: number): string[];
}
