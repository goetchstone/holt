// /app/src/lib/errorCode.ts
//
// Pull a string `code` off an unknown error without resorting to `any`.
// Covers both Prisma known-request errors (`err.code === "P2002"`) and Node
// system errors (`err.code === "ECONNREFUSED"`) -- both expose a string `code`
// on the error object, so one structural guard serves both. Use in catch
// blocks that branch on an error code:
//
//   } catch (err: unknown) {
//     if (getErrorCode(err) === "P2002") { ...unique-constraint handling... }
//   }

export function getErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Postgres's deadlock and serialization-failure codes. */
const CONFLICT_SQLSTATES = new Set(["40P01", "40001"]);

/**
 * Did this write lose a race with another transaction (a deadlock or a
 * serialization failure)? The pg driver adapter reports both as Prisma's
 * P2034; a raw query's failure (P2010) can carry the Postgres code in its
 * meta instead. A route answers these with a 409 "try again", not a 500: the
 * caller did nothing wrong and a retry will usually succeed (rule 11).
 */
export function isWriteConflict(err: unknown): boolean {
  const code = getErrorCode(err);
  if (code === "P2034") return true;
  if (code === undefined) return false;
  const meta = (err as { meta?: unknown }).meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const sqlstate = meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
  return typeof sqlstate === "string" && CONFLICT_SQLSTATES.has(sqlstate);
}
