// /app/src/app/(dashboard)/app/admin/buyer-drafts/DraftPosPanel.tsx
//
// Draft-PO sidebar panel for the buyer-drafts workbench. Each PO card is both a
// drop target (items drop onto it → sets item.draftPoId via po-<id>) and a drag
// source (the GripVertical handle drags the PO onto a Buy → sets po.buyId).
//
// Slice 6.9 (2026-05-14) — visibility follows the buy filter so the workspace
// stays clean after draft POs are pushed forward:
//   buyFilter = ALL          → show DRAFT-status POs only
//   buyFilter = <specific>   → show POs in that buy regardless of status
//   buyFilter = UNASSIGNED   → show unassigned + DRAFT-status only
// The PO status filter dropdown elsewhere still overrides.

"use client";

import { Pencil, GripVertical } from "lucide-react";
import { useDroppable, useDraggable } from "@dnd-kit/core";
import { formatShipMonthForDisplay } from "@/lib/buyPerformanceWindow";
import { STATUS_BADGE, type DraftBuy, type DraftPo, type IdOrAllOrUnassigned } from "./types";

interface DraftPosPanelProps {
  pos: readonly DraftPo[];
  buys: readonly DraftBuy[];
  buyFilter: IdOrAllOrUnassigned;
  poFilter: IdOrAllOrUnassigned;
  itemCountByPo: ReadonlyMap<number, number>;
  itemTotalCostByPo: ReadonlyMap<number, number>;
  onSelect: (id: number) => void;
  onEdit: (po: DraftPo) => void;
}

function filterPosForPanel(
  pos: readonly DraftPo[],
  buyFilter: IdOrAllOrUnassigned,
): readonly DraftPo[] {
  if (typeof buyFilter === "number") {
    return pos.filter((po) => po.buyId === buyFilter);
  }
  if (buyFilter === "UNASSIGNED") {
    return pos.filter((po) => po.buyId === null && po.status === "DRAFT");
  }
  // buyFilter === "ALL" → show DRAFT-status only for clean planning workspace
  return pos.filter((po) => po.status === "DRAFT");
}

export function DraftPosPanel({
  pos,
  buys,
  buyFilter,
  poFilter,
  itemCountByPo,
  itemTotalCostByPo,
  onSelect,
  onEdit,
}: Readonly<DraftPosPanelProps>) {
  const visible = filterPosForPanel(pos, buyFilter);
  const hiddenCount = pos.length - visible.length;

  return (
    <div className="bg-white border border-sh-stripe rounded-lg p-4">
      <h2 className="font-serif text-lg text-sh-navy mb-3">Draft POs</h2>
      {pos.length === 0 ? (
        <p className="text-sm text-sh-gray italic">
          No POs yet. Group items into a PO before exporting so the POS imports the right
          relationships.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            <li>
              <UnassignedDropZone />
            </li>
            {visible.map((po) => (
              <li key={po.id}>
                <DroppablePoCard
                  po={po}
                  selected={poFilter === po.id}
                  buyName={buyNameFor(po, buys)}
                  liveItemCount={itemCountByPo.get(po.id) ?? po._count?.items ?? 0}
                  liveTotalCost={itemTotalCostByPo.get(po.id) ?? 0}
                  onSelect={() => onSelect(po.id)}
                  onEdit={() => onEdit(po)}
                />
              </li>
            ))}
          </ul>
          {hiddenCount > 0 && (
            <p className="text-xs text-sh-gray mt-3 italic">
              {hiddenCount} PO{hiddenCount === 1 ? "" : "s"} hidden (out of DRAFT or attached to
              another buy). Use the Buy filter to see them.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function buyNameFor(po: DraftPo, buys: readonly DraftBuy[]): string | null {
  if (!po.buyId) return null;
  return buys.find((b) => b.id === po.buyId)?.name ?? `#${po.buyId}`;
}

interface DroppablePoCardProps {
  po: DraftPo;
  selected: boolean;
  buyName: string | null;
  /** Live item count derived from `items` state so drops reflect immediately.
   *  Falls back to the server's _count before items load (first render). */
  liveItemCount: number;
  /** Live total cost (cost × qty) for items in this PO. */
  liveTotalCost: number;
  onSelect: () => void;
  onEdit: () => void;
}

function cardStyleFor(isOver: boolean, selected: boolean): string {
  if (isOver) return "bg-sh-gold/30 border-2 border-sh-gold";
  if (selected) return "bg-sh-gold/20 border border-sh-gold";
  return "border border-sh-stripe hover:bg-sh-stripe/40";
}

function DroppablePoCard({
  po,
  selected,
  buyName,
  liveItemCount,
  liveTotalCost,
  onSelect,
  onEdit,
}: Readonly<DroppablePoCardProps>) {
  // Droppable: items dropped here set item.draftPoId.
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: `po-${po.id}` });
  // Draggable: the grip handle drags this card onto a Buy (sets po.buyId).
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: `po-${po.id}` });

  const baseStyle = "w-full text-left p-3 rounded text-sm transition-colors min-h-[44px]";
  // Display "March 2026" instead of the raw ISO string the API returns post
  // DateTime-promotion (2026-05-13).
  const eta = formatShipMonthForDisplay(po.expectedShipMonth);

  return (
    <div
      ref={setDropRef}
      className={`${baseStyle} ${cardStyleFor(isOver, selected)}`}
      style={{ opacity: isDragging ? 0.5 : undefined }}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onSelect}
          className="flex-1 text-left min-w-0"
          aria-label={`Filter to PO ${po.referenceNumber ?? po.id}`}
        >
          <div className="font-semibold text-sh-navy">{po.referenceNumber ?? "(no ref)"}</div>
          <div className="text-xs text-sh-gray mt-0.5">{po.vendor?.name ?? po.vendorName}</div>
          {eta && <div className="text-xs text-sh-blue mt-1 font-semibold">ETA: {eta}</div>}
          {buyName && <div className="text-xs text-sh-gray mt-0.5">Buy: {buyName}</div>}
          <div className="text-xs text-sh-gray flex justify-between mt-2">
            <span>
              {liveItemCount} items
              {liveTotalCost > 0 && (
                <span className="ml-2 text-sh-navy font-semibold">
                  $
                  {liveTotalCost.toLocaleString("en-US", {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </span>
              )}
            </span>
            <span className={`font-mono px-2 py-0.5 rounded text-xs ${STATUS_BADGE[po.status]}`}>
              {po.status}
            </span>
          </div>
        </button>
        <div className="flex flex-col items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit PO ${po.referenceNumber ?? po.id}`}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-sh-gray hover:text-sh-navy hover:bg-sh-stripe rounded"
          >
            <Pencil className="h-4 w-4" />
          </button>
          {/* Drag handle for moving the PO to a Buy. Separate from the rest of
              the card so plain clicks/taps don't trigger a drag. */}
          <button
            ref={setDragRef}
            type="button"
            aria-label={`Drag PO ${po.referenceNumber ?? po.id} to a buy`}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-sh-gray hover:text-sh-navy cursor-grab active:cursor-grabbing"
            style={{ touchAction: "none" }}
            {...listeners}
            {...attributes}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function UnassignedDropZone() {
  const { isOver, setNodeRef } = useDroppable({ id: "po-unassigned" });
  const style = isOver
    ? "border-2 border-dashed border-sh-gold bg-sh-gold/10"
    : "border-2 border-dashed border-sh-stripe";
  return (
    <div
      ref={setNodeRef}
      className={`p-3 rounded text-xs text-center text-sh-gray transition-colors ${style}`}
    >
      Drop here to unassign
    </div>
  );
}
