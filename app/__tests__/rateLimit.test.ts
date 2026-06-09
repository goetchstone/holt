// /app/__tests__/rateLimit.test.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { rateLimit } from "@/lib/rateLimit";

function mockReq(ip = "192.168.1.1"): NextApiRequest {
  return {
    headers: { "x-forwarded-for": ip },
    socket: { remoteAddress: ip },
  } as unknown as NextApiRequest;
}

function mockRes(): NextApiResponse & {
  _status: number;
  _json: any;
  _headers: Record<string, string>;
} {
  const res: any = {
    _status: 200,
    _json: null,
    _headers: {},
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: any) {
      res._json = data;
      return res;
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
    },
  };
  return res;
}

describe("rateLimit", () => {
  it("allows requests under the limit", async () => {
    const handler = jest.fn(async (_req, res) => res.status(200).json({ ok: true }));
    const limited = rateLimit({ windowMs: 60_000, maxRequests: 5 })(handler);

    const req = mockReq("10.0.0.1");
    const res = mockRes();
    await limited(req, res);

    expect(handler).toHaveBeenCalled();
    expect(res._status).toBe(200);
    expect(res._headers["X-RateLimit-Limit"]).toBe("5");
    expect(res._headers["X-RateLimit-Remaining"]).toBe("4");
  });

  it("blocks requests over the limit with 429", async () => {
    const handler = jest.fn(async (_req, res) => res.status(200).json({ ok: true }));
    const limited = rateLimit({ windowMs: 60_000, maxRequests: 3 })(handler);

    const ip = "10.0.0.2";

    for (let i = 0; i < 3; i++) {
      await limited(mockReq(ip), mockRes());
    }

    expect(handler).toHaveBeenCalledTimes(3);

    const res = mockRes();
    await limited(mockReq(ip), res);

    expect(handler).toHaveBeenCalledTimes(3); // not called again
    expect(res._status).toBe(429);
    expect(res._json.error).toBe("Too many requests");
    expect(res._json.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(res._headers["X-RateLimit-Remaining"]).toBe("0");
    expect(res._headers["Retry-After"]).toBeDefined();
  });

  it("tracks different IPs independently", async () => {
    const handler = jest.fn(async (_req, res) => res.status(200).json({ ok: true }));
    const limited = rateLimit({ windowMs: 60_000, maxRequests: 2 })(handler);

    await limited(mockReq("10.0.0.3"), mockRes());
    await limited(mockReq("10.0.0.3"), mockRes());

    // IP .3 is now at limit
    const res3 = mockRes();
    await limited(mockReq("10.0.0.3"), res3);
    expect(res3._status).toBe(429);

    // IP .4 should still be allowed
    const res4 = mockRes();
    await limited(mockReq("10.0.0.4"), res4);
    expect(res4._status).toBe(200);
  });

  it("decrements remaining count correctly", async () => {
    const handler = jest.fn(async (_req, res) => res.status(200).json({ ok: true }));
    const limited = rateLimit({ windowMs: 60_000, maxRequests: 3 })(handler);

    const ip = "10.0.0.5";

    const res1 = mockRes();
    await limited(mockReq(ip), res1);
    expect(res1._headers["X-RateLimit-Remaining"]).toBe("2");

    const res2 = mockRes();
    await limited(mockReq(ip), res2);
    expect(res2._headers["X-RateLimit-Remaining"]).toBe("1");

    const res3 = mockRes();
    await limited(mockReq(ip), res3);
    expect(res3._headers["X-RateLimit-Remaining"]).toBe("0");
  });
});
