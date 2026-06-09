"use client";

// /app/src/app/(dashboard)/app/inventory/product-variance/[externalId]/ProductVarianceView.tsx
//
// Product Variance Details body (per-location expected/counted/variance table
// for a single product), minus MainLayout chrome (supplied by the (dashboard)
// layout). The product id comes in as a prop from the server page;
// ?location= / ?returnUrl= come from useSearchParams. Reads the shared
// /api/inventory/product-variance/[externalId] REST endpoint.

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

interface ReportRow {
  location: string;
  expected: number;
  counted: number;
  variance: number;
}

interface ApiResponse {
  product: {
    name: string;
    productNumber: string;
  };
  report: ReportRow[];
}

function varianceClass(variance: number): string {
  if (variance < 0) return "text-red-600 font-bold";
  if (variance > 0) return "text-green-600 font-bold";
  return "";
}

// Back URL. returnUrl and location come from the querystring, so we have to
// validate them before letting them into a <Link href>. Both must be simple
// relative paths that start with "/" and have no protocol prefix; otherwise an
// attacker could craft e.g. ?returnUrl=javascript:alert(1) for a
// stored-XSS-on-click.
function safeInternal(raw: string | null, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback; // protocol-relative
  return raw;
}

function buildBackHref(returnUrl: string | null, location: string | null): string {
  const safeReturnUrl = returnUrl ? safeInternal(returnUrl, "") : "";
  const safeLocation = typeof location === "string" ? encodeURIComponent(location) : "";
  if (safeReturnUrl) return `${safeReturnUrl}?location=${safeLocation}`;
  if (safeLocation) return `/app/inventory/variance-report?location=${safeLocation}`;
  return "/app/inventory/hub";
}

export function ProductVarianceView({ externalId }: Readonly<{ externalId: string }>) {
  const searchParams = useSearchParams();
  const location = searchParams?.get("location") ?? null;
  const returnUrl = searchParams?.get("returnUrl") ?? null;

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchVariance = useCallback(async () => {
    if (!externalId) return;
    setLoading(true);
    try {
      const res = await axios.get(
        `/api/inventory/product-variance/${encodeURIComponent(externalId)}`,
      );
      setData(res.data);
    } catch {
      toast.error("Failed to load product variance details.");
    } finally {
      setLoading(false);
    }
  }, [externalId]);

  useEffect(() => {
    fetchVariance();
  }, [fetchVariance]);

  const backHref = buildBackHref(returnUrl, location);

  return (
    <div className="max-w-4xl mx-auto mt-8 font-serif">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">Product Variance Details</h1>
          {data && (
            <p className="text-sh-gray">
              {data.product.name} ({data.product.productNumber})
            </p>
          )}
        </div>
        <Link href={backHref} className="flex items-center gap-2 text-sh-blue hover:underline">
          <ArrowLeft className="w-4 h-4" />
          Back to Report
        </Link>
      </div>

      <ProductVarianceBody loading={loading} data={data} />
    </div>
  );
}

function ProductVarianceBody({
  loading,
  data,
}: Readonly<{ loading: boolean; data: ApiResponse | null }>) {
  if (loading) {
    return <p>Loading details...</p>;
  }
  if (!data) {
    return <p>No data found.</p>;
  }
  return (
    <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
      <table className="min-w-full text-left text-sm whitespace-nowrap table-fixed w-full">
        <thead className="bg-sh-linen text-sh-black">
          <tr>
            <th className="p-2">Location</th>
            <th className="p-2 text-center">Expected</th>
            <th className="p-2 text-center">Counted</th>
            <th className="p-2 text-center">Variance</th>
          </tr>
        </thead>
        <tbody>
          {data.report.map((row) => (
            <tr key={row.location} className="odd:bg-white even:bg-sh-stripe">
              <td className="p-2 font-semibold">{row.location}</td>
              <td className="p-2 text-center">{row.expected}</td>
              <td className="p-2 text-center">{row.counted}</td>
              <td className={`p-2 text-center ${varianceClass(row.variance)}`}>
                {row.variance > 0 ? `+${row.variance}` : row.variance}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
