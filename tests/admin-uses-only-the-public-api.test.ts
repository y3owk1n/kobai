import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * ADR-0010's load-bearing half, kept true by the build rather than by review.
 *
 * The Admin is allowed no privileged channel: every capability it has is one the public API
 * actually has, because forcing it onto the surface a Developer uses is what keeps that
 * surface honest. Nothing about that promise is visible in a screenshot, and the Admin has
 * no seam of its own — its correctness in this slice *is* "it uses only the public API"
 * (#10), so this file is where that claim stops being an assertion.
 *
 * Two things are checked, and they close different holes.
 *
 * **Nothing in the Admin reaches the network itself.** A single `fetch("/admin/…")` would
 * bypass the generated client, and with it every guarantee the client carries — including
 * the compile-time one that the path exists. The scan is over the Admin's whole source tree
 * including the vendored components, because a component that phoned home would be just as
 * much of a back door as a screen that did.
 *
 * **Every kobai path the Admin names is one the description publishes.** The generated types
 * already refuse an unknown path at compile time, which is the stronger check; this one is
 * independent of the compiler and reads as the criterion itself — a path in the Admin that
 * is in no published description would be a route somebody added for the Admin alone, which
 * is the thing ADR-0010 forbids.
 *
 * **And exactly one file may build a path at runtime** (ADR-0081, #269). That check exists
 * because the one above would otherwise be **silently vacuous over the Playground**: it reads
 * *quoted* path literals, and the Playground sends at a path read out of a document the server
 * served a moment ago, so a screen that could reach anything would be the one screen this scan
 * had nothing to say about — a guardrail passing by not looking. See {@link RUNTIME_PATH_SEAM}.
 */
const adminSource = new URL("../reference/admin/src/", import.meta.url);
const description = new URL("../packages/core/openapi.json", import.meta.url);

/**
 * The ways a browser can open a connection without the client's help.
 *
 * `import` is not among them: Vite resolves a module graph at build time and the result is
 * part of the bundle, not a call to kobai. Everything here is a runtime request.
 *
 * Patterns rather than substrings, because of the one that needs a boundary: `fetch(` as a
 * substring is also inside TanStack Query's `refetch()`, which the Admin calls to re-read a
 * query it already has (#174). So `fetch` is matched only where nothing word-like precedes
 * it — which still catches `window.fetch(` and `globalThis.fetch(`, since a `.` is not a word
 * character, and stops the scan reporting a cache API as a network primitive. Narrowing what
 * counts as a `fetch`, not what counts as a violation.
 */
const NETWORK_PRIMITIVES: readonly { readonly name: string; readonly found: RegExp }[] = [
  { name: "fetch(", found: /(?<![\w$])fetch\(/ },
  { name: "XMLHttpRequest", found: /XMLHttpRequest/ },
  { name: "EventSource", found: /EventSource/ },
  { name: "WebSocket", found: /WebSocket/ },
  { name: "sendBeacon", found: /sendBeacon/ },
  { name: "navigator.serviceWorker", found: /navigator\.serviceWorker/ },
];

/** The one import in the Admin that is allowed to produce something network-capable. */
const CLIENT_PACKAGE = "@kobai/client";

/**
 * The one file allowed to reach kobai at a path it did not write down.
 *
 * A playground driven by a runtime description is inherently not compile-time typed —
 * `openapi-fetch` types every call against a **literal** path — so some cast is unavoidable,
 * and where it lives is the decision. It lives here and **not** in `@kobai/client`, whose whole
 * promise is that every call it types is a call that exists (ADR-0006): an untyped escape hatch
 * on that package is a hole every consumer inherits to serve one screen of one Admin.
 */
const RUNTIME_PATH_SEAM = "lib/playground-request.ts";

/**
 * The methods of the generated client, which is how a request leaves this Admin at all.
 *
 * `request` is the odd one and the point of this list: the seven named after a verb take a
 * **literal** path the compiler checks, and `request` is `openapi-fetch`'s general entry point —
 * the one a runtime path can be pushed through. So it is matched here like the rest *and* named
 * below as the thing only one file may reach for.
 */
const CLIENT_METHODS = [
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "request",
];

/**
 * A call on the client, with whatever it was handed as a path.
 *
 * The capture is the first character after the bracket, because what this asks is one question:
 * **is the path a quoted literal**. Anything else — a variable, a template string, a call — is
 * a path composed at runtime, which is exactly what the scan above cannot read.
 */
const CLIENT_CALL = new RegExp(`\\.(${CLIENT_METHODS.join("|")})\\(\\s*(.?)`, "g");

/**
 * The general entry point, matched where something is calling it rather than spreading a value.
 *
 * A character class in front, so `{ ...request }` — an object spread of something a module of
 * this Admin happens to have called `request` — is not read as a client call.
 */
const GENERAL_ENTRY_POINT = /[A-Za-z_$]\.request\b/;

type SourceFile = { readonly path: string; readonly text: string };

async function adminSourceFiles(): Promise<SourceFile[]> {
  // Relative paths, so a failure names the file the way a Developer would open it.
  const entries = await readdir(adminSource, { recursive: true });
  const files: SourceFile[] = [];

  for (const entry of entries.sort()) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    files.push({
      path: entry,
      text: await readFile(new URL(entry, adminSource), "utf8"),
    });
  }

  return files;
}

describe("the Admin's only route to kobai", () => {
  it("finds the Admin's source, so an empty scan cannot pass", async () => {
    // Every assertion below is over a list. A scan that found nothing would satisfy all of
    // them and prove none of them.
    const files = await adminSourceFiles();

    expect(files.length).toBeGreaterThan(5);
    expect(files.map((file) => file.path)).toContain("lib/kobai.ts");
  });

  it("reaches the network nowhere, in no file, by any primitive", async () => {
    const files = await adminSourceFiles();

    const offenders = files.flatMap((file) =>
      NETWORK_PRIMITIVES.filter((primitive) => primitive.found.test(file.text)).map(
        (primitive) => `${file.path} uses ${primitive.name}`,
      ),
    );

    // Including `lib/kobai.ts`, which builds the clients: it hands `createKobaiClient` a
    // base URL and a credential and never a `fetch` of its own.
    expect(offenders).toEqual([]);
  });

  it("imports nothing that could talk to kobai except the generated client", async () => {
    const files = await adminSourceFiles();

    const kobaiImports = files.flatMap((file) =>
      [...file.text.matchAll(/from\s+"(@kobai\/[^"]+)"/g)].map(
        (match) => `${file.path} → ${match[1]}`,
      ),
    );

    expect(kobaiImports.length).toBeGreaterThan(0);
    for (const imported of kobaiImports) {
      expect(imported.endsWith(CLIENT_PACKAGE)).toBe(true);
    }
    // `@kobai/core` in particular: importing it would put Core's internals in a browser
    // bundle and let the Admin do something over a route nobody published.
    expect(kobaiImports.join("\n")).not.toContain("@kobai/core");
  });

  it("builds a path at runtime in one file, and nowhere else", async () => {
    const files = await adminSourceFiles();

    // The emptiness guard, and here it is the whole of what makes the ban worth anything: a
    // scan that found no client calls would report that every one of them names a literal.
    const calls = files.flatMap((file) => [...file.text.matchAll(CLIENT_CALL)]);
    expect(calls.length).toBeGreaterThan(20);

    // And the seam really is doing the thing it is exempted for. Without this the exemption
    // could be for a file that had stopped constructing anything, and the day a *second* screen
    // needed one nobody would be told which file was supposed to be the only one.
    const seam = files.find((file) => file.path === RUNTIME_PATH_SEAM);
    expect(
      seam,
      `${RUNTIME_PATH_SEAM} is the one file allowed to build a path`,
    ).toBeDefined();
    expect(GENERAL_ENTRY_POINT.test(seam?.text ?? "")).toBe(true);

    const offenders = files.flatMap((file) => {
      if (file.path === RUNTIME_PATH_SEAM) return [];
      const composed = [...file.text.matchAll(CLIENT_CALL)]
        .filter((match) => match[2] !== '"')
        .map((match) => `${file.path} calls .${match[1]}() with a path it composed`);
      return GENERAL_ENTRY_POINT.test(file.text)
        ? [...composed, `${file.path} reaches for the client's untyped \`request\``]
        : composed;
    });

    expect(offenders).toEqual([]);
  });

  it("names only paths the published description carries", async () => {
    const files = await adminSourceFiles();
    const published = Object.keys(
      (JSON.parse(await readFile(description, "utf8")) as { paths: object }).paths,
    );

    // Every kobai path the Admin mentions, in the template form the client takes them in:
    // `/admin/products/{id}`, not the URL that reaches the server.
    const named = files.flatMap((file) =>
      [...file.text.matchAll(/"(\/(?:admin|store|health)[^"]*)"/g)].map((match) => ({
        file: file.path,
        path: match[1] ?? "",
      })),
    );

    expect(named.length).toBeGreaterThan(0);
    expect(published.length).toBeGreaterThan(0);
    for (const { file, path } of named) {
      expect(published, `${file} names ${path}`).toContain(path);
    }
  });
});
