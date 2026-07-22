// /app/__tests__/dmarcCheck.test.ts
import {
  classifyDnsError,
  isDkimKeyRecord,
  parseTagRecord,
  findDmarcRecords,
  analyzeDmarc,
  analyzeMtaSts,
  analyzeTlsRpt,
  analyzeBimi,
  suggestedRecords,
} from "@/lib/dmarc/check";

/** TXT lookups come back as an array of records, each split into chunks. */
const txt = (...records: string[]): string[][] => records.map((r) => [r]);

describe("classifyDnsError", () => {
  it("treats NXDOMAIN / no-data as a genuinely missing record", () => {
    expect(classifyDnsError({ code: "ENOTFOUND" })).toBe("missing");
    expect(classifyDnsError({ code: "ENODATA" })).toBe("missing");
  });

  it("treats resolver failures as transient, never a verdict", () => {
    expect(classifyDnsError({ code: "ESERVFAIL" })).toBe("transient");
    expect(classifyDnsError({ code: "ETIMEOUT" })).toBe("transient");
    expect(classifyDnsError(new Error("boom"))).toBe("transient");
    expect(classifyDnsError(null)).toBe("transient");
  });
});

describe("isDkimKeyRecord", () => {
  it("accepts real DKIM key records", () => {
    expect(isDkimKeyRecord("v=DKIM1; k=rsa; p=MIGfMA0GCSq")).toBe(true);
    expect(isDkimKeyRecord("k=rsa; p=MIGfMA0GCSq")).toBe(true);
    expect(isDkimKeyRecord("v=DKIM1; p=")).toBe(true);
  });

  it("rejects unrelated TXT records at the probed name", () => {
    expect(isDkimKeyRecord("v=spf1 include:_spf.google.com -all")).toBe(false);
    expect(isDkimKeyRecord("google-site-verification=abc123")).toBe(false);
    expect(isDkimKeyRecord("")).toBe(false);
  });
});

describe("parseTagRecord", () => {
  it("parses tag=value pairs case-insensitively on the key", () => {
    const t = parseTagRecord("v=DMARC1; P=reject; pct=50");
    expect(t.v).toBe("DMARC1");
    expect(t.p).toBe("reject");
    expect(t.pct).toBe("50");
  });

  it("keeps '=' inside values and tolerates junk segments", () => {
    const t = parseTagRecord("v=BIMI1; l=https://x.test/l.svg?a=b; ; nonsense");
    expect(t.l).toBe("https://x.test/l.svg?a=b");
  });

  it("is not prototype-polluted by a hostile TXT record", () => {
    const t = parseTagRecord("__proto__=polluted; p=reject");
    expect(t.p).toBe("reject");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(t)).toBeNull();
  });
});

describe("analyzeDmarc", () => {
  it("reports missing when nothing is published", () => {
    expect(analyzeDmarc([]).status).toBe("missing");
    expect(analyzeDmarc([]).enforcing).toBe(false);
  });

  it("fails when more than one DMARC record exists (receivers ignore all)", () => {
    const a = analyzeDmarc(["v=DMARC1; p=reject", "v=DMARC1; p=none"]);
    expect(a.status).toBe("fail");
    expect(a.enforcing).toBe(false);
    expect(a.issues[0]).toMatch(/ignore all/i);
  });

  it("accepts a fully enforcing policy", () => {
    const a = analyzeDmarc(["v=DMARC1; p=reject; pct=100; rua=mailto:d@x.test"]);
    expect(a.status).toBe("ok");
    expect(a.enforcing).toBe(true);
    expect(a.pct).toBe(100);
  });

  it("defaults pct to 100 when the tag is absent", () => {
    expect(analyzeDmarc(["v=DMARC1; p=reject; rua=mailto:d@x.test"]).pct).toBe(100);
  });

  it("warns on p=none (monitoring only)", () => {
    const a = analyzeDmarc(["v=DMARC1; p=none; rua=mailto:d@x.test"]);
    expect(a.status).toBe("warn");
    expect(a.enforcing).toBe(false);
  });

  // The bug this whole change exists to kill: looks strong, enforces nothing.
  it("does not call p=reject with pct=0 enforcing", () => {
    const a = analyzeDmarc(["v=DMARC1; p=reject; pct=0; rua=mailto:d@x.test"]);
    expect(a.enforcing).toBe(false);
    expect(a.status).toBe("warn");
    expect(a.issues.join(" ")).toMatch(/pct=0/);
  });

  it("flags a strong policy undermined by sp=none", () => {
    const a = analyzeDmarc(["v=DMARC1; p=reject; sp=none; rua=mailto:d@x.test"]);
    expect(a.enforcing).toBe(false);
    expect(a.status).toBe("warn");
    expect(a.issues.join(" ")).toMatch(/subdomain/i);
  });

  it("warns when there is no reporting address", () => {
    const a = analyzeDmarc(["v=DMARC1; p=reject"]);
    expect(a.hasReporting).toBe(false);
    expect(a.status).toBe("warn");
  });

  it("fails a record with no policy tag", () => {
    expect(analyzeDmarc(["v=DMARC1; rua=mailto:d@x.test"]).status).toBe("fail");
  });
});

