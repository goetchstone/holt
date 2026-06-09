"use client";

// /app/src/app/(dashboard)/app/admin/tools/merge-customers/MergeCustomersView.tsx
//
// Finds customers sharing a first + last name, merges their POS IDs and
// addresses into one record, and deletes the duplicates. Reads the shared
// /api/customers/merge-duplicates REST endpoint. Chrome from the (dashboard)
// layout.

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

interface MergeResponse {
  message: string;
}

export function MergeCustomersView() {
  const [isLoading, setIsLoading] = useState(false);

  const handleMerge = async () => {
    setIsLoading(true);
    const toastId = toast.loading("Merging duplicate customers... This may take a moment.");

    try {
      const response = await axios.post<MergeResponse>("/api/customers/merge-duplicates");
      toast.update(toastId, {
        render: response.data.message,
        type: "success",
        isLoading: false,
        autoClose: 3000,
      });
    } catch (err: unknown) {
      toast.update(toastId, {
        render: getErrorMessage(err, "An error occurred while merging customers."),
        type: "error",
        isLoading: false,
        autoClose: 5000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue">Merge Duplicate Customers</h1>
      <div className="bg-white p-6 rounded-lg shadow-md">
        <p className="mb-4 text-sh-black">
          This tool will find customers with the same first and last name, merge their POS IDs and
          addresses into a single record, and delete the duplicates. This action cannot be undone.
        </p>
        <button
          onClick={handleMerge}
          disabled={isLoading}
          className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded disabled:bg-gray-400 min-h-[44px]"
        >
          {isLoading ? "Merging..." : "Merge Duplicates Now"}
        </button>
      </div>
    </div>
  );
}
