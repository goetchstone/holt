// /app/__tests__/pageWithoutClientViews.test.ts
//
// The page-test helper (helpers/pageWithoutClientViews.ts), on a page of its own
// (fixtures/pageWithoutClientViews/). The page's client module throws the moment
// it loads, so the page importing at all shows the helper never loaded it. The
// element the page returns shows what stood in for each client export, and that
// the page's own server code ran for real.

import { join } from "path";
import type { ReactElement } from "react";
import { pageWithoutClientViews } from "./helpers/pageWithoutClientViews";

const FIXTURES = join(__dirname, "fixtures", "pageWithoutClientViews");
const CLIENT_MODULE = join(FIXTURES, "ClientView");

type Rendered = ReactElement<Record<string, unknown>>;
type Stubs = Record<string, (props: object) => unknown>;

async function renderFixturePage() {
  const Page = await pageWithoutClientViews(join(FIXTURES, "fixturePage"));
  const element = await Page({ params: Promise.resolve({ name: "Ada" }) });
  const [view, badge, grid] = element.props.children as Rendered[];
  return { element, view, badge, grid, stubs: jest.requireMock<Stubs>(CLIENT_MODULE) };
}

describe("pageWithoutClientViews", () => {
  it("is tried on a client module that throws when it loads", () => {
    expect(() => jest.requireActual(CLIENT_MODULE)).toThrow("ClientView was loaded");
  });

  it("imports the page without loading it, and renders a stub wherever the page rendered one of its exports", async () => {
    const { element, view, badge, stubs } = await renderFixturePage();
    expect(element.type).toBe(stubs.default);
    expect(view.type).toBe(stubs.ClientView);
    expect(view.props).toEqual({ label: "Ada" });
    expect(badge.type).toBe(stubs.ClientBadge);
  });

  it("stubs each runtime export, default included, and nothing for a type", async () => {
    const { stubs } = await renderFixturePage();
    expect(Object.keys(stubs).sort()).toEqual([
      "ClientBadge",
      "ClientView",
      "__esModule",
      "default",
    ]);
    for (const name of ["default", "ClientView", "ClientBadge"]) {
      expect({ name, stub: stubs[name].name, renders: stubs[name]({}) }).toEqual({
        name,
        stub: name,
        renders: null,
      });
    }
  });

  it("stubs a client component imported through @/ as well", async () => {
    const { grid } = await renderFixturePage();
    const cardGrid = jest.requireMock<{ default: unknown }>("@/components/layout/CardGrid");
    expect(grid.type).toBe(cardGrid.default);
    expect(grid.props).toEqual({ title: "Hub", items: [] });
  });

  it("runs the page's server modules for real, one that only mentions the directive included", async () => {
    const { element } = await renderFixturePage();
    expect(element.props.title).toBe("Hello, Ada");
  });

  it("refuses a client module whose names sit behind export *, rather than stub none of them", async () => {
    await expect(pageWithoutClientViews(join(FIXTURES, "reexportPage"))).rejects.toThrow(
      '"export *" from a client module',
    );
  });
});
