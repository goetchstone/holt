// /app/src/lib/genericImport.ts
//
// Client/server contract for the generic CSV importer. Defines which business
// entities can be imported from a spreadsheet, the fields each one accepts,
// and alias-based auto-mapping of arbitrary CSV headers onto those fields.
// No server-only imports (no prisma, no fs) so the admin import page and the
// import API can both read this single source of truth.

export type ImportFieldType = "string" | "number";

export interface ImportFieldDef {
  key: string;
  label: string;
  type: ImportFieldType;
  /** Extra header spellings to auto-match, beyond the field key + label. */
  aliases: string[];
  required?: boolean;
  help?: string;
}

export interface ImportEntityDef {
  key: string;
  label: string;
  description: string;
  fields: ImportFieldDef[];
}

export const IMPORT_ENTITIES: readonly ImportEntityDef[] = [
  {
    key: "customer",
    label: "Customers",
    description:
      "Import a customer list from your previous system. Rows are matched to existing customers by code, then by name + email, so re-importing updates rather than duplicates.",
    fields: [
      {
        key: "externalId",
        label: "Customer Code",
        type: "string",
        aliases: [
          "code",
          "customercode",
          "customerid",
          "cuscode",
          "id",
          "account",
          "accountnumber",
        ],
        help: "Your previous system's ID for this customer. Used to match the same customer on re-import.",
      },
      {
        key: "name",
        label: "Full Name",
        type: "string",
        aliases: ["customer", "customername", "fullname", "contact", "contactname"],
        help: "Use this when names are in one column. Otherwise map First / Last Name below.",
      },
      {
        key: "firstName",
        label: "First Name",
        type: "string",
        aliases: ["first", "fname", "givenname"],
      },
      {
        key: "lastName",
        label: "Last Name",
        type: "string",
        aliases: ["last", "lname", "surname", "familyname"],
      },
      {
        key: "email",
        label: "Email",
        type: "string",
        aliases: ["emailaddress", "e-mail"],
      },
      {
        key: "phone",
        label: "Phone",
        type: "string",
        aliases: ["phonenumber", "tel", "telephone", "mobile", "cell"],
      },
      {
        key: "address1",
        label: "Street Address",
        type: "string",
        aliases: ["address", "addressline1", "street", "streetaddress"],
      },
      { key: "city", label: "City", type: "string", aliases: ["town"] },
      { key: "state", label: "State", type: "string", aliases: ["province", "region"] },
      {
        key: "zip",
        label: "ZIP / Postal Code",
        type: "string",
        aliases: ["zipcode", "postalcode", "postal", "postcode"],
      },
    ],
  },
  {
    key: "product",
    label: "Products",
    description:
      "Import a product catalog. Rows are matched to existing products by product number + vendor. Missing vendors, departments, and categories are created automatically.",
    fields: [
      {
        key: "productNumber",
        label: "Product Number",
        type: "string",
        aliases: ["sku", "itemnumber", "item", "partnumber", "partno", "number", "code"],
        required: true,
      },
      {
        key: "name",
        label: "Name",
        type: "string",
        aliases: ["productname", "title", "product"],
        required: true,
      },
      {
        key: "vendor",
        label: "Vendor",
        type: "string",
        aliases: ["supplier", "manufacturer", "brand", "make"],
        help: 'Created if it doesn\'t exist. Defaults to "Unknown Vendor" when unmapped or blank.',
      },
      {
        key: "department",
        label: "Department",
        type: "string",
        aliases: ["dept", "division"],
        help: 'Defaults to "Uncategorized" when unmapped or blank.',
      },
      {
        key: "category",
        label: "Category",
        type: "string",
        aliases: ["cat", "group"],
        help: 'Defaults to "Uncategorized" when unmapped or blank.',
      },
      {
        key: "baseCost",
        label: "Cost",
        type: "number",
        aliases: ["cost", "wholesale", "unitcost", "wholesalecost"],
      },
      {
        key: "baseRetail",
        label: "Retail Price",
        type: "number",
        aliases: ["retail", "price", "msrp", "listprice", "sellprice"],
      },
      {
        key: "description",
        label: "Description",
        type: "string",
        aliases: ["desc", "details", "notes"],
      },
    ],
  },
];

export function getImportEntity(key: string): ImportEntityDef | undefined {
  return IMPORT_ENTITIES.find((e) => e.key === key);
}

/** Mapping from an entity field key to the source CSV header (null = unmapped). */
export type ColumnMapping = Record<string, string | null>;

export interface GenericImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Guess a field->header mapping from the uploaded CSV's headers. Each source
 * header is claimed by at most one field (first match wins in field order),
 * so a column like "description" is taken by Name before the Description
 * field can grab it. Unmatched fields map to null.
 */
export function suggestMapping(headers: string[], entity: ImportEntityDef): ColumnMapping {
  const mapping: ColumnMapping = {};
  const claimed = new Set<string>();
  const normHeaders = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  for (const field of entity.fields) {
    const candidates = new Set<string>([
      normalizeHeader(field.key),
      normalizeHeader(field.label),
      ...field.aliases.map(normalizeHeader),
    ]);
    const hit = normHeaders.find((h) => !claimed.has(h.raw) && candidates.has(h.norm));
    mapping[field.key] = hit ? hit.raw : null;
    if (hit) claimed.add(hit.raw);
  }
  return mapping;
}
