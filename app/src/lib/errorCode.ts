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
