// /app/__tests__/clientApiRoutes.test.ts
//
// Every REST call a screen makes reaches a route, and that route answers the
// method. Rule 7 says a contract drift should be a compile error, but that holds
// only where a shared contract file exists: a REST answer reaches a screen as
// `any`, and nothing connects a screen's URL to a route file. So the customer edit
// form called a PUT its route never had (#77), and the house call form's address
// picker a GET that wasn't there. Both compiled, and both were found by accident.
//
// This is a manifest and a tripwire (rule 65). It fails in BOTH directions:
//   - a call that reaches no route, or a route that doesn't answer its method;
//   - a new call it can't read, which goes in fixtures/client-api-calls.txt with a
//     reason, or a row there that no longer describes anything: a stale manifest.
//
// What this does NOT see: which keys a screen reads from an answer, or sends (#78,
// #90). It reads source and calls nothing, so a route's methods are the ones its code
// compares `req.method` with. No git and no database: it parses files.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type ApiRoute,
  type ClientCall,
  displayUrl,
  findRoute,
  judge,
  parseApiStrings,
  parseClientCalls,
  parseRoute,
} from "./helpers/clientApiCalls";

const APP_DIR = join(__dirname, "..");
const ROUTE_TREES = ["src/pages/api", "src/app/api"];
/** Code that runs in a browser and calls REST. The last test keeps this complete. */
const CLIENT_CODE = [
  "src/app",
  "src/components",
  "src/hooks",
  "src/lib/hooks",
  "src/pages/auth",
  "src/lib/pricing/importVendorConfigs.ts",
  "src/lib/automations/catalog.ts",
];

// ---------------------------------------------------------------------------
// The reader: can this instrument disagree? (principle 4)
// ---------------------------------------------------------------------------

describe("reading a route's methods", () => {
  const methodsOf = (source: string, file = "src/pages/api/things.ts") => {
    const { methods } = parseRoute(file, source);
    return methods === "any" ? "any" : [...methods].sort();
  };

  it.each([
    ["a guard clause", `if (req.method !== "GET") return res.status(405).end();`, ["GET"]],
    [
      "branches",
      `if (req.method === "POST") {} else if (req.method === "PUT") {}`,
      ["POST", "PUT"],
    ],
    [
      "two guards",
      `if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();`,
      ["GET", "POST"],
    ],
    [
      "a switch",
      `switch (req.method) { case "GET": break; case "PATCH": break; }`,
      ["GET", "PATCH"],
    ],
    ["a destructured method", `const { method } = req; if (method === "GET") {}`, ["GET"]],
    ["a renamed method", `const verb = req.method; if (verb === "DELETE") {}`, ["DELETE"]],
    ["an allow list", `if (!["GET", "PUT"].includes(req.method!)) {}`, ["GET", "PUT"]],
    ["an assertion", `if ((req.method as string) === "POST") {}`, ["POST"]],
    [
      "a negation that isn't a refusal",
      `if (req.method !== "GET" && locked) return res.status(409).end(); if (req.method === "POST") {}`,
      ["POST"],
    ],
    [
      "a refusal by helper",
      `if (req.method !== "PUT") return methodNotAllowed(res, ["PUT"]);`,
      ["PUT"],
    ],
  ])("%s", (_label, body, expected) => {
    expect(methodsOf(`export default function h(req, res) { ${body} }`)).toEqual(expected);
  });

  it("a route that never looks at the method answers any", () => {
    expect(methodsOf(`export default function h(req, res) { res.json([]); }`)).toBe("any");
  });

  it("an App Router route answers what it exports by name", () => {
    const source = `export async function GET() {}\nconst x = 1;\nexport { x as POST };`;
    expect(methodsOf(source, "src/app/api/things/route.ts")).toEqual(["GET", "POST"]);
  });

  it.each([
    ["src/pages/api/things/index.ts", ["things"]],
    ["src/pages/api/things/[id].ts", ["things", "[id]"]],
    ["src/pages/api/things/route.ts", ["things", "route"]],
    ["src/app/api/things/[id]/route.ts", ["things", "[id]"]],
  ])("%s lives at %j", (file, segments) => {
    expect(parseRoute(file, "").segments).toEqual(segments);
  });
});

