// /app/src/lib/buildSearchFilter.ts
//
// Shared search-filter builder for list endpoints. Turns a user-typed search
// string into a Prisma `where` fragment that matches each whitespace-separated
// token against ANY of the provided field paths.
//
// Why: The naive OR-of-contains pattern cannot match a concatenated full name
// like "John Smith" when firstName="John" and lastName="Smith" — neither
// field contains the entire search string. Splitting on whitespace and
// requiring each token to appear in at least one field handles full names,
// reversed names, partial names, and phone/email fragments.
//
// Semantics:
//   - Empty or whitespace-only input returns undefined (caller merges conditionally).
//   - Single token behaves identically to a simple OR-of-contains (no regression).
//   - Multiple tokens become AND of per-token ORs: every token must hit some field.
//
// Field paths use dot notation:
//   - "firstName"                     → plain column
//   - "customer.lastName"             → nested one-to-one relation
//   - "externalIds.some.externalId"   → many relation via `some`
//
// All string matches are case-insensitive.
//
// The returned object is a minimal Prisma where fragment. Callers cast it to
// the specific `Prisma.ModelWhereInput` for their model.

type Leaf = { contains: string; mode: "insensitive" };

type Nested = { [key: string]: Nested | Leaf };

export interface SearchFilter {
  AND: Array<{ OR: Nested[] }>;
}

function buildLeaf(path: string, token: string): Nested {
  const parts = path.split(".");
  const leaf: Leaf = { contains: token, mode: "insensitive" };
  // Build nested object inside-out
  let node: Nested | Leaf = leaf;
  for (let i = parts.length - 1; i >= 0; i--) {
    node = { [parts[i]]: node } as Nested;
  }
  return node as Nested;
}

export function buildSearchFilter(
  searchTerm: string | null | undefined,
  fieldPaths: string[],
): SearchFilter | undefined {
  if (!searchTerm) return undefined;
  if (fieldPaths.length === 0) return undefined;

  const tokens = searchTerm
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return undefined;

  return {
    AND: tokens.map((token) => ({
      OR: fieldPaths.map((path) => buildLeaf(path, token)),
    })),
  };
}
