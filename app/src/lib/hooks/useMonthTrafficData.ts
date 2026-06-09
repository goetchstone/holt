// /app/src/lib/hooks/useMonthTrafficData.ts

import { useEffect, useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { getErrorMessage } from "@/lib/toastError";

export function useMonthTrafficData() {
  const [monthTrafficData, setMonthTrafficData] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchMonthTraffic() {
      const now = new Date();
      const dateFrom = format(startOfMonth(now), "yyyy-MM-dd");
      const dateTo = format(endOfMonth(now), "yyyy-MM-dd");

      try {
        const response = await fetch(`/api/axper/traffic?dateFrom=${dateFrom}&dateTo=${dateTo}`);
        const text = await response.text();

        // Detect CSV fallback
        if (text.startsWith("store_number,store_name,local_time,entries,exits")) {
          setMonthTrafficData([]);
          return;
        }

        const data = JSON.parse(text);

        if (data.error) {
          throw new Error(data.error);
        }

        setMonthTrafficData(data);
      } catch (err: unknown) {
        setError(getErrorMessage(err, "Error fetching month traffic"));
        setMonthTrafficData([]);
      }
    }

    fetchMonthTraffic();

    const interval = setInterval(() => {
      fetchMonthTraffic();
    }, 900000); // 15 minutes

    return () => clearInterval(interval);
  }, []);

  return monthTrafficData;
}
