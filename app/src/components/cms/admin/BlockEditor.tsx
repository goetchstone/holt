// /app/src/components/cms/admin/BlockEditor.tsx
//
// Block-based content editor used by the page and post editors. Reorder via
// drag (dnd-kit), add typed blocks, edit per-block fields, remove. Operates on
// a ContentBlock[] value and reports changes through onChange -- it owns no
// persistence.

"use client";

import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2, Plus } from "lucide-react";
import {
  BLOCK_TYPES,
  BLOCK_LABELS,
  createBlock,
  type BlockType,
  type ContentBlock,
} from "@/lib/cms/blocks";
import { BlockFields } from "./BlockFields";

interface BlockEditorProps {
  blocks: ContentBlock[];
  onChange: (blocks: ContentBlock[]) => void;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `b-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function SortableBlock({
  block,
  onPatch,
  onRemove,
}: {
  block: ContentBlock;
  onPatch: (patch: Partial<ContentBlock>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-md border border-black/10 bg-white p-4 shadow-sm"
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="cursor-grab touch-none text-sh-gray hover:text-sh-navy"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={18} />
          </button>
          <span className="text-sm font-medium text-sh-navy">{BLOCK_LABELS[block.type]}</span>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-sh-gray hover:text-red-600"
          aria-label="Remove block"
        >
          <Trash2 size={16} />
        </button>
      </div>
      <BlockFields block={block} onPatch={onPatch} />
    </div>
  );
}

export function BlockEditor({ blocks, onChange }: BlockEditorProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = blocks.findIndex((b) => b.id === active.id);
    const newIndex = blocks.findIndex((b) => b.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onChange(arrayMove(blocks, oldIndex, newIndex));
  }

  function addBlock(type: BlockType) {
    onChange([...blocks, createBlock(type, newId())]);
  }

  function patchBlock(id: string, patch: Partial<ContentBlock>) {
    onChange(blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as ContentBlock) : b)));
  }

  function removeBlock(id: string) {
    onChange(blocks.filter((b) => b.id !== id));
  }

  return (
    <div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-4">
            {blocks.map((block) => (
              <SortableBlock
                key={block.id}
                block={block}
                onPatch={(patch) => patchBlock(block.id, patch)}
                onRemove={() => removeBlock(block.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {blocks.length === 0 ? (
        <p className="py-6 text-center text-sm text-sh-gray">
          No blocks yet. Add one below to start building this {""}page.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {BLOCK_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => addBlock(type)}
            className="inline-flex items-center gap-1 rounded-md border border-sh-navy/30 px-3 py-1.5 text-sm text-sh-navy transition hover:bg-sh-linen"
          >
            <Plus size={14} /> {BLOCK_LABELS[type]}
          </button>
        ))}
      </div>
    </div>
  );
}
