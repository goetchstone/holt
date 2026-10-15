// /app/__tests__/fuzz/dmarcReport.fuzz.test.ts
//
// Property-based fuzzing of the public DMARC report reader: the decompressor
// (lib/dmarc/decompress.ts -- raw bytes of a file anyone can drop on
// /tools/dmarc-report) and the XML parser + aggregator (lib/dmarc/report.ts --
// XML written by whichever mail receiver, or attacker, sent the report).
// Both promise to fail ONLY with their own typed error carrying a user-facing
// message; the aggregator promises its totals partition the messages counted.
//
// Found a real bug on its first run: an element nested a few thousand levels
// deep inside a field the reader extracts (e.g. <domain>) parsed cleanly, then
// overflowed the stack when its text was read, so parseDmarcReport threw a
// bare RangeError ("Maximum call stack size exceeded") instead of a
// DmarcParseError. Counterexample: 5,000 nested <a> elements inside
// <policy_published><domain>.

import fc from "fast-check";
import { deflateRawSync, gzipSync } from "zlib";
import { DmarcDecompressError, decompressToXml } from "@/lib/dmarc/decompress";
import {
  DmarcParseError,
  parseDmarcReport,
  summarizeReports,
  type DmarcReport,
} from "@/lib/dmarc/report";
import { anyString, nastyString, PROTO_KEYS } from "./support";

// ── A generated report, and the XML a receiver would send for it ────────────

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlText = fc.oneof(
  fc.stringMatching(/^[\w .:@/-]{0,24}$/),
  fc.constantFrom(...PROTO_KEYS, "<&>", " padded "),
);

const genRecord = fc.record({
  sourceIp: fc.oneof(fc.ipV4(), fc.ipV6(), xmlText),
  count: fc.oneof(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 3_000_000_000 })),
  disposition: fc.constantFrom("none", "quarantine", "reject", "NONE", "Reject", "bogus", ""),
  dkim: fc.constantFrom("pass", "fail", "PASS", "softfail", ""),
  spf: fc.constantFrom("pass", "fail", "Pass", "neutral", ""),
  reasons: fc.array(fc.constantFrom("forwarded", "mailing_list", "local_policy", ...PROTO_KEYS), {
    maxLength: 2,
  }),
  selectors: fc.array(xmlText, { maxLength: 3 }),
});
type GenRecord = typeof genRecord extends fc.Arbitrary<infer T> ? T : never;

function recordXml(r: GenRecord): string {
  const reasons = r.reasons.map((t) => `<reason><type>${xmlEscape(t)}</type></reason>`).join("");
  const dkim = r.selectors
    .map(
      (s) =>
        `<dkim><domain>example.com</domain><selector>${xmlEscape(s)}</selector><result>pass</result></dkim>`,
    )
    .join("");
  return (
    `<record><row><source_ip>${xmlEscape(r.sourceIp)}</source_ip><count>${r.count}</count>` +
    `<policy_evaluated><disposition>${r.disposition}</disposition><dkim>${r.dkim}</dkim>` +
    `<spf>${r.spf}</spf>${reasons}</policy_evaluated></row>` +
    `<identifiers><header_from>example.com</header_from></identifiers>` +
    `<auth_results>${dkim}<spf><domain>example.com</domain><result>pass</result></spf></auth_results></record>`
  );
}

