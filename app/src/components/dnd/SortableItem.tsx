// /app/src/components/dnd/SortableItem.tsx
import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

interface SortableItemProps {
  id: string | number;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  showHandle?: boolean;
}

export function SortableItem({
  id,
  children,
  className,
  disabled = false,
  showHandle = true,
}: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex min-h-[44px] items-center ${isDragging ? "opacity-50" : ""} ${className ?? ""}`}
      {...attributes}
    >
      {showHandle && (
        <button
          type="button"
          className="flex h-[44px] w-[44px] shrink-0 cursor-grab items-center justify-center text-sh-gray/60 hover:text-sh-gray active:cursor-grabbing"
          style={{ touchAction: "none" }}
          aria-label="Drag to reorder"
          {...listeners}
        >
          <GripVertical size={20} />
        </button>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
