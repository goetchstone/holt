// __tests__/practiceCopy.test.ts
//
// What makes a copy practice (GAP-28): the database's name, and nothing else. The
// near misses matter most: a name that only nearly says practice might be live.

import { databaseNameFromUrl, isPracticeCopy, isPracticeDatabaseName } from "@/lib/practiceCopy";
import { mailchimpBaseUrl } from "@/lib/mailchimp/baseUrl";
import { seededStaffPassword, DEMO_STAFF_PASSWORD } from "../prisma/seed/demo/staff";
import { UnsafeSeedTargetError } from "../prisma/seed/demo/guard";
import { assertSafeSeedTarget } from "../prisma/seed/demo/guard";

const realUrl = process.env.DATABASE_URL;
afterEach(() => {
  process.env.DATABASE_URL = realUrl;
});

describe("isPracticeDatabaseName", () => {
  it.each(["practice", "holt_demo_practice", "practice_holt", "holt_practice_2", "HOLT_PRACTICE"])(
    "%s is practice",
    (name) => expect(isPracticeDatabaseName(name)).toBe(true),
  );

  it.each([
    "",
    "holt",
    "holt_demo",
    "fbc_test_db",
    "fbc_dev_db",
    "holt-practice",
    "practice2",
    "holt_practices",
    "impractice",
    "holtpractice",
  ])("%s is not", (name) => expect(isPracticeDatabaseName(name)).toBe(false));
});

describe("databaseNameFromUrl", () => {
  it("reads the name, leaving the query behind", () => {
    expect(databaseNameFromUrl("postgresql://u:p@db:5432/holt_demo_practice?schema=public")).toBe(
      "holt_demo_practice",
    );
  });
  it("isn't fooled by a password or host carrying the word", () => {
    expect(databaseNameFromUrl("postgresql://practice:practice@practice:5432/holt")).toBe("holt");
  });
  it("reads a name written with escapes as the name it is", () => {
    expect(databaseNameFromUrl("postgresql://u:p@db:5432/holt%5Fpractice")).toBe("holt_practice");
  });
  it("copes with a url that doesn't parse", () => {
    expect(databaseNameFromUrl("not a url/holt_practice?x=1")).toBe("holt_practice");
    expect(databaseNameFromUrl("")).toBe("");
  });
});

describe("isPracticeCopy", () => {
  it("goes by the database this process runs on", () => {
    process.env.DATABASE_URL = "postgresql://u:p@db:5432/holt_demo_practice";
    expect(isPracticeCopy()).toBe(true);
    process.env.DATABASE_URL = "postgresql://practice:practice@practice:5432/holt";
    expect(isPracticeCopy()).toBe(false);
  });
  it("isn't practice with no database", () => {
    delete process.env.DATABASE_URL;
    expect(isPracticeCopy()).toBe(false);
  });
});

describe("the seed on a practice database", () => {
  const practice = "postgresql://u:p@db:5432/holt_demo_practice";

  it("is allowed by the seed's own guard under the default name", () => {
    expect(assertSafeSeedTarget(practice, { forceUnsafe: false })).toBe("holt_demo_practice");
  });

  it("refuses the password this public repo documents", () => {
    expect(() => seededStaffPassword(practice, undefined)).toThrow(UnsafeSeedTargetError);
    expect(() => seededStaffPassword(practice, "   ")).toThrow(UnsafeSeedTargetError);
  });

  it("uses the one chosen", () => {
    expect(seededStaffPassword(practice, " chosen-for-practice ")).toBe("chosen-for-practice");
  });

  it("leaves every other database on the demo's", () => {
    expect(seededStaffPassword("postgresql://u:p@db:5432/holt_demo", "ignored")).toBe(
      DEMO_STAFF_PASSWORD,
    );
  });
});

describe("mailchimpBaseUrl", () => {
  it("is Mailchimp's host normally", () => {
    process.env.DATABASE_URL = "postgresql://u:p@db:5432/holt";
    expect(mailchimpBaseUrl("us21")).toBe("https://us21.api.mailchimp.com/3.0");
  });
  it("can't reach anything on a practice copy", () => {
    process.env.DATABASE_URL = "postgresql://u:p@db:5432/holt_practice";
    expect(new URL(mailchimpBaseUrl("us21")).hostname.endsWith(".invalid")).toBe(true);
  });
});
