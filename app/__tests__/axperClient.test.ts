// /app/__tests__/axperClient.test.ts
//
// Pure-helper + behavior tests for `lib/axperClient.ts`.
//
// What we're pinning:
//   1. `enumerateAxperDays` produces the right YYYY-MM-DD sequence and
//      bails on invalid / inverted / over-cap inputs.
//   2. `fetchAxperTraffic` issues EXACTLY ONE Axper API call per
//      calendar day in the requested range. This is the safety net
//      added 2026-05-28 — Axper's `GetTrafficDataUsingDailyPeriod`
//      returns wrong counts on multi-day calls, so the client clamps
//      every multi-day request to a sequential day-by-day walk.

import { enumerateAxperDays, fetchAxperTraffic } from "../src/lib/axperClient";
import axios from "axios";

jest.mock("axios");
jest.mock("../src/lib/logger", () => ({
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("enumerateAxperDays", () => {
  it("returns a single-element array for a same-day range", () => {
    expect(enumerateAxperDays("2026-05-28", "2026-05-28")).toEqual(["2026-05-28"]);
  });

  it("walks consecutive calendar days inclusive of both endpoints", () => {
    expect(enumerateAxperDays("2026-05-28", "2026-05-30")).toEqual([
      "2026-05-28",
      "2026-05-29",
      "2026-05-30",
    ]);
  });

  it("crosses a month boundary correctly", () => {
    expect(enumerateAxperDays("2026-05-30", "2026-06-02")).toEqual([
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
    ]);
  });

  it("handles a leap day", () => {
    expect(enumerateAxperDays("2024-02-28", "2024-03-01")).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ]);
  });

  it("produces 730 entries for a ~2-year range (the owner's seed scenario)", () => {
    const days = enumerateAxperDays("2024-05-28", "2026-05-27");
    expect(days).not.toBeNull();
    expect(days!.length).toBe(730);
    expect(days![0]).toBe("2024-05-28");
    expect(days![729]).toBe("2026-05-27");
  });

  it("returns null for unparseable inputs", () => {
    expect(enumerateAxperDays("not-a-date", "2026-05-28")).toBeNull();
    expect(enumerateAxperDays("2026-05-28", "garbage")).toBeNull();
  });

  it("returns null when dateFrom > dateTo (inverted range)", () => {
    expect(enumerateAxperDays("2026-05-30", "2026-05-28")).toBeNull();
  });

  it("returns null for ranges over 800 days (worst-case cap)", () => {
    // 2024-01-01 -> 2026-03-10 is 800 calendar days inclusive (incl.
    // the 2024 leap day). Right at the cap — allowed.
    const at = enumerateAxperDays("2024-01-01", "2026-03-10");
    expect(at).not.toBeNull();
    expect(at!.length).toBe(800);
    // One day further is 801 days — over the cap.
    expect(enumerateAxperDays("2024-01-01", "2026-03-11")).toBeNull();
  });
});

describe("fetchAxperTraffic multi-day clamp", () => {
  const realEnv = process.env.AXPER_API_KEY;

  beforeEach(() => {
    process.env.AXPER_API_KEY = "test-key";
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (realEnv === undefined) delete process.env.AXPER_API_KEY;
    else process.env.AXPER_API_KEY = realEnv;
  });

  it("makes exactly ONE Axper call for a same-day request", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        {
          store_number: "1",
          store_name: "OS",
          local_time: "2026-05-28T09:00:00",
          entries: 3,
          exits: 2,
        },
      ],
    });
    const rows = await fetchAxperTraffic({ dateFrom: "2026-05-28", dateTo: "2026-05-28" });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it("makes N calls for a multi-day range — never one call with the full range", async () => {
    // Three-day range: 2026-05-26, 27, 28
    mockedAxios.get.mockResolvedValue({
      data: [
        {
          store_number: "1",
          store_name: "OS",
          local_time: "2026-05-26T09:00:00",
          entries: 1,
          exits: 1,
        },
      ],
    });
    const rows = await fetchAxperTraffic({ dateFrom: "2026-05-26", dateTo: "2026-05-28" });
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);

    // Each call had DateFrom === DateTo (the entire point of the clamp).
    for (const call of mockedAxios.get.mock.calls) {
      const params = call[1]?.params as { DateFrom: string; DateTo: string };
      expect(params.DateFrom).toBe(params.DateTo);
    }

    // And the dates issued match the enumerated sequence.
    const issuedDates = mockedAxios.get.mock.calls.map(
      (c) => (c[1]?.params as { DateFrom: string }).DateFrom,
    );
    expect(issuedDates).toEqual(["2026-05-26", "2026-05-27", "2026-05-28"]);

    // Rows from every successful day are concatenated.
    expect(rows).toHaveLength(3);
  });

  it("returns [] without making any call when the range is invalid", async () => {
    const rows = await fetchAxperTraffic({ dateFrom: "garbage", dateTo: "2026-05-28" });
    expect(rows).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("returns [] without making any call when the range is inverted", async () => {
    const rows = await fetchAxperTraffic({ dateFrom: "2026-05-30", dateTo: "2026-05-28" });
    expect(rows).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("returns [] without making any call when AXPER_API_KEY is missing", async () => {
    delete process.env.AXPER_API_KEY;
    const rows = await fetchAxperTraffic({ dateFrom: "2026-05-28", dateTo: "2026-05-28" });
    expect(rows).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("multi-day: a failed day doesn't poison the rest of the range", async () => {
    // Day 1 OK, day 2 throws, day 3 OK
    mockedAxios.get
      .mockResolvedValueOnce({
        data: [
          {
            store_number: "1",
            store_name: "OS",
            local_time: "2026-05-26T09:00:00",
            entries: 5,
            exits: 4,
          },
        ],
      })
      .mockRejectedValueOnce(new Error("axper transient 502"))
      .mockResolvedValueOnce({
        data: [
          {
            store_number: "1",
            store_name: "OS",
            local_time: "2026-05-28T09:00:00",
            entries: 7,
            exits: 6,
          },
        ],
      });

    const rows = await fetchAxperTraffic({ dateFrom: "2026-05-26", dateTo: "2026-05-28" });

    // Three calls attempted (the loop didn't abort on the middle failure)
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    // Two days of data returned (failed day silently dropped)
    expect(rows).toHaveLength(2);
    expect(rows[0].entries).toBe(5);
    expect(rows[1].entries).toBe(7);
  });

  it("skips Axper's CSV-fallback responses without throwing", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: "store_number,store_name,local_time,entries,exits\n",
    });
    const rows = await fetchAxperTraffic({ dateFrom: "2026-05-28", dateTo: "2026-05-28" });
    expect(rows).toEqual([]);
  });

  it("filters out malformed rows (missing required fields)", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        {
          store_number: "1",
          store_name: "OS",
          local_time: "2026-05-28T09:00:00",
          entries: 3,
          exits: 2,
        },
        { store_number: "2" /* missing store_name + local_time + entries */ },
        null,
      ],
    });
    const rows = await fetchAxperTraffic({ dateFrom: "2026-05-28", dateTo: "2026-05-28" });
    expect(rows).toHaveLength(1);
  });
});
