// /app/src/lib/windfallImport.ts
//
// Utilities for importing Windfall wealth enrichment CSVs.
// The enriched customer file matches by the POS customer code.

export interface WindfallParsedRow {
  customerCode: string;
  firstName: string | null;
  lastName: string | null;
  windfallId: string | null;
  matchConfidence: number | null;
  netWorth: number | null;
  netWorthLow: number | null;
  netWorthHigh: number | null;
  netWorthLastCalculated: string | null;
  recentMover: boolean;
  recentlyDivorced: boolean;
  recentDeathInFamily: boolean;
  moneyInMotion: boolean;
  liquidityTrigger: boolean;
  recentMortgage: boolean;
  boatOwner: boolean;
  planeOwner: boolean;
  multiPropertyOwner: boolean;
  rentalPropertyOwner: boolean;
  smallBusinessOwner: boolean;
  cryptoInterest: boolean;
  philanthropicGiver: boolean;
  topPhilanthropicDonor: boolean;
  nonprofitBoardMember: boolean;
  donorAdvisedFunds: boolean;
  nteeCodes: string | null;
  regionalFocus: string | null;
  foundationAssociation: boolean;
  foundationOfficer: boolean;
  politicalDonor: boolean;
  topPoliticalDonor: boolean;
  politicalParty: string | null;
  hasHouseholdDebt: boolean;
  primaryPropertyLtv: number | null;
  trustAssociation: boolean;
}

export type WealthTier = "ULTRA_HIGH" | "VERY_HIGH" | "HIGH" | "AFFLUENT" | null;

export function computeWealthTier(netWorth: number | null): WealthTier {
  if (netWorth == null) return null;
  if (netWorth >= 10_000_000) return "ULTRA_HIGH";
  if (netWorth >= 5_000_000) return "VERY_HIGH";
  if (netWorth >= 1_000_000) return "HIGH";
  if (netWorth >= 500_000) return "AFFLUENT";
  return null;
}

function parseBool(val: string | undefined): boolean {
  return val === "1" || val?.toLowerCase() === "true";
}

function parseIntOrNull(val: string | undefined): number | null {
  if (!val || val.trim() === "") return null;
  const n = Number.parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

function parseFloatOrNull(val: string | undefined): number | null {
  if (!val || val.trim() === "") return null;
  const n = Number.parseFloat(val);
  return Number.isNaN(n) ? null : n;
}

function str(val: string | undefined): string | null {
  return val && val.trim() !== "" ? val.trim() : null;
}

// Pick the first non-empty value across a list of candidate column names —
// lets us accept both legacy (Code / first_name) and current (Cuscode /
// FirstName) Windfall CSV headers without forking the parser.
function pick(row: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// Parses a single row from the Windfall enriched customer CSV.
// Column names come from the CSV headers after PapaParse trims them.
export function parseWindfallCustomerRow(row: Record<string, string>): WindfallParsedRow | null {
  const customerCode = str(pick(row, ["Cuscode", "Code", "CustomerCode", "cuscode"]));
  if (!customerCode) return null;

  return {
    customerCode,
    firstName: str(pick(row, ["FirstName", "first_name", "First Name"])),
    lastName: str(pick(row, ["LastName", "last_name", "Last Name"])),
    windfallId: str(row["Windfall Id"]),
    matchConfidence: parseFloatOrNull(row["Match Confidence"]),
    netWorth: parseIntOrNull(row["Net Worth"]),
    netWorthLow: parseIntOrNull(row["Net Worth Low"]),
    netWorthHigh: parseIntOrNull(row["Net Worth High"]),
    netWorthLastCalculated: str(row["Net Worth Last Calculated"]),
    recentMover: parseBool(row["Recent Mover"]),
    recentlyDivorced: parseBool(row["Recently Divorced"]),
    recentDeathInFamily: parseBool(row["Recent Death in Family"]),
    moneyInMotion: parseBool(row["Money in Motion"]),
    liquidityTrigger: parseBool(row["Liquidity Trigger"]),
    recentMortgage: parseBool(row["Recent Mortgage"]),
    boatOwner: parseBool(row["Boat Owner"]),
    planeOwner: parseBool(row["Plane Owner"]),
    multiPropertyOwner: parseBool(row["Multi-property Owner"]),
    rentalPropertyOwner: parseBool(row["Rental Property Owner"]),
    smallBusinessOwner: parseBool(row["Small Business Owner"]),
    cryptoInterest: parseBool(row["Crypto Interest"]),
    philanthropicGiver: parseBool(row["Philanthropic Giver"]),
    topPhilanthropicDonor: parseBool(row["Top Philanthropic Donor"]),
    nonprofitBoardMember: parseBool(row["Nonprofit Board Member"]),
    donorAdvisedFunds: parseBool(row["Donor Advised Funds"]),
    nteeCodes: str(row["NTEE Codes"]),
    regionalFocus: str(row["Regional Focus"]),
    foundationAssociation: parseBool(row["Foundation Association"]),
    foundationOfficer: parseBool(row["Foundation Officer/Trustee"]),
    politicalDonor: parseBool(row["Political Donor"]),
    topPoliticalDonor: parseBool(row["Top Political Donor"]),
    politicalParty: str(row["Political Party"]),
    hasHouseholdDebt: parseBool(row["Has Household Debt"]),
    primaryPropertyLtv: parseFloatOrNull(row["Primary Property Loan-to-Value"]),
    trustAssociation: parseBool(row["Trust Association"]),
  };
}
