-- Single-use password-reset tokens for local-account staff. Only the SHA-256
-- hash of the raw token is stored; expiry 1h; consumed once.

CREATE TABLE "PasswordResetToken" (
    "id" SERIAL NOT NULL,
    "staffMemberId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_staffMemberId_idx" ON "PasswordResetToken"("staffMemberId");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_staffMemberId_fkey"
  FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
