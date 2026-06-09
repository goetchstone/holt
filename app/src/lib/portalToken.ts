// /app/src/lib/portalToken.ts

import jwt from "jsonwebtoken";

interface PortalTokenPayload {
  orderId: number;
  customerId: number;
}

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is not configured");
  }
  return secret;
}

export function generatePortalToken(orderId: number, customerId: number): string {
  return jwt.sign({ orderId, customerId }, getSecret(), { expiresIn: "7d" });
}

export function verifyPortalToken(token: string): PortalTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret()) as PortalTokenPayload;
    if (typeof decoded.orderId !== "number" || typeof decoded.customerId !== "number") {
      return null;
    }
    return { orderId: decoded.orderId, customerId: decoded.customerId };
  } catch {
    return null;
  }
}
