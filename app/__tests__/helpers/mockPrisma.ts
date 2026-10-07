// /app/__tests__/helpers/mockPrisma.ts
//
// Shared Prisma mock setup for API integration tests.
// Provides a typed mock of the Prisma client singleton.

import { prisma } from "@/lib/prisma";

// Mock the Prisma singleton module
jest.mock("@/lib/prisma", () => ({
  prisma: {
    vendor: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    product: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
    },
    vendorStyle: {
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    priceList: {
      upsert: jest.fn(),
    },
    vendorPriceDimension: {
      upsert: jest.fn(),
    },
    priceDimensionTier: {
      upsert: jest.fn(),
    },
    staffMember: {
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $queryRaw: jest.fn(),
  },
}));

export const prismaMock = prisma as unknown as jest.Mocked<typeof prisma>;
