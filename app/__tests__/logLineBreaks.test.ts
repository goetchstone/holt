// /app/__tests__/logLineBreaks.test.ts
//
// CodeQL js/log-injection #43-#48. A plain-text log line built from a request
// value must stay ONE line: otherwise `?dateFrom=x%0AERROR ...` (decoded by the
// query parser) or a crafted path writes what reads as a separate, forged log
// entry. logger's development format and requestLog's every format are plain
// text; logger's production format is JSON, which escapes newlines itself.

import type { NextApiRequest, NextApiResponse } from "next";
import { logger, stripLineBreaks } from "@/lib/logger";
import { withLogging } from "@/lib/requestLog";

const FORGED = "real message\r\n[2026-10-15T00:00:00.000Z] ERROR: forged entry";

afterEach(() => jest.restoreAllMocks());

describe("stripLineBreaks", () => {
  it("removes CR and LF and keeps everything else", () => {
    expect(stripLineBreaks("a\r\nb\nc\rd e\tf")).toBe("abcd e\tf");
    expect(stripLineBreaks("plain")).toBe("plain");
  });
});

describe("logger (development format)", () => {
  it("writes a message carrying a newline as a single line", () => {
    const out = jest.spyOn(console, "log").mockImplementation(() => {});
    logger.info(FORGED, { dateFrom: "x\ny" });
    expect(out).toHaveBeenCalledTimes(1);
    const line = String(out.mock.calls[0][0]);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain("real message");
  });
});

describe("withLogging", () => {
  function fakeRes(statusCode: number): NextApiResponse {
    return { statusCode, end: () => undefined } as unknown as NextApiResponse;
  }

  it("logs a request path carrying CR/LF as a single line", async () => {
    const out = jest.spyOn(console, "log").mockImplementation(() => {});
    const req = { method: "GET", url: `/api/x?q=${FORGED}`, headers: {} } as NextApiRequest;
    const res = fakeRes(404);
    await withLogging(async (_req, r) => {
      r.end();
    })(req, res);
    expect(out).toHaveBeenCalledTimes(1);
    const line = String(out.mock.calls[0][0]);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain("/api/x?q=real message");
  });
});
