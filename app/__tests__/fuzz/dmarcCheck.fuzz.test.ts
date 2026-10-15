// /app/__tests__/fuzz/dmarcCheck.fuzz.test.ts
//
// Property-based fuzzing of lib/dmarc/check.ts, the analysis behind the
// public /api/tools/dmarc-check endpoint. Anyone can point it at a domain they
// control, so every TXT record it parses is attacker-authored: the parser must
// not throw, must not let a `__proto__=` tag reach Object.prototype, must
// finish quickly on oversized records, and must reach the same verdict as an
// independent reading of the tags.

import fc from "fast-check";
import {
  analyzeBimi,
  analyzeDmarc,
  analyzeMtaSts,
  analyzeSpf,
  analyzeTlsRpt,
  findDmarcRecords,
  findSpf,
  isValidDomain,
  parseTagRecord,
  suggestedRecords,
  type Status,
} from "@/lib/dmarc/check";
import { anyString, nastyString, PROTO_KEYS, timeMs, withoutPrototypePollution } from "./support";

const STATUSES: Status[] = ["ok", "warn", "fail", "missing"];

// A TXT lookup result: records, each split into <=255-char strings.
const txtRecord = fc.oneof(
  nastyString(),
  anyString(80),
  fc
    .constantFrom("v=spf1 ", "v=DMARC1; ", "v=STSv1; ", "v=TLSRPTv1; ", "v=BIMI1; ")
    .chain((v) => fc.oneof(nastyString(), anyString(80)).map((rest) => v + rest)),
);
const txtLookup = fc.option(
  fc.array(fc.array(txtRecord, { minLength: 1, maxLength: 3 }), { maxLength: 4 }),
  {
    nil: null,
  },
);

describe("parseTagRecord (lib/dmarc/check.ts)", () => {
  it("reads every k=v pair back exactly and never touches Object.prototype", () => {
    const key = fc.oneof(
      fc.constantFrom(...PROTO_KEYS, "p", "sp", "pct", "rua", "ruf", "id", "l", "a"),
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,8}$/),
    );
    const value = fc.oneof(fc.stringMatching(/^[^;]{0,30}$/), fc.constantFrom(...PROTO_KEYS));
    const pairs = fc.uniqueArray(fc.tuple(key, value), {
      maxLength: 8,
      selector: ([k]) => k.toLowerCase(),
    });
    const spacing = fc.constantFrom("", " ", "  ", "\t");
    fc.assert(
      fc.property(pairs, spacing, (kvs, sp) => {
        const record = kvs.map(([k, v]) => `${sp}${k}${sp}=${sp}${v}${sp}`).join(";");
        const tags = withoutPrototypePollution(() => parseTagRecord(record));
        expect(Object.getPrototypeOf(tags)).toBeNull();
        // Compared as entry lists: copying into a plain object would route a
        // "__proto__" key through the prototype setter and hide it.
        const expected = kvs
          .filter(([k]) => k.trim() !== "")
          .map(([k, v]) => [k.trim().toLowerCase(), v.trim()])
          .sort();
        expect(Object.entries(tags).sort()).toEqual(expected);
      }),
    );
  });
});

describe("TXT analyzers on attacker-controlled records", () => {
  it("never throw, never pollute, and always return a known status", () => {
    fc.assert(
      fc.property(txtLookup, (txt) => {
        withoutPrototypePollution(() => {
          const spf = analyzeSpf(findSpf(txt));
          const dmarc = analyzeDmarc(findDmarcRecords(txt));
          const optional = [analyzeMtaSts(txt), analyzeTlsRpt(txt), analyzeBimi(txt)];
          for (const s of [spf.status, dmarc.status, ...optional.map((o) => o.status)]) {
            expect(STATUSES).toContain(s);
          }
          expect(dmarc.pct).toBeGreaterThanOrEqual(0);
          expect(dmarc.pct).toBeLessThanOrEqual(100);
          // Anything short of "ok" must tell the operator why.
          if (spf.status !== "ok") expect(spf.issues.length).toBeGreaterThan(0);
          if (dmarc.status !== "ok") expect(dmarc.issues.length).toBeGreaterThan(0);
        });
      }),
    );
  });

  it("finish in well under a second on 50k-character records", () => {
    const filler = fc.constantFrom(
      "a",
      " ",
      ";",
      "=",
      "include:",
      "a:",
      "+all",
      "x".repeat(7),
      "v=",
    );
    fc.assert(
      fc.property(filler, fc.integer({ min: 1_000, max: 50_000 }), (unit, chars) => {
        const body = unit.repeat(Math.ceil(chars / unit.length));
        const txt = [["v=spf1 " + body], ["v=DMARC1; " + body], ["v=STSv1; " + body]];
        const ms = timeMs(() => {
          analyzeSpf(findSpf(txt));
          analyzeDmarc(findDmarcRecords(txt));
          analyzeMtaSts(txt);
          isValidDomain(body);
        });
        expect(ms).toBeLessThan(500);
      }),
      { numRuns: 20 },
    );
  });
});