function reportXml(records: GenRecord[], orgName: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feedback><report_metadata>` +
    `<org_name>${xmlEscape(orgName)}</org_name><report_id>r1</report_id>` +
    `<date_range><begin>1700000000</begin><end>1700086400</end></date_range></report_metadata>` +
    `<policy_published><domain>example.com</domain><p>none</p><pct>100</pct></policy_published>` +
    records.map(recordXml).join("") +
    `</feedback>`
  );
}

const genReport = fc.tuple(fc.array(genRecord, { minLength: 1, maxLength: 12 }), xmlText);

// The reader's documented normalisation, restated independently.
const clamp = (n: number): number => Math.min(n, 1_000_000_000);
const passes = (r: GenRecord): boolean =>
  r.dkim.toLowerCase() === "pass" || r.spf.toLowerCase() === "pass";

// ── parseDmarcReport: typed errors only ─────────────────────────────────────

// Valid reports with random damage: splice a nasty token in, cut a range out.
const damagedXml = fc
  .tuple(
    genReport,
    fc.array(fc.tuple(fc.nat(), fc.nat({ max: 40 }), nastyString(3)), { maxLength: 4 }),
  )
  .map(([[records, org], edits]) =>
    edits.reduce(
      (xml, [at, cut, insert]) => {
        const i = at % (xml.length + 1);
        return xml.slice(0, i) + insert + xml.slice(i + cut);
      },
      reportXml(records, org),
    ),
  );

// Deep nesting inside a field the reader extracts text from.
const nestedXml = fc
  .tuple(
    fc.integer({ min: 1, max: 20_000 }),
    fc.constantFrom("domain", "org_name", "source_ip"),
    fc.constantFrom("a", "b", "x"),
  )
  .map(([depth, field, tag]) => {
    const bomb = `<${tag}>`.repeat(depth) + "v" + `</${tag}>`.repeat(depth);
    const meta = field === "org_name" ? `<org_name>${bomb}</org_name>` : "<org_name>o</org_name>";
    const dom = field === "domain" ? `<domain>${bomb}</domain>` : "<domain>example.com</domain>";
    const ip =
      field === "source_ip" ? `<source_ip>${bomb}</source_ip>` : "<source_ip>192.0.2.1</source_ip>";
    return (
      `<feedback><report_metadata>${meta}</report_metadata><policy_published>${dom}</policy_published>` +
      `<record><row>${ip}<count>1</count></row></record></feedback>`
    );
  });

describe("parseDmarcReport (lib/dmarc/report.ts)", () => {
  it("returns a report or throws DmarcParseError -- never any other error", () => {
    fc.assert(
      fc.property(fc.oneof(anyString(300), nastyString(), damagedXml, nestedXml), (xml) => {
        let report: DmarcReport;
        try {
          report = parseDmarcReport(xml);
        } catch (e) {
          expect(e).toBeInstanceOf(DmarcParseError);
          return;
        }
        expect(report.records.length).toBeGreaterThan(0);
        for (const r of report.records) {
          expect(Number.isInteger(r.count)).toBe(true);
          expect(r.count).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("reads back every generated record, and the summary partitions every message", () => {
    fc.assert(
      fc.property(fc.array(genReport, { minLength: 1, maxLength: 3 }), (reports) => {
        const parsed = reports.map(([records, org]) => parseDmarcReport(reportXml(records, org)));
        const all = reports.flatMap(([records]) => records);
        parsed.forEach((p, i) => {
          expect(p.records.map((r) => r.count)).toEqual(reports[i][0].map((r) => clamp(r.count)));
        });

        const s = summarizeReports(parsed);
        const total = all.reduce((sum, r) => sum + clamp(r.count), 0);
        expect(s.totalMessages).toBe(total);
        expect(s.dmarcPass).toBe(all.filter(passes).reduce((sum, r) => sum + clamp(r.count), 0));
        expect(s.dmarcPass + s.dmarcFail).toBe(total);
        expect(s.delivered + s.quarantined + s.rejected).toBe(total);
        expect(s.dkimAlignedPass).toBeLessThanOrEqual(s.dmarcPass);
        expect(s.spfAlignedPass).toBeLessThanOrEqual(s.dmarcPass);
        expect(s.sources.reduce((sum, src) => sum + src.total, 0)).toBe(total);
        for (const src of s.sources) {
          expect(src.dmarcPass + src.dmarcFail).toBe(src.total);
          expect(src.delivered + src.quarantined + src.rejected).toBe(src.total);
        }
        // One source per distinct IP, however hostile the IP string.
        const ips = new Set(all.map((r) => r.sourceIp.trim() || "unknown"));
        expect(s.sources.length).toBe(ips.size);
      }),
    );
  });
});

// ── decompressToXml: typed errors only, and lossless on real archives ───────

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/** A single-entry zip, stored (0) or deflated (8). No CRC: the reader ignores it. */
function zipOf(name: string, content: Uint8Array, method: 0 | 8): Uint8Array {
  const data = method === 8 ? new Uint8Array(deflateRawSync(content)) : content;
  const nameB = [...new TextEncoder().encode(name)];
  const sizes = [...u32(0), ...u32(data.length), ...u32(content.length)];
  const local = [
    ...u32(0x04034b50),
    ...u16(20),
    ...u16(0),
    ...u16(method),
    ...u16(0),
    ...u16(0),
    ...sizes,
    ...u16(nameB.length),
    ...u16(0),
    ...nameB,
    ...data,
  ];
  const central = [
    ...u32(0x02014b50),
    ...u16(20),
    ...u16(20),
    ...u16(0),
    ...u16(method),
    ...u16(0),
    ...u16(0),
    ...sizes,
    ...u16(nameB.length),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u16(0),
    ...u32(0),
    ...u32(0),
    ...nameB,
  ];
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(1),
    ...u16(1),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0),
  ];
  return new Uint8Array([...local, ...central, ...eocd]);
}

const xmlBytes = genReport.map(([records, org]) =>
  new TextEncoder().encode(reportXml(records, org)),
);
const archive = fc.oneof(
  xmlBytes.map((b) => new Uint8Array(gzipSync(b))),
  fc.tuple(xmlBytes, fc.constantFrom<0 | 8>(0, 8)).map(([b, m]) => zipOf("report.xml", b, m)),
);
// Real archives with bytes overwritten at random offsets: the hand-rolled zip
// reader must bounds-check every length and offset it reads.
// Offsets are biased to the first 40 and last 120 bytes, where the local
// header, central directory and end-of-central-directory record live --
// uniform offsets would almost always land in the compressed payload.
const corruptAt = fc.oneof(
  fc.nat().map((n) => ({ fromEnd: false, n })),
  fc.nat(40).map((n) => ({ fromEnd: false, n })),
  fc.integer({ min: 1, max: 120 }).map((n) => ({ fromEnd: true, n })),
);
const corrupted = fc
  .tuple(
    archive,
    fc.array(fc.tuple(corruptAt, fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 8 }),
  )
  .map(([bytes, edits]) => {
    const out = bytes.slice();
    for (const [{ fromEnd, n }, value] of edits) {
      const i = fromEnd ? Math.max(0, out.length - n) : n % out.length;
      out[i] = value;
    }
    return out;
  });
const zipMagic = fc
  .uint8Array({ maxLength: 200 })
  .map((tail) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...tail]));

describe("decompressToXml (lib/dmarc/decompress.ts)", () => {
  it("resolves to XML text or rejects with DmarcDecompressError -- never any other error", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.uint8Array({ maxLength: 300 }), zipMagic, corrupted),
        async (bytes) => {
          let xml: string;
          try {
            xml = await decompressToXml(bytes);
          } catch (e) {
            expect(e).toBeInstanceOf(DmarcDecompressError);
            return;
          }
          expect(xml.trimStart().startsWith("<")).toBe(true);
        },
      ),
    );
  });

  it("returns exactly the XML that was gzipped or zipped", async () => {
    await fc.assert(
      fc.asyncProperty(
        genReport,
        fc.constantFrom("gzip", "stored", "deflate"),
        async ([records, org], kind) => {
          const xml = reportXml(records, org);
          const raw = new TextEncoder().encode(xml);
          const bytes =
            kind === "gzip"
              ? new Uint8Array(gzipSync(raw))
              : zipOf("r.xml", raw, kind === "stored" ? 0 : 8);
          expect(await decompressToXml(bytes)).toBe(xml);
        },
      ),
    );
  });
});
