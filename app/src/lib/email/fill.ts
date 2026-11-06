// /app/src/lib/email/fill.ts
//
// Fills a store's wording with {placeholders}. One pass over the store's text, so a value
// is never read again for placeholders: a customer named "{order}" is printed as typed.
// Pure, and shared by customer messages and the other emails a store words itself (rule 6).

const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;

export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER_RE, (whole, key: string) =>
    key in values ? (values[key] ?? "") : whole,
  );
}

/** The {placeholders} a piece of wording uses. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((match) => match[1]);
}
