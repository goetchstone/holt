-- GAP-27: a signed-in session ends after the store's idle time.
--
--   AppSettings.idleLogoffMinutes  minutes without activity before a session
--                                  ends: 5 to 720, or 0 for never. 15, the
--                                  default, is the strict one.
ALTER TABLE "AppSettings" ADD COLUMN "idleLogoffMinutes" INTEGER NOT NULL DEFAULT 15;

-- The settings route refuses anything else; this is the floor under it.
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_idleLogoffMinutes_range"
  CHECK ("idleLogoffMinutes" = 0 OR ("idleLogoffMinutes" >= 5 AND "idleLogoffMinutes" <= 720));
