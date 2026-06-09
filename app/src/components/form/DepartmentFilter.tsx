// /app/src/components/form/DepartmentFilter.tsx

"use client";

import { useEffect, useState } from "react";
import { useFetchOptions } from "@/hooks/useFetchOptions";

export default function DepartmentFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  // CORRECTED: Pass ?all=true to fetch all departments
  const [departments, loading, error] = useFetchOptions("/api/departments?all=true");

  if (loading) {
    return (
      <div>
        <label className="font-serif text-sh-black mb-1 block">Department</label>
        <select disabled className="border p-2 w-full">
          <option value="">Loading Departments...</option>
        </select>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <label className="font-serif text-sh-black mb-1 block">Department</label>
        <select disabled className="border p-2 w-full text-red-600">
          <option value="">Error loading Departments</option>
        </select>
      </div>
    );
  }

  return (
    <div>
      <label className="font-serif text-sh-black mb-1 block">Department</label>
      <select
        name="departmentId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border p-2 w-full"
        required
      >
        <option value="">Select Department</option>
        {(departments || []).map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </div>
  );
}
