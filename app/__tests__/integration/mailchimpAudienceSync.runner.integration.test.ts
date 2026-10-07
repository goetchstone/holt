// /app/__tests__/integration/mailchimpAudienceSync.runner.integration.test.ts
//
// Phase 0.6.3 conversion: mailchimp audience-sync runner. Replaces
// the C+ mocked-Prisma block in
// __tests__/mailchimpAudienceSync.runner.test.ts.
//
// What changes vs the mocked test:
// - Customer + mailchimpSyncedAt writes go through real Prisma against
//   fbc_test_db. The test asserts on actual row state after the sync.
// - axios STAYS mocked. We don't want CI to dirty a real Mailchimp
//   audience. The runner's interaction with Mailchimp's API is a
//   separate concern from the SQL behavior we want to verify here.

// Match the unit test: API key + audience must be set before module load.
// Both are set here (not relied on from the ambient env) so the suite is
// hermetic -- it failed in CI where MAILCHIMP_AUDIENCE_ID isn't present.
process.env.MAILCHIMP_API_KEY = "fake-us18";
process.env.MAILCHIMP_AUDIENCE_ID = "fake-audience";

import axios from "axios";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runCustomerAudienceSync } = require("@/lib/mailchimpAudienceSync");

beforeEach(async () => {
  await resetTestDb();
  jest.clearAllMocks();
  process.env.MAILCHIMP_API_KEY = "fake-us18";
  process.env.MAILCHIMP_AUDIENCE_ID = "fake-audience";
  // Default: succeed unless a test overrides.
  mockedAxios.put.mockResolvedValue({ status: 200, data: {} } as never);
  mockedAxios.isAxiosError = ((e: unknown) =>
    typeof e === "object" && e !== null && "isAxiosError" in e) as never;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Seed a customer who's eligible for audience sync (no mailchimpSyncedAt yet). */
async function seedEligibleCustomer(opts: {
  email: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  return prisma.customer.create({
    data: {
      email: opts.email,
      firstName: opts.firstName ?? null,
      lastName: opts.lastName ?? null,
      mailchimpSyncedAt: null,
    },
  });
}

describe("runCustomerAudienceSync (real DB)", () => {
  it("returns zero counts when no candidates exist", async () => {
    const result = await runCustomerAudienceSync({ limit: 10 });
    expect(result.scanned).toBe(0);
    expect(result.pushed).toBe(0);
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });

  it("dry run does not call axios or update DB", async () => {
    const c1 = await seedEligibleCustomer({ email: "alice@example.com", firstName: "Alice" });
    const c2 = await seedEligibleCustomer({ email: "bob@example.com", firstName: "Bob" });

    const result = await runCustomerAudienceSync({ limit: 10, dryRun: true });

    expect(result.scanned).toBe(2);
    expect(result.pushed).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(mockedAxios.put).not.toHaveBeenCalled();

    // DB unchanged.
    const after1 = await prisma.customer.findUnique({ where: { id: c1.id } });
    const after2 = await prisma.customer.findUnique({ where: { id: c2.id } });
    expect(after1?.mailchimpSyncedAt).toBeNull();
    expect(after2?.mailchimpSyncedAt).toBeNull();
  });

  it("invalid email is marked synced so it does not churn next run", async () => {
    const c = await seedEligibleCustomer({ email: "not-an-email" });

    const result = await runCustomerAudienceSync({ limit: 10 });

    expect(result.skippedInvalidEmail).toBe(1);
    expect(result.pushed).toBe(0);
    expect(mockedAxios.put).not.toHaveBeenCalled();

    // Real DB write — mailchimpSyncedAt now set.
    const reloaded = await prisma.customer.findUnique({ where: { id: c.id } });
    expect(reloaded?.mailchimpSyncedAt).not.toBeNull();
  });

  it("successful push records mailchimpSyncedAt timestamp", async () => {
    const c = await seedEligibleCustomer({ email: "real@example.com" });
    mockedAxios.put.mockResolvedValueOnce({ status: 200, data: {} } as never);

    const result = await runCustomerAudienceSync({ limit: 10 });

    expect(result.pushed).toBe(1);
    expect(result.errors.length).toBe(0);
    const [url, body] = mockedAxios.put.mock.calls[0];
    expect(url).toContain("/lists/");
    expect(url).toContain("/members/");
    expect((body as { status_if_new: string }).status_if_new).toBe("pending");

    const reloaded = await prisma.customer.findUnique({ where: { id: c.id } });
    expect(reloaded?.mailchimpSyncedAt).not.toBeNull();
  });

  it("push failure records error per customer without aborting the batch", async () => {
    const cOk1 = await seedEligibleCustomer({ email: "ok@example.com" });
    const cBroken = await seedEligibleCustomer({ email: "broken@example.com" });
    const cOk2 = await seedEligibleCustomer({ email: "alsoook@example.com" });
    mockedAxios.put
      .mockResolvedValueOnce({ status: 200, data: {} } as never)
      .mockRejectedValueOnce(
        Object.assign(new Error("400"), {
          isAxiosError: true,
          response: { status: 400, data: { detail: "Mailchimp says no" } },
        }) as never,
      )
      .mockResolvedValueOnce({ status: 200, data: {} } as never);

    const result = await runCustomerAudienceSync({ limit: 10 });

    expect(result.pushed).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].email).toBe("broken@example.com");

    // Two successful customers: timestamps written.
    const after1 = await prisma.customer.findUnique({ where: { id: cOk1.id } });
    const after2 = await prisma.customer.findUnique({ where: { id: cOk2.id } });
    expect(after1?.mailchimpSyncedAt).not.toBeNull();
    expect(after2?.mailchimpSyncedAt).not.toBeNull();

    // Failed customer: timestamp NOT written, so the next run retries.
    const broken = await prisma.customer.findUnique({ where: { id: cBroken.id } });
    expect(broken?.mailchimpSyncedAt).toBeNull();
  });

  it("respects limit parameter", async () => {
    // Seed more customers than the limit; assert only `limit` are scanned.
    for (let i = 0; i < 8; i++) {
      await seedEligibleCustomer({ email: `bulk-${i}@example.com` });
    }
    const result = await runCustomerAudienceSync({ limit: 5 });
    expect(result.scanned).toBe(5);
  });

  it("(REAL-DB) skips customers already synced", async () => {
    // The mock asserted the where clause included mailchimpSyncedAt:
    // null. This asserts the real query actually excludes synced
    // customers — covers a typo / column-rename regression the mock
    // can't catch.
    await prisma.customer.create({
      data: {
        email: "already@example.com",
        mailchimpSyncedAt: new Date("2026-04-01"),
      },
    });
    const result = await runCustomerAudienceSync({ limit: 10 });
    expect(result.scanned).toBe(0);
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });

  it("(REAL-DB) skips customers with NULL email", async () => {
    // Same — mock said `email: { not: null }`, this confirms Postgres
    // IS NULL semantics actually exclude the row.
    await prisma.customer.create({
      data: {
        email: null,
        firstName: "No",
        lastName: "Email",
      },
    });
    const result = await runCustomerAudienceSync({ limit: 10 });
    expect(result.scanned).toBe(0);
  });
});
