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
