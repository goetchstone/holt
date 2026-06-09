// /app/__tests__/helpers/mockSession.ts
//
// Shared NextAuth session mock for API integration tests.

import type { Session } from "next-auth";

export const mockManagerSession: Session = {
  user: {
    id: "user-1",
    name: "Test Manager",
    email: "manager@example.com",
  } as Session["user"] & { id: string },
  expires: new Date(Date.now() + 86400000).toISOString(),
};

export const mockDesignerSession: Session = {
  user: {
    id: "user-2",
    name: "Test Designer",
    email: "designer@example.com",
  } as Session["user"] & { id: string },
  expires: new Date(Date.now() + 86400000).toISOString(),
};

// Mock getServerSession to return a specific session
export function mockGetServerSession(session: Session | null) {
  jest.mock("next-auth", () => ({
    getServerSession: jest.fn().mockResolvedValue(session),
  }));
}
