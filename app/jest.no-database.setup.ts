// /app/jest.no-database.setup.ts
//
// setupFiles for the unit and performance projects. They have no database, so
// they get no database URL, whatever the shell running them exports.
//
// app/.env.local's DATABASE_URL is the developer's own database. Exported into
// a shell that then ran the unit suite (as the pre-push hook does), it let a
// unit test's error recorder write rows there (2026-10-01). Only the
// integration project gets a URL, and its globalSetup points it at
// fbc_test_db (jest.integration.setup.ts).
for (const name of Object.keys(process.env)) {
  if (/DATABASE_URL$/.test(name)) delete process.env[name];
}
