// /app/__tests__/dmarcReport.test.ts
// Fixtures are PII-free but structurally faithful to real reports observed from
// Google, Microsoft, Yahoo/AT&T, Rackspace, and Mimecast — every quirk those
// providers exhibit is represented (child-order variance, optional fields,
// multiple/zero auth entries, self-closing elements, namespaces, trailing
// whitespace). IPs use RFC 5737 documentation ranges; domains use example.com.

import {
  parseDmarcReport,
  summarizeReports,
  DmarcParseError,
} from "@/lib/dmarc/report";
import {
  decompressToXml,
  DmarcDecompressError,
} from "@/lib/dmarc/decompress";

// Microsoft-style: namespaces on <feedback>, <version>, sp+fo, dkim children
// ordered domain/selector/result, envelope_to/from present, IPv6 source.
const MICROSOFT = `<?xml version="1.0"?>
<feedback xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <version>1.0</version>
  <report_metadata>
    <org_name>Enterprise Outlook</org_name>
    <email>dmarcreport@example.com</email>
    <report_id>abc123</report_id>
    <date_range><begin>1780790400</begin><end>1780876800</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain><adkim>r</adkim><aspf>r</aspf>
    <p>quarantine</p><sp>quarantine</sp><pct>100</pct><fo>0</fo>
  </policy_published>
  <record>
    <row>
      <source_ip>2001:db8::1</source_ip><count>5</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><envelope_to>dest.example</envelope_to><envelope_from>example.com</envelope_from><header_from>example.com</header_from></identifiers>
    <auth_results>
      <dkim><domain>example.com</domain><selector>google</selector><result>pass</result></dkim>
      <spf><domain>example.com</domain><scope>mfrom</scope><result>pass</result></spf>
    </auth_results>
  </record>
</feedback>`;

// Google-style: encoding decl, <np>, dkim children ordered domain/result/selector
// (note: different order from Microsoft), multiple <dkim>, plus a record with
// ZERO dkim that fails SPF with permerror and gets quarantined, large counts.
const GOOGLE = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <version>1.0</version>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <extra_contact_info>https://support.google.com/a/answer/2466580</extra_contact_info>
    <report_id>12269941154616625509</report_id>
    <date_range><begin>1780876800</begin><end>1780963199</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain><adkim>r</adkim><aspf>r</aspf>
    <p>quarantine</p><sp>quarantine</sp><pct>100</pct><np>quarantine</np>
  </policy_published>
  <record>
    <row>
      <source_ip>198.51.100.10</source_ip><count>100</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results>
      <dkim><domain>mandrillapp.com</domain><result>pass</result><selector>mte1</selector></dkim>
      <dkim><domain>example.com</domain><result>pass</result><selector>k2</selector></dkim>
      <spf><domain>mandrillapp.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>203.0.113.99</source_ip><count>4</count>
      <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results>
      <spf><domain>example.com</domain><result>permerror</result></spf>
    </auth_results>
  </record>
</feedback>`;

// Yahoo/AT&T-style: trailing tabs on every line, no <version>, header_from only,
// multiple <dkim>, <spf> WITHOUT <scope>.
const YAHOO = `<?xml version="1.0"?>\t
<feedback>\t
  <report_metadata>\t
    <org_name>Yahoo</org_name>\t
    <email>dmarchelp@yahooinc.com</email>\t
    <report_id>1780983896.639748</report_id>\t
    <date_range><begin>1780876800</begin><end>1780963199</end></date_range>\t
  </report_metadata>\t
  <policy_published>\t
    <domain>example.com</domain><adkim>r</adkim><aspf>r</aspf><p>quarantine</p><pct>100</pct>\t
  </policy_published>\t
  <record>\t
    <row>\t
      <source_ip>198.51.100.50</source_ip><count>1</count>\t
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated>\t
    </row>\t
    <identifiers><header_from>example.com</header_from></identifiers>\t
    <auth_results>\t
      <dkim><domain>fbl.mcsv.net</domain><selector>k1</selector><result>pass</result></dkim>\t
      <dkim><domain>example.com</domain><selector>k3</selector><result>pass</result></dkim>\t
      <spf><domain>mail156.example.net</domain><result>pass</result></spf>\t
    </auth_results>\t
  </record>\t