describe("analyzeDmarc verdict (lib/dmarc/check.ts)", () => {
  const policy = fc.constantFrom("none", "quarantine", "reject", "NONE", "Reject", "bogus", "");
  const tagSpace = fc.constantFrom("", " ");
  const dmarcRecord = fc.record({
    p: fc.option(policy, { nil: undefined }),
    sp: fc.option(policy, { nil: undefined }),
    pct: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
    rua: fc.option(fc.constantFrom("mailto:d@example.com", "https://example.com/r", ""), {
      nil: undefined,
    }),
    space: tagSpace,
  });

  it("calls a record enforcing exactly when p acts on all mail and sp does not exempt subdomains", () => {
    fc.assert(
      fc.property(dmarcRecord, ({ p, sp, pct, rua, space }) => {
        const tags = [
          "v=DMARC1",
          p !== undefined ? `p=${p}` : null,
          sp !== undefined ? `sp=${sp}` : null,
          pct !== undefined ? `pct=${pct}` : null,
          rua !== undefined ? `rua=${rua}` : null,
        ].filter((t): t is string => t !== null);
        const result = analyzeDmarc([tags.join(`;${space}`)]);

        // Independent oracle, written from RFC 7489 rather than from the code.
        const pol = (v: string | undefined) => {
          const x = (v ?? "").toLowerCase();
          return ["none", "quarantine", "reject"].includes(x) ? x : null;
        };
        const effectivePct = pct ?? 100;
        const acts = pol(p) === "quarantine" || pol(p) === "reject";
        expect(result.enforcing).toBe(acts && effectivePct === 100 && pol(sp) !== "none");
        expect(result.hasReporting).toBe(rua === "mailto:d@example.com");
        expect(result.status === "fail").toBe(pol(p) === null);
      }),
    );
  });

  it("every suggested fix actually removes the defect it was suggested for", () => {
    const spfRecord = fc
      .tuple(
        fc.array(fc.constantFrom("include:_spf.google.com", "a", "mx", "ip4:192.0.2.1"), {
          maxLength: 4,
        }),
        fc.constantFrom("", " +all", " ?all", " ~all", " -all", " +ALL"),
      )
      .map(([mechs, all]) => `v=spf1 ${mechs.join(" ")}${all}`.replace(/\s+/g, " "));
    fc.assert(
      fc.property(fc.option(spfRecord, { nil: null }), dmarcRecord, (spf, d) => {
        const domain = "example.com";
        const dmarcText = [
          "v=DMARC1",
          d.p !== undefined ? `p=${d.p}` : null,
          d.pct !== undefined ? `pct=${d.pct}` : null,
          d.rua !== undefined ? `rua=${d.rua}` : null,
        ]
          .filter((t): t is string => t !== null)
          .join(`;${d.space}`);
        const dmarc = analyzeDmarc([dmarcText]);
        const spfAnalysis = analyzeSpf(spf);
        const missing = { found: false, record: null, detail: "", status: "missing" as const };
        const fixes = suggestedRecords({
          domain,
          provider: null,
          spfRecord: spf,
          spfStatus: spfAnalysis.status,
          dmarc,
          mtaSts: missing,
          tlsRpt: missing,
        });

        const spfFix = fixes.find((f) => f.name === domain);
        if (spfFix) {
          expect(spfFix.value).not.toMatch(/(\+all|\?all)\b/i);
          expect(spfFix.value).toMatch(/(~all|-all)\b/i);
        }
        const dmarcFix = fixes.find((f) => f.name === `_dmarc.${domain}`);
        if (dmarcFix) {
          const after = analyzeDmarc([dmarcFix.value]);
          if (dmarc.policy === "none") expect(after.policy).toBe("quarantine");
          else if (!dmarc.hasReporting) expect(after.hasReporting).toBe(true);
          else if (dmarc.pct < 100) expect(after.pct).toBe(100);
        }
      }),
    );
  });
});

describe("isValidDomain (lib/dmarc/check.ts)", () => {
  it("rejects anything that is not a bare hostname, whatever is around it", () => {
    fc.assert(
      fc.property(
        fc.domain(),
        fc.constantFrom(
          "http://",
          "https://",
          "/",
          " ",
          "@",
          ":443",
          "/path",
          "\n",
          "\u0000",
          "?q=1",
        ),
        fc.boolean(),
        (domain, junk, before) => {
          expect(isValidDomain(before ? junk + domain : domain + junk)).toBe(false);
        },
      ),
    );
  });

  it("never accepts an IP address", () => {
    fc.assert(
      fc.property(fc.ipV4(), (ip) => {
        expect(isValidDomain(ip)).toBe(false);
      }),
    );
  });
});
