// /app/src/components/table/TableWithFilters.tsx

import { useEffect, useState } from "react";
import PaginatedTable from "./PaginatedTable";
import { Column } from "./PaginatedTable";

type TableWithFiltersProps<T> = {
  data: T[];
  columns: Column[];
  searchFields: (keyof T)[];
  storageKey: string;
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  onRowClick?: (row: T) => void;
  getRowHref?: (row: T) => string;
  onSearchChange: (term: string) => void;
};

export default function TableWithFilters<T>({
  data,
  columns,
  searchFields,
  storageKey,
  total,
  page,
  onPageChange,
  loading,
  onRowClick,
  getRowHref,
  onSearchChange,
}: TableWithFiltersProps<T>) {
  const [search, setSearch] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) setSearch(saved);
  }, [storageKey]);

  const handleInternalSearchChange = (newSearchTerm: string) => {
    setSearch(newSearchTerm);
    localStorage.setItem(storageKey, newSearchTerm);
    onSearchChange(newSearchTerm);
  };

  const rowsPerPage = 10;

  return (
    <div className="font-serif text-sm">
      <div className="sticky top-0 bg-white z-10 pb-4">
        <input
          value={search}
          onChange={(e) => handleInternalSearchChange(e.target.value)}
          placeholder="Search..."
          className="border border-sh-gray rounded-lg px-3 py-2 w-full mb-2"
        />
      </div>
      <PaginatedTable
        data={data}
        columns={columns}
        totalCount={total}
        currentPage={page}
        onPageChange={onPageChange}
        loading={loading}
        onRowClick={onRowClick}
        rowsPerPage={rowsPerPage}
      />
    </div>
  );
}
