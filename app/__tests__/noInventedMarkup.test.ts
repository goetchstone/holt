// /app/__tests__/noInventedMarkup.test.ts
//
// USE-04b: no price is made up from cost. The POS and New Quote priced a
// product with no retail price at two and a half times its cost, one
// business's markup, and sent that price on to the order. USE-04 had already
// made the server fail closed on an unset vendor markup; these two screens
// were the path its acceptance grep did not cover. A guard on one path is no
// guard (principle 3), so this looks at all of src, not just the two screens.
//
// A ratchet: a cost multiplied by a constant above 1 (in either order,
// comments included) may appear only in the files below, each with the reason
// it is not an invented sale price. `* 100` is excluded: that is cents or a
// percentage, never a markup.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const APP = join(__dirname, "..");
// `baseCost * 2.5`, `Number(p.baseCost) * 2.5`, `2.5 * costPrice`.
const COST_TIMES_CONSTANT =
  String.raw`[A-Za-z_]*[cC]ost[A-Za-z_]*\)?[[:space:]]*\*[[:space:]]*[0-9]+(\.[0-9]+)?` +
  "|" +
  String.raw`[0-9]+(\.[0-9]+)?[[:space:]]*\*[[:space:]]*(Number\()?[A-Za-z_.]*[cC]ost`;

const ACCEPTED: Record<string, string> = {
  "src/lib/consignment.ts":
    "calculateRugPricing: a consignment vendor's tag price (cost × 7, retail half that). OPEN in docs/tenant-literal-sweep.md under schema.prisma:3923: the multipliers move to a per-vendor consignment pricing setting.",
  "src/app/(dashboard)/app/inventory/consignment/receive/ReceiveView.tsx":
    "Previews the same consignment tag price on the receive screen, a copy of calculateRugPricing; moves with it.",
  "src/lib/apparelOrderVendors.ts":
    "frankEileenRetail: an editable retail prefill in one vendor's apparel-order import preview, not a sale price. A vendor fact like the registry's prefixes, OPEN in docs/tenant-literal-sweep.md under apparelOrderVendors.ts:95.",
};

function filesWithCostTimesConstant(): string[] {
  let out: string;
  try {
    out = execFileSync("grep", ["-rnoE", COST_TIMES_CONSTANT, "src"], {
      cwd: APP,
      encoding: "utf8",
    });
  } catch (err) {
    // grep exits 1 when nothing matches; anything else is an error, not a pass.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  const files = new Set<string>();
  for (const hit of out.trim().split("\n").filter(Boolean)) {
    const [file, , match] = hit.split(":");
    const factor = Number(/[0-9]+(\.[0-9]+)?/.exec(match)?.[0]);
    if (factor > 1 && factor !== 100) files.add(file);
  }
  return [...files].sort();
}

describe("no price is made up from cost", () => {
  it("multiplies a cost by a constant only in the listed files", () => {
    expect(filesWithCostTimesConstant()).toEqual(Object.keys(ACCEPTED).sort());
  });

  // The ratchet sees a multiplier; it cannot see a screen that goes back to
  // reading baseRetail itself and adding the line at 0. Each screen prices the
  // line and labels its search results through the one helper.
  it("prices POS and New Quote lines through catalogRetailPrice", () => {
    const views = [
      "src/app/(dashboard)/app/sales/pos/PosView.tsx",
      "src/app/(dashboard)/app/sales/quotes/new/NewQuoteView.tsx",
    ];
    const callsIn = (view: string): number => {
      try {
        return Number(
          execFileSync("grep", ["-c", "catalogRetailPrice(", view], { cwd: APP, encoding: "utf8" }),
        );
      } catch (err) {
        if ((err as { status?: number }).status === 1) return 0;
        throw err;
      }
    };
    expect(views.filter((view) => callsIn(view) < 2)).toEqual([]);
  });
});
