// /app/src/lib/hooks/useWeekTrafficData.ts

import { useEffect, useState } from "react";
import { format, startOfWeek, endOfWeek } from "date-fns";
import { getErrorMessage } from "@/lib/toastError";

export function useWeekTrafficData() {
  const [weekTrafficData, setWeekTrafficData] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchWeekTraffic() {
      const now = new Date();
      const dateFrom = format(startOfWeek(now), "yyyy-MM-dd");
      const dateTo = format(endOfWeek(now), "yyyy-MM-dd");

      try {
        const response = await fetch(`/api/axper/traffic?dateFrom=${dateFrom}&dateTo=${dateTo}`);
        const text = await response.text();

        // Detect CSV fallback
        if (text.startsWith("store_number,store_name,local_time,entries,exits")) {
          setWeekTrafficData([]);
          return;
        }

        const data = JSON.parse(text);

        if (data.error) {
          throw new Error(data.error);
        }

        setWeekTrafficData(data);
      } catch (err: unknown) {
        setError(getErrorMessage(err, "Error fetching week traffic"));
        setWeekTrafficData([]);
      }
    }

    fetchWeekTraffic();

    const interval = setInterval(() => {
      fetchWeekTraffic();
    }, 900000); // 15 minutes

    return () => clearInterval(interval);
  }, []);

  return weekTrafficData;
}
