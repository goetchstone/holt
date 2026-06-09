"use client";

// /app/src/app/(dashboard)/app/sales/import-hd/ImportHdView.tsx
//
// Import Hunter Douglas proposal body. App Router port of the legacy
// sales/import-hd body (minus MainLayout chrome, which the (dashboard) layout
// supplies). Posts the PDF (base64) to the shared /api/sales/import-hd-proposal
// REST endpoint and shows the parsed proposal summary. HDProposal is imported as
// a type only so its server-only parser (pdf-parse) stays out of the client
// bundle.

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import type { HDProposal } from "@/lib/pricing/hdProposalParser";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface ImportResult {
  orderId: number;
  orderno: string;
  isUpdate: boolean;
  itemCount: number;
  proposal: HDProposal;
}

export function ImportHdView() {
  const router = useRouter();
  const formatCurrency = useMoneyFormatter();
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Please select a PDF file.");
      return;
    }

    setUploading(true);
    setResult(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ""),
      );

      const res = await fetch("/api/sales/import-hd-proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfBase64: base64 }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Import failed");
        return;
      }

      setResult(data);
      toast.success(
        data.isUpdate
          ? `Updated order ${data.orderno} with ${data.itemCount} items`
          : `Created order ${data.orderno} with ${data.itemCount} items`,
      );
    } catch {
      toast.error("Failed to upload PDF");
    } finally {
      setUploading(false);
    }
  }, []);

  const proposal = result?.proposal;

  return (
    <div className="py-2 space-y-6 font-serif">
      <h1 className="text-2xl text-sh-blue font-semibold">Import Hunter Douglas Proposal</h1>

      <div className="bg-white border border-sh-gray/20 rounded-lg p-5 text-sm text-sh-gray">
        <p className="font-semibold text-sh-black mb-2">Required Export Settings</p>
        <p>
          Export from Hunter Douglas Direct Connect as <strong>Client Proposal</strong> with the
          following options enabled:
        </p>
        <ul className="list-disc list-inside mt-2 space-y-1">
          <li>Detail with price affecting items</li>
          <li>Display MSRP = Yes</li>
          <li>Show per line freight = Yes</li>
          <li>Show per line installation = Yes</li>
          <li>Include client notes = Yes</li>
        </ul>
      </div>

      <div className="bg-white border border-sh-gray/20 rounded-lg p-5">
        <label
          htmlFor="hd-proposal-file"
          className="block text-sm font-semibold text-sh-black mb-2"
        >
          Upload Proposal PDF
        </label>
        <input
          id="hd-proposal-file"
          type="file"
          accept=".pdf"
          onChange={handleFileChange}
          disabled={uploading}
          className="block w-full text-sm text-sh-gray file:mr-4 file:py-2 file:px-4
            file:rounded file:border-0 file:text-sm file:font-semibold
            file:bg-sh-blue file:text-white hover:file:bg-sh-navy
            disabled:opacity-50"
        />
        {uploading && <p className="text-sh-gray text-sm mt-2">Parsing and importing...</p>}
      </div>

      {result && proposal && (
        <>
          {result.isUpdate && (
            <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 text-sm text-yellow-800">
              Existing order <strong>{result.orderno}</strong> was updated with the latest proposal
              data. Previous line items were replaced.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white border border-sh-gray/20 rounded-lg p-5">
              <h2 className="text-sm font-semibold text-sh-black mb-3">Quote Details</h2>
              <dl className="text-sm space-y-1">
                <div className="flex justify-between">
                  <dt className="text-sh-gray">Quote #</dt>
                  <dd className="text-sh-black">{proposal.quoteNumber}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sh-gray">Date</dt>
                  <dd className="text-sh-black">{proposal.quoteDate}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sh-gray">Valid Through</dt>
                  <dd className="text-sh-black">{proposal.validThrough || "N/A"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sh-gray">Salesperson</dt>
                  <dd className="text-sh-black">{proposal.salesperson || "N/A"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-sh-gray">Sidemark</dt>
                  <dd className="text-sh-black">{proposal.sidemark || "N/A"}</dd>
                </div>
              </dl>
            </div>

            <div className="bg-white border border-sh-gray/20 rounded-lg p-5">
              <h2 className="text-sm font-semibold text-sh-black mb-3">Customer</h2>
              <dl className="text-sm space-y-1">
                <div className="flex justify-between">
                  <dt className="text-sh-gray">Name</dt>
                  <dd className="text-sh-black">{proposal.customer.name}</dd>
                </div>
                {proposal.customer.street && (
                  <div className="flex justify-between">
                    <dt className="text-sh-gray">Address</dt>
                    <dd className="text-sh-black text-right">{proposal.customer.street}</dd>
                  </div>
                )}
                {proposal.customer.cityStateZip && (
                  <div className="flex justify-between">
                    <dt className="text-sh-gray" />
                    <dd className="text-sh-black text-right">{proposal.customer.cityStateZip}</dd>
                  </div>
                )}
              </dl>
            </div>
          </div>

          <div className="bg-white border border-sh-gray/20 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-sh-blue text-white text-left">
                  <th className="px-4 py-2">#</th>
                  <th className="px-4 py-2">Room</th>
                  <th className="px-4 py-2">Description</th>
                  <th className="px-4 py-2 text-right">Qty</th>
                  <th className="px-4 py-2 text-right">MSRP</th>
                </tr>
              </thead>
              <tbody>
                {proposal.items.map((item, idx) => (
                  <tr key={item.itemNumber} className={idx % 2 === 0 ? "bg-white" : "bg-sh-stripe"}>
                    <td className="px-4 py-2">{item.itemNumber}</td>
                    <td className="px-4 py-2">{item.room || "--"}</td>
                    <td className="px-4 py-2">{item.description}</td>
                    <td className="px-4 py-2 text-right">{item.qty}</td>
                    <td className="px-4 py-2 text-right">{formatCurrency(item.msrp)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-sh-gray/20 bg-sh-linen">
                  <td colSpan={3} />
                  <td className="px-4 py-2 text-right text-sh-gray">Freight</td>
                  <td className="px-4 py-2 text-right">{formatCurrency(proposal.totalFreight)}</td>
                </tr>
                <tr className="bg-sh-linen">
                  <td colSpan={3} />
                  <td className="px-4 py-2 text-right text-sh-gray">Installation</td>
                  <td className="px-4 py-2 text-right">{formatCurrency(proposal.totalInstall)}</td>
                </tr>
                <tr className="bg-sh-linen">
                  <td colSpan={3} />
                  <td className="px-4 py-2 text-right text-sh-gray">MSRP Total</td>
                  <td className="px-4 py-2 text-right">{formatCurrency(proposal.msrpTotal)}</td>
                </tr>
                {proposal.discountTotal !== 0 && (
                  <tr className="bg-sh-linen">
                    <td colSpan={3} />
                    <td className="px-4 py-2 text-right text-sh-gray">Discount</td>
                    <td className="px-4 py-2 text-right text-red-600">
                      {formatCurrency(proposal.discountTotal)}
                    </td>
                  </tr>
                )}
                <tr className="bg-sh-linen font-semibold">
                  <td colSpan={3} />
                  <td className="px-4 py-2 text-right text-sh-black">Client Price</td>
                  <td className="px-4 py-2 text-right text-sh-black">
                    {formatCurrency(proposal.clientPrice)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex gap-4">
            <button
              onClick={() => router.push(`/app/sales/orders/${result.orderId}`)}
              className="px-6 py-2 bg-sh-blue text-white rounded hover:bg-sh-navy transition text-sm font-semibold"
            >
              View Order {result.orderno}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
