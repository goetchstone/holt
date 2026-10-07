// /app/src/components/dnd/SortableList.tsx
import type { ReactNode } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { SortingStrategy } from "@dnd-kit/sortable";

interface SortableListProps {
  items: (string | number)[];
  children: ReactNode;
  strategy?: SortingStrategy;
}

export function SortableList({
  items,
  children,
  strategy = verticalListSortingStrategy,
}: SortableListProps) {
  return (
    <SortableContext items={items} strategy={strategy}>
      {children}
    </SortableContext>
  );
}
