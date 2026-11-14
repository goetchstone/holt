// /app/src/lib/searchAsYouTypeStatus.ts
//
// Where a search-as-you-type box stands, from the text typed and the text the
// held results answer. A debounced search has two windows in which the
// results on hand do not answer the box: before the debounce fires, and while
// the request is out. A picker that keys "No matching ..." off an in-flight
// flag alone shows it for the debounce window on the first search, and offers
// the previous query's results, clickable, on later keystrokes.

export type SearchAsYouTypeStatus = "idle" | "searching" | "done";

/**
 * - `idle`: too little typed to search.
 * - `searching`: the held results answer some other text (or nothing yet).
 * - `done`: the held results answer exactly what is typed; an empty list
 *   now really means no match.
 */
export function searchAsYouTypeStatus(
  query: string,
  answeredQuery: string | null,
  minLength: number,
): SearchAsYouTypeStatus {
  if (query.length < minLength) return "idle";
  return answeredQuery === query ? "done" : "searching";
}