describe("judging a call", () => {
  const guard = (...methods: string[]) =>
    `export default function h(req, res) { ${methods.map((m) => `if (req.method === "${m}") {}`).join(" ")} }`;
  const routes: ApiRoute[] = [
    parseRoute("src/pages/api/customers/[id]/index.ts", guard("GET")),
    parseRoute("src/pages/api/customers/[id]/addresses.ts", guard("POST", "PUT", "DELETE")),
    parseRoute("src/pages/api/things/index.ts", guard("GET", "POST")),
    parseRoute("src/pages/api/things/[id].ts", guard("GET", "PUT")),
    parseRoute("src/pages/api/things/export.ts", guard("POST")),
    parseRoute("src/pages/api/files/[...path].ts", guard("GET")),
    parseRoute("src/pages/api/actions/run.ts", guard("POST")),
    parseRoute("src/pages/api/actions/stop.ts", guard("POST")),
    parseRoute("src/pages/api/open.ts", `export default function h(req, res) {}`),
  ];

  const verdicts = (body: string) =>
    parseClientCalls("src/app/View.tsx", body).map((call) => {
      const verdict = judge(call, routes);
      return `${call.method} ${call.url && displayUrl(call.url)}: ${verdict.status}`;
    });

  it("catches #77: a PUT at a route that only answers GET", () => {
    expect(verdicts("axios.put(`/api/customers/${id}`, form);")).toEqual([
      "PUT /api/customers/${…}: no-method",
    ]);
  });

  it("catches the house call form: a GET at a route with no GET", () => {
    expect(verdicts("axios.get(`/api/customers/${id}/addresses`);")).toEqual([
      "GET /api/customers/${…}/addresses: no-method",
    ]);
  });

  it("catches a path with no route, and passes one that has it", () => {
    expect(verdicts(`axios.get("/api/nothing/here"); axios.get("/api/things");`)).toEqual([
      "GET /api/nothing/here: no-route",
      "GET /api/things: ok",
    ]);
  });

  it("reads fetch's method from its options, and GET when there's none", () => {
    expect(
      verdicts(`
        fetch("/api/things");
        fetch("/api/things", { method: "POST", body });
        fetch("/api/things", { method: "DELETE" });
      `),
    ).toEqual(["GET /api/things: ok", "POST /api/things: ok", "DELETE /api/things: no-method"]);
  });

  it("pairs one condition's two halves, so no false POST to /things/${id}", () => {
    expect(
      verdicts(
        "fetch(isNew ? `/api/things` : `/api/things/${id}`, { method: isNew ? 'POST' : 'PUT' });",
      ),
    ).toEqual(["POST /api/things: ok", "PUT /api/things/${…}: ok"]);
    // The same, through consts and a negation.
    expect(
      verdicts(`
        const url = editing ? \`/api/things/\${id}\` : "/api/things";
        const method = !editing ? "POST" : "PUT";
        fetch(url, { method });
      `),
    ).toEqual(["PUT /api/things/${…}: ok", "POST /api/things: ok"]);
  });

  it("still catches a pair written the wrong way round", () => {
    expect(
      verdicts(
        "fetch(isNew ? `/api/things` : `/api/things/${id}`, { method: isNew ? 'PUT' : 'POST' });",
      ),
    ).toEqual(["PUT /api/things: no-method", "POST /api/things/${…}: no-method"]);
  });

  it("a static route beats a dynamic one, as in Next", () => {
    expect(verdicts(`axios.get("/api/things/export"); axios.post("/api/things/export");`)).toEqual([
      "GET /api/things/export: no-method",
      "POST /api/things/export: ok",
    ]);
  });

  it("an unknown segment takes the dynamic route, not a static sibling", () => {
    expect(verdicts("axios.post(`/api/things/${id}`);")).toEqual([
      "POST /api/things/${…}: no-method",
    ]);
  });

  it("ignores the query string, known or not", () => {
    expect(
      verdicts(`
        axios.get(\`/api/things?\${query}\`);
        axios.post(\`/api/things\${dryRun ? "?dryRun=1" : ""}\`);
      `),
    ).toEqual([
      "GET /api/things?${…}: ok",
      "POST /api/things?dryRun=1: ok",
      "POST /api/things: ok",
    ]);
  });

  it("reaches a catch-all, and a route that takes any method", () => {
    expect(verdicts("axios.get(`/api/files/a/b/c`); axios.delete('/api/open');")).toEqual([
      "GET /api/files/a/b/c: ok",
      "DELETE /api/open: ok",
    ]);
  });

  it("follows a local function, a let and a `?? ` fallback", () => {
    expect(
      verdicts(`
        function endpoint() { if (a) return "/api/things"; return "/api/nothing"; }
        axios.get(endpoint());
        let target = "/api/things";
        if (b) target = "/api/gone";
        axios.get(target);
        axios.get(chosen ?? "/api/things");
      `),
    ).toEqual([
      "GET /api/things: ok",
      "GET /api/nothing: no-route",
      "GET /api/gone: no-route",
      "GET /api/things: ok",
      "GET null: unresolved",
      "GET /api/things: ok",
    ]);
  });

  it("a runtime action past a runtime id reaches no route when the actions have no id", () => {
    expect(verdicts("axios.post(`/api/actions/${id}/${action}`);")).toEqual([
      "POST /api/actions/${…}/${…}: no-route",
    ]);
  });

  it("reads axios.request, axios(config), axios[verb] and the options hook", () => {
    expect(
      verdicts(`
        axios.request({ url: "/api/things", method: "POST", data });
        axios({ url: "/api/things", method: "DELETE" });
        const verb = "put";
        axios[verb]("/api/customers/1");
        useFetchOptions(ready ? "/api/nothing" : null);
      `),
    ).toEqual([
      "POST /api/things: ok",
      "DELETE /api/things: no-method",
      "PUT /api/customers/1: no-method",
      "GET /api/nothing: no-route",
    ]);
  });

  it("calls what it can't read unresolved, and doesn't guess", () => {
    const body = `
      function send(url) { return axios.post(url); }
      axios.post(table[key].url);
      axios.post(\`\${base}/thing\`);
      axios.post(\`/api/actions/\${action}\`);
      axios.post(\`/api/things\${suffix}\`);
      fetch("/api/things", options);
      axios[pick]("/api/things");
      const save = isEdit ? axios.put : axios.post;
      [1].map(fetch);
    `;
    const reasons = parseClientCalls("src/app/View.tsx", body).map((call) => {
      const verdict = judge(call, routes);
      return verdict.status === "unresolved" ? verdict.why : verdict.status;
    });
    expect(reasons).toEqual([
      "the URL can't be read statically",
      "the URL can't be read statically",
      "the URL starts with a value known only at runtime",
      "a runtime value picks among routes: run, stop",
      "a runtime value is glued to a segment: /api/things${…}",
      "the method can't be read statically",
      "the method can't be read statically",
      "the URL can't be read statically",
      "the URL can't be read statically",
      "the URL can't be read statically",
    ]);
  });

  it("leaves other sites and non-API paths alone", () => {
    const body = `fetch("https://example.com/api/x"); axios.get("/auth/session"); axios.isAxiosError(e);`;
    const calls = parseClientCalls("src/app/View.tsx", body);
    expect(calls.map((call) => judge(call, routes).status)).toEqual(["not-api", "not-api"]);
  });

  it("finds an /api string wherever it sits, and whether a route has it", () => {
    const body = `
      const TABLE = { go: { preview: "/api/actions/run", gone: "/api/actions/missing" } };
      const link = <a href={\`/api/things/\${id}\`}>x</a>;
      const page = "/app/api/not-this";
    `;
    const found = parseApiStrings("src/app/View.tsx", body).map(({ url }) => ({
      url: displayUrl(url),
      status: findRoute(url, routes).status,
    }));
    expect(found).toEqual([
      { url: "/api/actions/run", status: "found" },
      { url: "/api/actions/missing", status: "no-route" },
      { url: "/api/things/${…}", status: "found" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The repo
// ---------------------------------------------------------------------------

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const read = (file: string) => readFileSync(join(APP_DIR, file), "utf8");
const relFiles = (path: string) =>
  sourceFiles(join(APP_DIR, path)).map((f) => relative(APP_DIR, f));
const inRouteTree = (file: string) => ROUTE_TREES.some((tree) => file.startsWith(`${tree}/`));

const routeFile = (file: string) =>
  file.startsWith("src/pages/api/") || /\/route\.tsx?$/.test(file);
const routes = ROUTE_TREES.flatMap(relFiles)
  .filter(routeFile)
  .map((file) => parseRoute(file, read(file)));
const clientFiles = CLIENT_CODE.flatMap(relFiles).filter((file) => !inRouteTree(file));
const calls: ClientCall[] = clientFiles.flatMap((file) => parseClientCalls(file, read(file)));

// fixtures/client-api-calls.txt: `kind :: key... :: reason`, one row a line.
const manifest = readFileSync(join(__dirname, "fixtures", "client-api-calls.txt"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => line.split(" :: "));
const rows = (kind: string) =>
  manifest
    .filter((row) => row[0] === kind)
    .map((row) => ({ key: row.slice(1, -1).join(" :: "), reason: row.at(-1) as string }));
const manifestCalls = rows("call");
const manifestRoutes = rows("route");
const manifestStrings = rows("string");

const keyOf = (call: ClientCall) => `${call.file} :: ${call.method ?? "?"} :: ${call.expression}`;
const at = (call: { file: string; line: number }) => `${call.file}:${call.line}`;
const sorted = (items: Iterable<string>) => [...new Set(items)].sort();

describe("every screen's REST calls", () => {
  it("found the code to check (the scan didn't go blind)", () => {
    expect(routes.length).toBeGreaterThan(400);
    expect(calls.length).toBeGreaterThan(700);
  });

  it("reach a route that answers the method", () => {
    const mismatches = calls.flatMap((call) => {
      const verdict = judge(call, routes);
      if (verdict.status === "no-route") {
        return [`${call.method} ${verdict.path}: no route. ${at(call)}`];
      }
      if (verdict.status === "no-method") {
        const has = [...(verdict.route.methods as ReadonlySet<string>)].join(", ");
        return [
          `${call.method} ${verdict.path}: ${verdict.route.file} answers ${has}. ${at(call)}`,
        ];
      }
      return [];
    });
    // Failing here means a screen will get a 404 or a 405. Correct the call, or
    // give the route the method. If the route has to send something new, check
    // who reaches the screen first: too narrow a gate 403s staff mid-workflow.
    expect(mismatches).toEqual([]);
  });

  it("can be read, unless the manifest says why not", () => {
    const listed = new Set(manifestCalls.map((row) => row.key));
    const unread = calls
      .filter((call) => judge(call, routes).status === "unresolved" && !listed.has(keyOf(call)))
      .map((call) => {
        const verdict = judge(call, routes);
        return `${keyOf(call)} (${at(call)}): ${verdict.status === "unresolved" && verdict.why}`;
      });
    // Failing here means a new call this reader can't follow. Pass a literal or a
    // template if you can. If the URL must come from a table or a prop, add
    // `call :: <the key above> :: <where the URL comes from>` to the manifest.
    expect(unread).toEqual([]);
  });

  it("the manifest lists no call that has gone or can now be read", () => {
    const unread = new Set(
      calls.filter((call) => judge(call, routes).status === "unresolved").map(keyOf),
    );
    expect(manifestCalls.map((row) => row.key).filter((key) => !unread.has(key))).toEqual([]);
  });

  it("every /api string names a route that exists, unless the manifest says why not", () => {
    const listed = new Set(manifestStrings.map((row) => row.key));
    const strings = clientFiles.flatMap((file) =>
      parseApiStrings(file, read(file)).map((found) => ({ file, ...found })),
    );
    const missing = strings.filter(
      ({ file, url }) =>
        findRoute(url, routes).status === "no-route" &&
        !listed.has(`${file} :: ${displayUrl(url)}`),
    );
    // A table of import endpoints, a download link, a helper's argument: these
    // reach a route too. The path is checked here and the method isn't.
    expect(
      missing.map(({ file, line, url }) => `${displayUrl(url)}: no route. ${file}:${line}`),
    ).toEqual([]);
    const present = new Set(strings.map(({ file, url }) => `${file} :: ${displayUrl(url)}`));
    const stale = manifestStrings.map((row) => row.key).filter((key) => !present.has(key));
    expect(stale).toEqual([]);
  });

  it("every route that never looks at the method is listed, and no other is", () => {
    // Any method passes against these, so this check can't see them. That has to
    // be a decision: a wrapper that dispatches on the method by itself would land
    // here and pass everything.
    const actual = sorted(routes.filter((r) => r.methods === "any").map((r) => r.file));
    expect(actual).toEqual(sorted(manifestRoutes.map((row) => row.key)));
  });

  it("every manifest row is well formed and says why", () => {
    const fields: Record<string, number> = { call: 5, route: 3, string: 4 };
    const malformed = manifest.filter((row) => row.length !== fields[row[0]]);
    const noReason = manifest.filter((row) => (row.at(-1) as string).trim().length < 20);
    expect({ malformed, noReason }).toEqual({ malformed: [], noReason: [] });
  });

  it("every file that names an /api path is scanned", () => {
    // A new client helper under src/lib would otherwise call REST unseen.
    const unscanned = relFiles("src")
      .filter((file) => !inRouteTree(file) && !clientFiles.includes(file))
      .filter((file) => parseApiStrings(file, read(file)).length > 0);
    expect(unscanned).toEqual([]);
  });
});
