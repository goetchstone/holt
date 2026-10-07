// /app/src/hooks/useFetchOptions.ts

import { useState, useEffect } from "react";

// Define a generic type for options
interface Option {
  id: string | number;
  name?: string;
  value?: string; // For grades, for example
  upcharge?: number; // For finishes
  [key: string]: any; // Allow other properties
}

/**
 * Custom hook to fetch options for dropdowns/filters from a given API URL.
 *
 * @param {string | null} apiUrl - The API endpoint to fetch data from. If null, no fetch will occur.
 * @returns {[Option[], boolean, any]} - A tuple containing:
 * - options: An array of fetched Option objects.
 * - loading: A boolean indicating if data is currently being loaded.
 * - error: Any error that occurred during fetching.
 */
export function useFetchOptions(apiUrl: string | null): [Option[], boolean, any] {
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    if (!apiUrl) {
      setOptions([]); // Clear options if API URL is not provided
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(apiUrl);
        if (!res.ok) {
          // If response is not OK, try to parse error message, otherwise throw generic error
          const errorBody = await res.json().catch(() => ({ message: res.statusText }));
          throw new Error(`API Error: ${errorBody.error || errorBody.message || "Unknown error"}`);
        }
        const data = await res.json();

        let extractedOptions: Option[] = [];

        // Explicitly check for common API response patterns and ensure they are arrays
        if (Array.isArray(data)) {
          // Case: API returns a direct array (e.g., /api/templates, /api/vendors/[id]/frames)
          extractedOptions = data;
        } else if (data && typeof data === "object") {
          // Case: API returns an object with a key containing the array (e.g., { vendors: [...] }, { departments: [...] })
          if (Array.isArray(data.vendors)) {
            extractedOptions = data.vendors;
          } else if (Array.isArray(data.departments)) {
            extractedOptions = data.departments;
          } else if (Array.isArray(data.categories)) {
            extractedOptions = data.categories;
          } else if (Array.isArray(data.types)) {
            extractedOptions = data.types;
          } else if (Array.isArray(data.grades)) {
            extractedOptions = data.grades;
          } else if (Array.isArray(data.fabrics)) {
            extractedOptions = data.fabrics;
          } else if (Array.isArray(data.printers)) {
            extractedOptions = data.printers;
          } else if (Array.isArray(data.templates)) {
            // For /api/labels which returns { templates: [...] }
            extractedOptions = data.templates;
          }
          // Add other specific keys if your APIs return data under different names
          // e.g., if /api/products returns { products: [...] }
          else if (Array.isArray(data.products)) {
            extractedOptions = data.products;
          }
          // If the API returns a single object that represents the option itself (e.g., a detail API)
          // This is less common for a 'list' hook, but for robustness:
          else if (data.id && (data.name || data.value)) {
            // Basic check for a single option object
            extractedOptions = [data];
          }
        }

        // Ensure extractedOptions is always an array, even if the above logic fails to find one
        setOptions(Array.isArray(extractedOptions) ? extractedOptions : []);
      } catch (err: unknown) {
        // Constant format string (not concatenated) to satisfy Semgrep
        // unsafe-formatstring — the URL goes into the data arg, not the
        // format specifier.
        console.error("Error fetching options from %s:", apiUrl, err);
        setError(err);
        setOptions([]); // Ensure options is always an empty array on error
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [apiUrl]); // Re-run effect if API URL changes

  return [options, loading, error];
}
