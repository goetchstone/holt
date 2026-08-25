// /app/src/components/dnd/DroppableColumn.tsx
import type { ReactNode } from "react";
import { Children } from "react";
import { useDroppable } from "@dnd-kit/core";

interface DroppableColumnProps {
  id: string;
  children: ReactNode;
  label?: string;
  className?: string;
  emptyMessage?: string;
}

export function DroppableColumn({
  id,
  children,
  label,
  className,
  emptyMessage = "Drop items here",
}: DroppableColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id });
  const hasChildren = Children.count(children) > 0;

  const borderStyle = isOver
    ? "border-brand-gold bg-brand-gold/5"
    : "border-dashed border-brand-gray/30";

  return (
    <div className={className}>
      {label && (
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-brand-gray">
          {label}
        </h3>
      )}
      <div
        ref={setNodeRef}
        className={`min-h-[100px] rounded-lg border-2 p-3 transition-colors ${borderStyle}`}
      >
        {hasChildren ? (
          children
        ) : (
          <p className="flex min-h-[100px] items-center justify-center text-sm text-brand-gray/60">
            {emptyMessage}
          </p>
        )}
      </div>
    </div>
  );
}
