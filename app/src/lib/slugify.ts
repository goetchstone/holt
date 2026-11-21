// /app/src/lib/slugify.ts
//
// URL-safe slug from a name: the lowercase letter-and-digit words, joined by
// '-'. One home for the app's URL slugs (rule 6): service slugs
// (pages/api/services), CMS page and post slugs (the admin editors) and the
// organizer part of a booking's calendar UID (lib/booking/event.ts).
//
// Split-and-join, not the usual replace-then-trim-dashes: a trailing-dash
// pattern like /-+$/ is quadratic on a long run of dashes (CodeQL
// js/polynomial-redos, alert 68, raised by CodeQL 2.27.5 on 2026-11-20). The
// old version was only safe because the line before it happened to collapse
// every run of dashes to one; this one has nothing to trim, so nothing has to
// hold for it to stay linear.

/** "  Design Consultation! " -> "design-consultation". Empty when nothing in the
 *  name lowercases to a-z or 0-9 ("İ" and the Kelvin sign do); callers supply
 *  their own fallback. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
}
