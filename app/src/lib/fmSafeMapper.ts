// /app/src/lib/fmSafeMapper.ts

export const safeString = (str: any): string => (str || "").toString().trim();

export const safeFloat = (str: any): number => {
  const cleaned = (str || "").toString().replace(/[^0-9.-]+/g, "");
  const val = Number.parseFloat(cleaned);
  return Number.isNaN(val) ? 0 : val;
};

export const safeDate = (str: any): Date | null => {
  if (!str) return null;
  try {
    // Handle Excel dates formatted as MM/DD/YYYY
    const parts = str.split("/");
    if (parts.length !== 3) return null;
    const [month, day, year] = parts.map((p: string) => Number.parseInt(p));
    if (!month || !day || !year) return null;
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
};