</feedback>`;

// Mimecast-style: standalone="yes", self-closing <human_result/> inside dkim.
const MIMECAST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<feedback>
  <report_metadata>
    <org_name>Mimecast</org_name><email>dmarc@mimecast.org</email>
    <extra_contact_info>https://community.mimecast.com/s/knowledge</extra_contact_info>
    <report_id>mc-1</report_id>
    <date_range><begin>1780876800</begin><end>1780963199</end></date_range>
  </report_metadata>
  <policy_published><domain>example.com</domain><adkim>r</adkim><aspf>r</aspf><p>quarantine</p><sp>quarantine</sp><pct>100</pct></policy_published>
  <record>
    <row><source_ip>198.51.100.60</source_ip><count>1</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results>
      <dkim><domain>example.com</domain><selector>google</selector><result>pass</result><human_result/></dkim>
      <spf><domain>example.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
</feedback>`;

// Rackspace-style: <spf> BEFORE <dkim> in auth_results (order independence).
const RACKSPACE = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata><org_name>emailsrvr.com</org_name><email>dmarc_reports@emailsrvr.com</email>
    <report_id>rs-1</report_id><date_range><begin>1780876800</begin><end>1780963200</end></date_range></report_metadata>
  <policy_published><domain>example.com</domain><adkim>r</adkim><aspf>r</aspf><p>quarantine</p><sp>quarantine</sp><pct>100</pct></policy_published>
  <record>
    <row><source_ip>198.51.100.70</source_ip><count>2</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results>
      <spf><domain>example.com</domain><result>pass</result></spf>
      <dkim><domain>example.com</domain><result>pass</result></dkim>
    </auth_results>
  </record>
