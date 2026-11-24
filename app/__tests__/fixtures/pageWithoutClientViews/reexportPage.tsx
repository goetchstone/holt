// /app/__tests__/fixtures/pageWithoutClientViews/reexportPage.tsx
//
// A server page whose client module hides its names behind `export *`, which
// pageWithoutClientViews refuses rather than stub (pageWithoutClientViews.test.ts).

import { ClientView } from "./ReexportedView";

export default async function ReexportPage() {
  return <ClientView label="Ada" />;
}
