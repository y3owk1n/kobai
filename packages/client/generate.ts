import { readFile, writeFile } from "node:fs/promises";
import openapiTS from "openapi-typescript";

/**
 * Writes `src/schema.ts` from Core's generated description.
 *
 * Run it with `devbox run openapi:generate`, which regenerates the description first and then
 * this. Nothing here reads a route: the *only* input is `openapi.json`, which is what makes
 * this client the same artefact a Developer in another language would produce from the same
 * file (ADR-0006). If it could reach the routes it would be a second, luckier client than
 * the one anybody else can build.
 *
 * The output is checked in rather than built on demand, so an API change is visible in a
 * reviewer's diff. `src/schema.test.ts` regenerates it and fails on a difference, so the
 * checked-in copy cannot quietly stop matching.
 *
 * **Why `openapi-typescript` is pinned to 6.7.6 and not 7.** Version 7 builds its output
 * with the TypeScript compiler API, and TypeScript 7 ships none — the import resolves to
 * `undefined` and it dies on `ts.factory` before reading a byte of the document
 * (openapi-ts/openapi-typescript#2841, still open; `@hey-api/openapi-ts` fails the same way
 * in hey-api/hey-api#4235). Version 6 emits its TypeScript as text and needs no compiler at
 * all, which is the same reasoning AGENTS.md § "There is no TypeScript compiler API"
 * applies to `vitest.config.ts`: do not reach for the compiler to do a job a printer can
 * do. The pin is exact, and `.github/dependabot.yml` holds the major back, because 7 is not
 * an upgrade until TypeScript has an API again.
 */

/** Core's description, resolved through its `exports` — the path a Project would take. */
export const OPENAPI_SOURCE_PATH = new URL(
  import.meta.resolve("@kobai/core/openapi.json"),
);

/** What this package publishes types from. Generated; never hand-edited. */
export const CLIENT_SCHEMA_PATH = new URL("./src/schema.ts", import.meta.url);

export async function generateClientSchema(): Promise<string> {
  const document: unknown = JSON.parse(await readFile(OPENAPI_SOURCE_PATH, "utf8"));
  // `openapi-typescript` types its input as its own `OpenAPI3`. The document came from
  // `getOpenAPI31Document`, which is a different library's type for the same JSON, so this
  // is between two spellings of one shape rather than a claim about unknown data.
  return await openapiTS(document as Parameters<typeof openapiTS>[0]);
}

// Importing this module — which `src/schema.test.ts` does, to regenerate and compare —
// must not rewrite the file it is comparing against.
if (import.meta.filename === process.argv[1]) {
  await writeFile(CLIENT_SCHEMA_PATH, await generateClientSchema(), "utf8");
  console.log(`wrote ${CLIENT_SCHEMA_PATH.pathname}`);
}