</feedback>`;

describe("parseDmarcReport — real-world structural variations", () => {
  it("parses Microsoft-style (namespaces, version, sp/fo, IPv6, dkim order domain/selector/result)", () => {
    const r = parseDmarcReport(MICROSOFT);
    expect(r.orgName).toBe("Enterprise Outlook");
    expect(r.policy.domain).toBe("example.com");
    expect(r.policy.sp).toBe("quarantine");
    expect(r.policy.fo).toBe("0");
    expect(r.records).toHaveLength(1);
    const rec = r.records[0]!;
    expect(rec.sourceIp).toBe("2001:db8::1");
    expect(rec.count).toBe(5);
    expect(rec.authDkim[0]).toMatchObject({ domain: "example.com", selector: "google", result: "pass" });
    expect(rec.envelopeTo).toBe("dest.example");
  });

  it("parses Google-style (np, dkim order domain/result/selector, multiple dkim, zero-dkim record)", () => {
    const r = parseDmarcReport(GOOGLE);
    expect(r.policy.np).toBe("quarantine");
    expect(r.extraContactInfo).toContain("support.google.com");
    expect(r.records).toHaveLength(2);
    expect(r.records[0]!.authDkim).toHaveLength(2);
    expect(r.records[0]!.authDkim[0]).toMatchObject({ domain: "mandrillapp.com", selector: "mte1", result: "pass" });
    // the quarantined, zero-dkim, spf-permerror record
    const bad = r.records[1]!;
    expect(bad.authDkim).toHaveLength(0);
    expect(bad.disposition).toBe("quarantine");
    expect(bad.authSpf[0]!.result).toBe("permerror");
  });

  it("parses Yahoo/AT&T-style (trailing tabs, no version, header_from only, multiple dkim, spf without scope)", () => {
    const r = parseDmarcReport(YAHOO);
    expect(r.orgName).toBe("Yahoo");
    const rec = r.records[0]!;
    expect(rec.envelopeFrom).toBeUndefined();
    expect(rec.headerFrom).toBe("example.com");
    expect(rec.authDkim).toHaveLength(2);
    expect(rec.authSpf[0]!.scope).toBeUndefined();
  });

  it("parses Mimecast-style (standalone, self-closing human_result)", () => {
    const r = parseDmarcReport(MIMECAST);
    expect(r.records[0]!.authDkim[0]).toMatchObject({ selector: "google", result: "pass" });
  });

  it("parses Rackspace-style (spf before dkim — order independent)", () => {
    const r = parseDmarcReport(RACKSPACE);
    const rec = r.records[0]!;
    expect(rec.authSpf).toHaveLength(1);
    expect(rec.authDkim).toHaveLength(1);
  });
});

describe("parseDmarcReport — rejection / safety", () => {
  it("rejects empty input", () => {
    expect(() => parseDmarcReport("")).toThrow(DmarcParseError);
  });
  it("rejects a DOCTYPE/ENTITY payload (XXE / billion-laughs)", () => {
    expect(() => parseDmarcReport('<!DOCTYPE feedback [<!ENTITY x "y">]><feedback></feedback>')).toThrow(/document-type/i);
  });
  it("rejects non-feedback XML", () => {
    expect(() => parseDmarcReport("<html><body>nope</body></html>")).toThrow(/DMARC aggregate report/i);
  });
  it("rejects feedback without required children", () => {
    expect(() => parseDmarcReport("<feedback></feedback>")).toThrow(DmarcParseError);
  });
  it("does not pollute Object.prototype via crafted element names", () => {
    const evil = `<feedback><report_metadata><org_name>x</org_name><date_range><begin>1</begin><end>2</end></date_range></report_metadata><policy_published><domain>example.com</domain></policy_published><record><row><source_ip>198.51.100.1</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers><auth_results><__proto__>polluted</__proto__></auth_results></record></feedback>`;
    parseDmarcReport(evil);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("clamps a negative/garbage count to 0", () => {
    const xml = MICROSOFT.replace("<count>5</count>", "<count>-9</count>");
    expect(parseDmarcReport(xml).records[0]!.count).toBe(0);
  });
});

describe("summarizeReports — aggregation correctness", () => {
  it("aggregates weighted by count and flags failing sources", () => {
    const reports = [MICROSOFT, GOOGLE, YAHOO, MIMECAST, RACKSPACE].map(parseDmarcReport);
    const s = summarizeReports(reports);
    // counts: MS 5, Google 100+4, Yahoo 1, Mimecast 1, Rackspace 2 = 113
    expect(s.totalMessages).toBe(113);
    // only the Google permerror record (count 4) is a DMARC fail (both eval fail)
    expect(s.dmarcFail).toBe(4);
    expect(s.dmarcPass).toBe(109);
    expect(s.quarantined).toBe(4);
    expect(s.rejected).toBe(0);
    // the quarantined source is flagged
    expect(s.failingSources.some((f) => f.sourceIp === "203.0.113.99" && f.quarantined === 4)).toBe(true);
    // selector discovery surfaces the selectors seen
    expect(s.selectorsSeen).toEqual(expect.arrayContaining(["google", "k2", "k3", "mte1", "k1"]));
    // top source is Google's 100-count sender
    expect(s.sources[0]!.sourceIp).toBe("198.51.100.10");
    expect(s.sources[0]!.total).toBe(100);
  });

  it("treats DMARC pass as (aligned DKIM pass OR aligned SPF pass)", () => {
    // Google record 1: eval dkim pass, eval spf fail -> still a DMARC pass
    const s = summarizeReports([parseDmarcReport(GOOGLE)]);
    expect(s.dmarcPass).toBe(100);
    expect(s.spfAlignedPass).toBe(0);
    expect(s.dkimAlignedPass).toBe(100);
  });
});

describe("decompressToXml — format handling & safety", () => {
  async function gzip(text: string): Promise<Uint8Array> {
    const cs = new CompressionStream("gzip");
    const stream = new Blob([text]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  it("passes raw XML through (with BOM stripped)", async () => {
    const out = await decompressToXml(new TextEncoder().encode("﻿" + MICROSOFT));
    expect(out.startsWith("<?xml")).toBe(true);
  });

  it("decompresses gzip and the result parses", async () => {
    const gz = await gzip(GOOGLE);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    const xml = await decompressToXml(gz);
    expect(parseDmarcReport(xml).records).toHaveLength(2);
  });

  it("rejects empty input", async () => {
    await expect(decompressToXml(new Uint8Array(0))).rejects.toThrow(DmarcDecompressError);
  });

  it("rejects oversized input before any work", async () => {
    await expect(decompressToXml(new Uint8Array(6 * 1024 * 1024))).rejects.toThrow(/too large/i);
  });

  it("rejects non-archive, non-XML bytes", async () => {
    await expect(decompressToXml(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(DmarcDecompressError);
  });

  it("rejects a doubly-gzipped payload (no recursion)", async () => {
    const doubled = await gzip("");
    const gzOfGz = await gzip(new TextDecoder("latin1").decode(doubled));
    // the inner decompress yields gzip-magic bytes -> rejected as doubly compressed
    // (best-effort: ensure decompress never recurses and either rejects clean)
    await expect(decompressToXml(gzOfGz)).rejects.toThrow(DmarcDecompressError);
  });
});

// ── Zip path: build real single/multi-entry zips and exercise the hand-rolled
// central-directory parser (stored + deflate), the security caps, and rejects.

const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const strBytes = (s: string) => [...new TextEncoder().encode(s)];

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface ZipSpec {
  name: string;
  content: string;
  method: 0 | 8;
  zip64?: boolean; // force a Zip64 sentinel into the central-directory size
}

async function makeZip(specs: ZipSpec[]): Promise<Uint8Array> {
  const built = await Promise.all(
    specs.map(async (s) => {
      const raw = new TextEncoder().encode(s.content);
      const data = s.method === 8 ? await deflateRaw(raw) : raw;
      return { ...s, raw, data, comp: data.length, uncomp: raw.length };
    })
  );

  const locals: number[] = [];
  const localOffsets: number[] = [];
  for (const b of built) {
    const nameB = strBytes(b.name);
    localOffsets.push(locals.length);
    locals.push(
      ...u32le(0x04034b50), ...u16le(20), ...u16le(0), ...u16le(b.method),
      ...u16le(0), ...u16le(0), ...u32le(0), ...u32le(b.comp), ...u32le(b.uncomp),
      ...u16le(nameB.length), ...u16le(0), ...nameB, ...b.data
    );
  }

  const cdStart = locals.length;
  const central: number[] = [];
  built.forEach((b, i) => {
    const nameB = strBytes(b.name);
    central.push(
      ...u32le(0x02014b50), ...u16le(20), ...u16le(20), ...u16le(0), ...u16le(b.method),
      ...u16le(0), ...u16le(0), ...u32le(0),
      ...u32le(b.comp), ...u32le(b.zip64 ? 0xffffffff : b.uncomp),
      ...u16le(nameB.length), ...u16le(0), ...u16le(0), ...u16le(0), ...u16le(0),
      ...u32le(0), ...u32le(localOffsets[i]!), ...nameB
    );
  });

  const eocd = [
    ...u32le(0x06054b50), ...u16le(0), ...u16le(0),
    ...u16le(built.length), ...u16le(built.length),
    ...u32le(central.length), ...u32le(cdStart), ...u16le(0),
  ];

  return new Uint8Array([...locals, ...central, ...eocd]);
}

describe("decompressToXml — zip handling (hand-rolled central-directory parser)", () => {
  const REPORT = MICROSOFT;

  it("extracts a stored (method 0) .xml entry", async () => {
    const zip = await makeZip([{ name: "report.xml", content: REPORT, method: 0 }]);
    expect(zip[0]).toBe(0x50); // PK
    const xml = await decompressToXml(zip);
    expect(parseDmarcReport(xml).orgName).toBe("Enterprise Outlook");
  });

  it("extracts a deflate (method 8) .xml entry", async () => {
    const zip = await makeZip([{ name: "report.xml", content: GOOGLE, method: 8 }]);
    const xml = await decompressToXml(zip);
    expect(parseDmarcReport(xml).records).toHaveLength(2);
  });

  it("selects the .xml entry from a multi-entry zip", async () => {
    const zip = await makeZip([
      { name: "readme.txt", content: "ignore me", method: 0 },
      { name: "report.xml", content: REPORT, method: 8 },
    ]);
    const xml = await decompressToXml(zip);
    expect(parseDmarcReport(xml).orgName).toBe("Enterprise Outlook");
  });

  it("rejects a zip with no .xml entry", async () => {
    const zip = await makeZip([{ name: "notes.txt", content: "nope", method: 0 }]);
    await expect(decompressToXml(zip)).rejects.toThrow(/no \.xml/i);
  });

  it("rejects a zip with too many entries", async () => {
    const specs: ZipSpec[] = Array.from({ length: 17 }, (_, i) => ({
      name: `f${i}.dat`,
      content: "x",
      method: 0 as const,
    }));
    const zip = await makeZip(specs);
    await expect(decompressToXml(zip)).rejects.toThrow(/too many/i);
  });

  it("rejects a Zip64 sentinel size rather than misreading it", async () => {
    const zip = await makeZip([{ name: "report.xml", content: REPORT, method: 0, zip64: true }]);
    await expect(decompressToXml(zip)).rejects.toThrow(DmarcDecompressError);
  });

  it("rejects a zip whose .xml entry is itself an archive (no recursion)", async () => {
    // stored entry whose bytes start with PK -> decompressed payload is archive magic
    const zip = await makeZip([{ name: "report.xml", content: "PK not xml", method: 0 }]);
    await expect(decompressToXml(zip)).rejects.toThrow(DmarcDecompressError);
  });

  it("rejects truncated zip bytes without crashing", async () => {
    const zip = await makeZip([{ name: "report.xml", content: REPORT, method: 8 }]);
    const truncated = zip.slice(0, Math.floor(zip.length / 2));
    await expect(decompressToXml(truncated)).rejects.toThrow(DmarcDecompressError);
  });
});

describe("parseDmarcReport — record cap & override reasons", () => {
  it("truncates at MAX_RECORDS and flags it", () => {
    const recordXml = `<record><row><source_ip>198.51.100.1</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers><auth_results><dkim><domain>example.com</domain><result>pass</result></dkim></auth_results></record>`;
    const xml = `<feedback><report_metadata><org_name>x</org_name><email>x@example.com</email><report_id>1</report_id><date_range><begin>1</begin><end>2</end></date_range></report_metadata><policy_published><domain>example.com</domain><p>none</p></policy_published>${recordXml.repeat(5001)}</feedback>`;
    const r = parseDmarcReport(xml);
    expect(r.recordsTruncated).toBe(true);
    expect(r.records).toHaveLength(5000);
  });

  it("aggregates policy_override reasons weighted by count", () => {
    const xml = `<feedback><report_metadata><org_name>x</org_name><email>x@example.com</email><report_id>1</report_id><date_range><begin>1</begin><end>2</end></date_range></report_metadata><policy_published><domain>example.com</domain><p>reject</p></policy_published><record><row><source_ip>198.51.100.9</source_ip><count>7</count><policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>fail</spf><reason><type>forwarded</type><comment>fwd</comment></reason></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers><auth_results><spf><domain>example.com</domain><result>fail</result></spf></auth_results></record></feedback>`;
    const s = summarizeReports([parseDmarcReport(xml)]);
    expect(s.overrideReasons).toEqual([{ type: "forwarded", count: 7 }]);
    // failing-but-delivered: both eval fail, disposition none -> dmarcFail but delivered
    expect(s.dmarcFail).toBe(7);
    expect(s.delivered).toBe(7);
  });
});
