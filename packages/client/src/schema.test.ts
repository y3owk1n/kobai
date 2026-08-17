import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CLIENT_SCHEMA_PATH, generateClientSchema } from "../generate.ts";

/**
 * The second half of the drift check.
 *
 * `@kobai/core`'s own test proves the description matches the routes. This one proves the
 * client matches the description — so between them, a route change that has not been
 * regenerated fails the build twice rather than reaching a Developer as a client that
 * quietly describes last week's API.
 *
 * Regenerate both with `devbox run openapi:generate`.
 */
describe("the generated client tracks the description", () => {
  it("is checked in exactly as regenerating it produces", async () => {
    const [checkedIn, regenerated] = await Promise.all([
      readFile(CLIENT_SCHEMA_PATH, "utf8"),
      generateClientSchema(),
    ]);

    expect(regenerated).toBe(checkedIn);
  });

  it("carries a name for every route the description holds", async () => {
    const checkedIn = await readFile(CLIENT_SCHEMA_PATH, "utf8");

    // Not a schema comparison — that is what the check above is. This catches the one way
    // a regenerated file can be current and useless: `openapi-typescript` emitting nothing
    // for a document it could not read, which would leave `paths` empty and every call in
    // `client.test.ts` a type error rather than a silent `any`.
    for (const path of [
      "/health",
      "/admin/session",
      "/admin/products/{id}",
      "/admin/variants/{id}/prices",
      "/admin/api-keys/{id}",
      "/store/variants/{id}/price",
    ]) {
      expect(checkedIn, path).toContain(`"${path}"`);
    }
  });
});
