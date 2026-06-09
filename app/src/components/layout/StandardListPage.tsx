// /app/src/components/layout/StandardListPage.tsx

import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import MainLayout from "@/components/layout/MainLayout";
import TableWithFilters from "@/components/table/TableWithFilters";
import { Column } from "@/components/table/PaginatedTable";
import { getErrorMessage } from "@/lib/toastError";

type Props<T> = {
  title: string;
  columns: Column[];
  fetchData: (page: number, search: string) => Promise<{ data: T[]; total: number }>;
  storageKey: string;
  onRowClick?: (row: T) => void;
  getRowHref?: (row: T) => string;
  modalComponent?: React.ReactNode;
  headerActionComponent?: React.ReactNode;
  refreshTrigger?: number;
};

export default function StandardListPage<T>({
  title,
  columns,
  fetchData,
  storageKey,
  onRowClick,
  getRowHref,
  modalComponent,
  headerActionComponent,
  refreshTrigger,
}: Props<T>) {
  const [data, setData] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadData();
  }, [page, search, refreshTrigger]);

  async function loadData() {
    setLoading(true);
    try {
      const res = await fetchData(page, search);
      setData(res.data);
      setTotal(res.total);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load data."));
    } finally {
      setLoading(false);
    }
  }

  const handleSearchChange = (newSearchTerm: string) => {
    setPage(1);
    setSearch(newSearchTerm);
  };

  return (
    <MainLayout title={title}>
      <div className="py-2 font-serif text-sh-black">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-semibold text-sh-blue">{title}</h1>
          {headerActionComponent}
        </div>

        <TableWithFilters
          data={data}
          columns={columns}
          searchFields={[]}
          storageKey={storageKey}
          total={total}
          page={page}
          onPageChange={setPage}
          loading={loading}
          onRowClick={onRowClick}
          getRowHref={getRowHref}
          onSearchChange={handleSearchChange}
        />
      </div>
      {modalComponent}
    </MainLayout>
  );
}
