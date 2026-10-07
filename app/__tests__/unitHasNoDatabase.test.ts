// /app/__tests__/unitHasNoDatabase.test.ts
//
// A unit test has no database, so no database URL reaches it, even when the
// shell running the suite exported one (jest.no-database.setup.ts). The
// pre-push hook runs this suite; on 2026-10-01 an exported DATABASE_URL let a
// unit test's error recorder write into the developer's own database.

it("runs without any database URL, whatever the shell exported", () => {
  expect(Object.keys(process.env).filter((name) => /DATABASE_URL$/.test(name))).toEqual([]);
});
