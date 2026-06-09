// /app/src/app/(dashboard)/app/admin/buyer-drafts/ItemCard.tsx
//
// Roomy item card + its draggable wrapper for the buyer-drafts workbench. The
// card body is the drag source (item-<id>); the Edit / Duplicate / Delete
// buttons keep their click handlers because useDraggable's listeners live on a
// wrapper div, and PointerSensor's distance:8 constraint lets short taps fall
// through to the buttons.

"use client";

import { Edit3, Copy, Trash2, Tag, Package } from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { resolveDraftDisplay } from "@/lib/buyerDraftDisplay";
import { STATUS_BADGE, type DraftItem } from "./types";

interface ItemCardProps {
  item: DraftItem;
  formatMoney: (value: number | null | undefined) => string;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

// Drop the trailing ".0…" zeros off a dimension so "24.0" renders as "24".
function formatDim(value: string | null): string | null {
  if (!value) return null;
  return Number(value).toString().replace(/\.0+$/, "");
}

function ItemCard({ item, formatMoney, onEdit, onDuplicate, onDelete }: Readonly<ItemCardProps>) {
  // Slice 6.1: when this draft is linked to a real Product (via Slice 5
  // auto-link or a manual override), fall back to the catalog's data for
  // fields the buyer left blank. The pure helper handles precedence; we
  // render with `display.X` and surface a "from catalog" hint on linked fields.
  const display = resolveDraftDisplay(
    {
      description: item.description,
      cost: item.cost,
      retail: item.retail,
      msrp: item.msrp,
      productWidth: item.productWidth,
      productLength: item.productLength,
      productHeight: item.productHeight,
    },
    item.fulfilledProduct ?? null,
  );

  const dims = [display.productWidth, display.productLength, display.productHeight]
    .map(formatDim)
    .filter(Boolean);

  const fromCatalog = (field: string) => display.source[field] === "linked";
  const descriptionTitle = fromCatalog("description")
    ? `From catalog: ${display.description}`
    : (display.description ?? undefined);

  return (
    <article className="bg-white border border-sh-stripe rounded-lg p-4 hover:border-sh-gold/40 transition-colors">
      <header className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-sh-gray uppercase tracking-wide">
            {item.vendor?.name ?? item.vendorName}
          </div>
          <h3 className="font-semibold text-sh-navy text-base truncate" title={item.productName}>
            {item.productName}
          </h3>
          <code className="text-xs text-sh-gray font-mono">{item.partNumber}</code>
        </div>
        <span
          className={`px-2 py-1 rounded text-xs font-mono whitespace-nowrap ${STATUS_BADGE[item.status]}`}
        >
          {item.status}
        </span>
      </header>

      {/* Linked-catalog badge (Slice 6.1) — shown when this draft is linked
          to a real Product. Click navigates to that Product's catalog page. */}
      {item.fulfilledProduct && (
        <a
          href={`/products/${item.fulfilledProduct.id}`}
          className="inline-flex items-center gap-1 text-xs text-sh-blue hover:underline mb-2"
          title="Open linked catalog Product"
        >
          🔗 Linked to catalog: {item.fulfilledProduct.productNumber}
        </a>
      )}

      {display.description && (
        <p
          className={`text-xs line-clamp-2 mb-3 ${
            fromCatalog("description") ? "text-sh-gray italic" : "text-sh-gray"
          }`}
          title={descriptionTitle}
        >
          {display.description}
        </p>
      )}

      <dl className="grid grid-cols-3 gap-2 text-xs mb-3">
        <div>
          <dt className="text-sh-gray">
            Cost {fromCatalog("cost") && <span title="from catalog">·</span>}
          </dt>
          <dd className="font-semibold text-sh-navy">{formatMoney(numOrNull(display.cost))}</dd>
        </div>
        <div>
          <dt className="text-sh-gray">
            MSRP {fromCatalog("msrp") && <span title="from catalog">·</span>}
          </dt>
          <dd className="font-semibold text-sh-navy">{formatMoney(numOrNull(display.msrp))}</dd>
        </div>
        <div>
          <dt className="text-sh-gray">
            Retail {fromCatalog("retail") && <span title="from catalog">·</span>}
          </dt>
          <dd className="font-semibold text-sh-navy">{formatMoney(numOrNull(display.retail))}</dd>
        </div>
      </dl>

      <div className="flex items-center gap-2 text-xs text-sh-gray mb-3 flex-wrap">
        <span className="inline-flex items-center gap-1">
          <Package className="h-3 w-3" /> Qty {item.qty}
        </span>
        {dims.length > 0 && <span>· {dims.join(" × ")} in</span>}
        {item.stockProgram && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-sh-gold/15 text-sh-gold rounded">
            <Tag className="h-3 w-3" /> Stocking program
            {item.stockFamily ? `: ${item.stockFamily}` : ""}
          </span>
        )}
        {item.draftPo && (
          <span className="px-2 py-0.5 bg-sh-blue/10 text-sh-blue rounded">
            PO {item.draftPo.referenceNumber ?? `#${item.draftPo.id}`}
          </span>
        )}
        {item.stockLocation && (
          <span className="px-2 py-0.5 bg-sh-stripe rounded text-sh-gray">
            → {item.stockLocation.code}
          </span>
        )}
      </div>

      <div className="flex justify-end gap-1 border-t border-sh-stripe pt-2">
        <Button
          variant="secondary"
          onClick={onEdit}
          aria-label={`Edit ${item.partNumber}`}
          className="min-h-[36px] py-1 px-2"
        >
          <Edit3 className="h-4 w-4" />
        </Button>
        <Button
          variant="secondary"
          onClick={onDuplicate}
          aria-label={`Duplicate ${item.partNumber}`}
          className="min-h-[36px] py-1 px-2"
        >
          <Copy className="h-4 w-4" />
        </Button>
        <Button
          variant="secondary"
          onClick={onDelete}
          aria-label={`Delete ${item.partNumber}`}
          className="min-h-[36px] py-1 px-2 text-red-600 hover:bg-red-50"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </article>
  );
}

// resolveDraftDisplay returns strings; the money formatter wants numbers.
// Empty / non-finite values render as the formatter's "no value" dash.
function numOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function DraggableItemCard(props: Readonly<ItemCardProps>) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `item-${props.item.id}`,
  });
  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : undefined,
    touchAction: "manipulation" as const,
  };
  return (
    <div ref={setNodeRef} style={style} className="cursor-grab active:cursor-grabbing">
      {/* Listeners on a wrapper around ItemCard so the action buttons inside
          the card still receive their click events without competing with the
          drag activation. */}
      <div {...listeners} {...attributes}>
        <ItemCard {...props} />
      </div>
    </div>
  );
}