describe("findDmarcRecords", () => {
  it("picks out only v=DMARC1 records and joins chunked TXT", () => {
    const lookup = [["v=DMARC1; ", "p=reject"], ["some-other-verification=1"]];
    expect(findDmarcRecords(lookup)).toEqual(["v=DMARC1; p=reject"]);
  });

  it("returns nothing for a null lookup", () => {
    expect(findDmarcRecords(null)).toEqual([]);
  });
});

describe("MTA-STS / TLS-RPT / BIMI", () => {
  it("reports MTA-STS present vs missing, and flags a missing id", () => {
    expect(analyzeMtaSts(null).status).toBe("missing");
    expect(analyzeMtaSts(txt("v=STSv1; id=20260619T120000")).status).toBe("ok");
    expect(analyzeMtaSts(txt("v=STSv1;")).status).toBe("warn");
  });

  it("reports TLS-RPT, flagging a record with no destination", () => {
    expect(analyzeTlsRpt(null).status).toBe("missing");
    expect(analyzeTlsRpt(txt("v=TLSRPTv1; rua=mailto:t@x.test")).status).toBe("ok");
    expect(analyzeTlsRpt(txt("v=TLSRPTv1;")).status).toBe("warn");
  });

  it("reports BIMI, flagging a record with no logo", () => {
    expect(analyzeBimi(null).status).toBe("missing");
    expect(analyzeBimi(txt("v=BIMI1; l=https://x.test/l.svg")).status).toBe("ok");
    expect(analyzeBimi(txt("v=BIMI1;")).status).toBe("warn");
  });
});

describe("suggestedRecords", () => {
  const base = {
    domain: "x.test",
    provider: null as string | null,
    spfRecord: null as string | null,
    spfStatus: "ok" as const,
    dmarc: analyzeDmarc(["v=DMARC1; p=reject; rua=mailto:d@x.test"]),
    mtaSts: analyzeMtaSts(txt("v=STSv1; id=1")),
    tlsRpt: analyzeTlsRpt(txt("v=TLSRPTv1; rua=mailto:t@x.test")),
  };

  it("tailors a missing SPF record to the detected provider", () => {
    const r = suggestedRecords({ ...base, spfStatus: "missing", provider: "Google Workspace" });
    expect(r[0]!.name).toBe("x.test");
    expect(r[0]!.value).toBe("v=spf1 include:_spf.google.com ~all");
  });

  it("falls back to a placeholder include when the provider is unknown", () => {
    const r = suggestedRecords({ ...base, spfStatus: "missing" });
    expect(r[0]!.value).toMatch(/YOUR_MAIL_PROVIDER/);
  });

  it("rewrites an unsafe SPF qualifier in place", () => {
    const r = suggestedRecords({
      ...base,
      spfRecord: "v=spf1 include:_spf.google.com ?all",
      spfStatus: "warn",
    });
    expect(r[0]!.value).toBe("v=spf1 include:_spf.google.com ~all");
  });

  it("suggests a monitoring DMARC record when none exists", () => {
    const r = suggestedRecords({ ...base, dmarc: analyzeDmarc([]) });
    const rec = r.find((x) => x.name === "_dmarc.x.test");
    expect(rec?.value).toBe("v=DMARC1; p=none; rua=mailto:dmarc@x.test; fo=1");
  });

  it("suggests the enforcement step when the policy is p=none", () => {
    const r = suggestedRecords({
      ...base,
      dmarc: analyzeDmarc(["v=DMARC1; p=none; rua=mailto:d@x.test"]),
    });
    expect(r.find((x) => x.name === "_dmarc.x.test")?.value).toMatch(/p=quarantine/);
  });

  it("raises pct to 100 on a sampled enforcing policy", () => {
    const r = suggestedRecords({
      ...base,
      dmarc: analyzeDmarc(["v=DMARC1; p=reject; pct=10; rua=mailto:d@x.test"]),
    });
    expect(r.find((x) => x.name === "_dmarc.x.test")?.value).toMatch(/pct=100/);
  });

  it("offers TLS-RPT and MTA-STS records only when they're absent", () => {
    const none = suggestedRecords(base);
    expect(none.some((x) => x.name.startsWith("_smtp._tls"))).toBe(false);

    const r = suggestedRecords({
      ...base,
      tlsRpt: analyzeTlsRpt(null),
      mtaSts: analyzeMtaSts(null),
    });
    expect(r.find((x) => x.name === "_smtp._tls.x.test")?.value).toBe(
      "v=TLSRPTv1; rua=mailto:tls@x.test",
    );
    expect(r.find((x) => x.name === "_mta-sts.x.test")?.why).toMatch(/policy file/i);
  });
});
