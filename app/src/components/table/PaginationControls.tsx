// /app/src/components/table/PaginationControls.tsx

import React from "react";

interface PaginationControlsProps {
  totalCount: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  rowsPerPage?: number;
}

export default function PaginationControls({
  totalCount,
  currentPage,
  onPageChange,
  rowsPerPage = 10,
}: PaginationControlsProps) {
  const totalPages = Math.ceil(totalCount / rowsPerPage);

  const goTo = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      onPageChange(page);
    }
  };

  // Always show exactly MAX_VISIBLE page slots so the bar width never changes.
  const MAX_VISIBLE = 5;

  const pageButtons = () => {
    // Build a window of up to MAX_VISIBLE consecutive pages centred on currentPage.
    let start = Math.max(1, currentPage - Math.floor(MAX_VISIBLE / 2));
    let end = start + MAX_VISIBLE - 1;
    if (end > totalPages) {
      end = totalPages;
      start = Math.max(1, end - MAX_VISIBLE + 1);
    }

    const slots: React.ReactNode[] = [];
    for (let p = start; p <= end; p++) {
      slots.push(
        <button
          key={p}
          onClick={() => goTo(p)}
          className={`min-w-[40px] py-2 border rounded-lg transition text-center ${
            p === currentPage ? "bg-sh-blue text-white" : "border-sh-gray hover:bg-sh-blue/10"
          }`}
        >
          {p}
        </button>,
      );
    }
    // Pad with invisible placeholders so total slots always = MAX_VISIBLE
    while (slots.length < MAX_VISIBLE) {
      slots.push(
        <span
          key={`pad-${slots.length}`}
          className="min-w-[40px] py-2 inline-block"
          aria-hidden="true"
        />,
      );
    }
    return slots;
  };

  if (totalPages <= 1) {
    return null;
  }

  return (
    <div className="flex justify-center items-center gap-2 pt-2 font-serif text-sm">
      <button
        onClick={() => goTo(1)}
        disabled={currentPage === 1}
        className="w-16 py-2 text-xs border rounded-lg border-sh-gray disabled:opacity-50 hover:bg-sh-blue/10 transition text-center"
      >
        « First
      </button>
      <button
        onClick={() => goTo(currentPage - 1)}
        disabled={currentPage === 1}
        className="w-16 py-2 text-xs border rounded-lg border-sh-gray disabled:opacity-50 hover:bg-sh-blue/10 transition text-center"
      >
        ‹ Prev
      </button>
      {pageButtons()}
      <button
        onClick={() => goTo(currentPage + 1)}
        disabled={currentPage === totalPages}
        className="w-16 py-2 text-xs border rounded-lg border-sh-gray disabled:opacity-50 hover:bg-sh-blue/10 transition text-center"
      >
        Next ›
      </button>
      <button
        onClick={() => goTo(totalPages)}
        disabled={currentPage === totalPages}
        className="w-16 py-2 text-xs border rounded-lg border-sh-gray disabled:opacity-50 hover:bg-sh-blue/10 transition text-center"
      >
        Last »
      </button>
    </div>
  );
}
