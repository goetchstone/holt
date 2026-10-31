// /app/src/types/next-auth.d.ts
import NextAuth, { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
    /** The store's automatic sign-out time in minutes, 0 = off (lib/auth/idleLogoff.ts). */
    idleLogoffMinutes?: number;
  }

  interface User {
    id: string;
  }
}
