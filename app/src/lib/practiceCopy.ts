// /app/src/lib/practiceCopy.ts
//
// Whether this deployment is a practice copy (GAP-28): a separate Holt on its own
// database, where staff learn the system on real products without touching the
// store's real data, charging a card or messaging anyone.
//
// THE DATABASE'S NAME IS THE ONE FACT
//
// A copy is practice when its database's name carries "practice" as a whole word,
// as in holt_demo_practice. That's the same doctrine as the seed's guard (rule 59).
// It isn't an env var or a setting, because each of those can disagree with the
// data they describe:
//
// - A flag on a live deployment would hide its payments and let Start over destroy
//   its data. A live database doesn't have this name, so that can't happen.
// - A flag lost from a practice deployment would start sending. A practice database
//   keeps its name, so it stays quiet.
// - A live backup restored into a practice database stays quiet too, which is the
//   direction that matters: its customers are real.
//
// So every guard, the banner and Start over ask this one function (rules 6, 42).
// Near misses like "practices", "impractice" and "holt-practice" aren't practice.

const PRACTICE_DATABASE_NAME = /(^|_)practice(_|$)/i;

/** The database a Postgres URL points at; empty if there's no telling. */
export function databaseNameFromUrl(databaseUrl: string): string {
  try {
    return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    return (databaseUrl.split("/").pop() ?? "").split("?")[0];
  }
}

export function isPracticeDatabaseName(name: string): boolean {
  return PRACTICE_DATABASE_NAME.test(name);
}

/** True when this process is running on a practice copy's database. */
export function isPracticeCopy(): boolean {
  return isPracticeDatabaseName(databaseNameFromUrl(process.env.DATABASE_URL ?? ""));
}

/** What a route answers when asked to connect a practice copy to something real. */
export const PRACTICE_COPY_NO_CONNECTIONS =
  "This is a practice copy, so it doesn't connect to other systems. Set this up on your live Holt.";

/** Stripe has no key here, and its own error would say only that the link failed. */
export const PRACTICE_COPY_NO_PAYMENT_LINKS =
  "This is a practice copy, so it can't send a payment link. Record the payment by hand.";
