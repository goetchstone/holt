"use client";

// /app/src/app/(dashboard)/app/admin/diagnostics/lookup-test/LookupTestView.tsx
//
// Diagnostic Lookup Tool body. App Router port of the legacy
// admin/diagnostics/lookup-test body (minus MainLayout chrome). Bypasses the
// scanning UI to exercise the backend lookup directly via the shared
// /api/diagnostics/lookup-test REST endpoint and renders the raw JSON response.

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import FormInput from "@/components/form/FormInput";

// The lookup endpoint returns an open-ended diagnostic payload; `found` drives
// the success/error styling and the rest is rendered verbatim as JSON.
interface LookupResult {
  found?: boolean;
  [key: string]: unknown;
}

export function LookupTestView() {
  const [identifier, setIdentifier] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleTest = async () => {
    if (!identifier.trim()) {
      toast.error("Please enter a barcode or product # to test.");
      return;
    }
    setIsLoading(true);
    setResult(null);
    try {
      const response = await axios.post<LookupResult>("/api/diagnostics/lookup-test", {
        identifier: identifier.trim(),
      });
      setResult(response.data);
      toast.success("Lookup successful!");
    } catch (err: unknown) {
      const data = axios.isAxiosError(err)
        ? (err.response?.data as LookupResult | undefined)
        : undefined;
      setResult(data ?? { error: "An unknown error occurred." });
      toast.error("Lookup failed.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto mt-8 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue mb-4">Diagnostic Lookup Tool</h1>
      <p className="mb-4 text-sh-gray">
        This tool bypasses the scanning UI to test the backend lookup directly. Copy a known-good
        barcode from the UPC Viewer and paste it here to see the raw API response.
      </p>
      <div className="flex items-center gap-2">
        <FormInput
          label="Barcode or Product #"
          name="identifier"
          value={identifier}
          onChange={setIdentifier}
          placeholder="Paste identifier here..."
        />
        <Button onClick={handleTest} disabled={isLoading} className="self-end">
          {isLoading ? "Testing..." : "Test Lookup"}
        </Button>
      </div>

      {result && (
        <div className="mt-6">
          <h2 className="text-lg font-bold mb-2">Raw API Response:</h2>
          <pre
            className={`p-4 rounded-lg overflow-x-auto text-sm ${result.found ? "bg-green-100" : "bg-red-100"}`}
          >
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
