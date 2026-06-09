"use client";

// /app/src/app/(dashboard)/app/admin/setup/tax/load-zips/LoadZipsView.tsx
//
// Load Tax Zip Codes body. App Router port of the legacy admin/setup/tax/
// load-zips body (minus MainLayout chrome, which the (dashboard) layout
// supplies). Parses an uszips.csv client-side, filters to one state, and
// bulk-loads those ZIPs into a tax district via /api/admin/seed-tax-zips.

import { useCallback, useEffect, useState } from "react";
import Papa from "papaparse";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface TaxDistrict {
  id: number;
  shortName: string;
  state: string;
}

interface LoadResult {
  created: number;
  skipped: number;
  message: string;
}

interface ZipRow {
  zip: string;
  state_id: string;
}

const US_STATES = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
];

export function LoadZipsView() {
  const [districts, setDistricts] = useState<TaxDistrict[]>([]);
  const [selectedDistrictId, setSelectedDistrictId] = useState<number | null>(null);
  const [selectedState, setSelectedState] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);

  const fetchDistricts = useCallback(async () => {
    try {
      const res = await axios.get("/api/tax/districts");
      setDistricts(Array.isArray(res.data) ? res.data : res.data.districts || []);
    } catch {
      toast.error("Failed to load tax districts");
    }
  }, []);

  useEffect(() => {
    fetchDistricts();
  }, [fetchDistricts]);

  const handleLoad = async () => {
    if (!file || !selectedDistrictId || !selectedState) {
      toast.error("Select a district, state, and upload the uszips CSV");
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const records: ZipRow[] = await new Promise((resolve) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => resolve(results.data as ZipRow[]),
        });
      });

      // Filter to selected state
      const stateZips = records.filter((r) => r.state_id === selectedState).map((r) => r.zip);

      if (stateZips.length === 0) {
        toast.error(`No zip codes found for state ${selectedState}`);
        setLoading(false);
        return;
      }

      const res = await axios.post<LoadResult>("/api/admin/seed-tax-zips", {
        districtId: selectedDistrictId,
        zips: stateZips,
      });

      setResult(res.data);
      toast.success(res.data.message);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load zip codes"));
    } finally {
      setLoading(false);
    }
  };

  const selectedDistrict = districts.find((d) => d.id === selectedDistrictId);

  return (
    <div className="max-w-2xl mx-auto py-6 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue mb-4">Load Tax District Zip Codes</h1>
      <p className="text-sm text-sh-gray mb-6">
        Upload the uszips.csv file and select a state to bulk-load all zip codes for that state into
        a tax district.
      </p>

      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="taxDistrict" className="block text-xs text-sh-gray mb-1">
              Tax District
            </label>
            <select
              id="taxDistrict"
              value={selectedDistrictId || ""}
              onChange={(e) => setSelectedDistrictId(Number.parseInt(e.target.value) || null)}
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
            >
              <option value="">Select district...</option>
              {districts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.shortName} - {d.state}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="taxState" className="block text-xs text-sh-gray mb-1">
              State
            </label>
            <select
              id="taxState"
              value={selectedState}
              onChange={(e) => setSelectedState(e.target.value)}
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
            >
              <option value="">Select state...</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="zipCsv" className="block text-xs text-sh-gray mb-1">
            Zip Code CSV (uszips.csv)
          </label>
          <input
            id="zipCsv"
            type="file"
            accept=".csv"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="text-sm"
          />
        </div>

        <Button
          onClick={handleLoad}
          disabled={loading || !file || !selectedDistrictId || !selectedState}
        >
          {loading
            ? "Loading..."
            : `Load ${selectedState || "..."} zips into ${selectedDistrict?.shortName || "..."}`}
        </Button>
      </div>

      {result && (
        <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4 mt-4">
          <p className="text-sm text-sh-black">
            <span className="font-semibold">{result.created}</span> zip codes added,{" "}
            <span className="font-semibold">{result.skipped}</span> already existed
          </p>
        </div>
      )}
    </div>
  );
}
