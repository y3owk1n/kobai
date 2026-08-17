import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestKobai, signInTestMerchant } from "@kobai/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_PATH, createAdminAssets } from "./admin-assets.ts";
import { createProjectFetch } from "./app.ts";

/**
 * One process serving the Admin and the API, dispatched in-process like everything else.
 *
 * The subject here is not the Admin's behaviour — interaction and visual testing of it is
 * deferred (#10). It is the three promises the *Project* makes by serving it: that the API
 * is reached unchanged, that no route was added for the Admin's benefit, and that no CORS
 * header is sent, because there is no second origin for one to be about.
 */
let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** A stand-in for `reference/admin/dist`, so a test needs no `vite build` first. */
async function built(files: Record<string, string>) {
  root = await mkdtemp(join(tmpdir(), "kobai-admin-"));
  for (const [name, content] of Object.entries(files)) {
    const at = join(root, name);
    await mkdir(join(at, ".."), { recursive: true });
    await writeFile(at, content);
  }
  return createAdminAssets({ root: new URL(`${pathToFileURL(root).href}/`) });
}

const INDEX = "<!doctype html><title>kobai Admin</title>";

describe("the Project's one origin", () => {
  it("serves the Admin at a path, and hands everything else to kobai untouched", async () => {
    await using kobai = await createTestKobai();
    const admin = await built({
      "index.html": INDEX,
      "assets/index-abc123.js": "console.log('the Admin')",
    });
    const fetch = createProjectFetch(kobai, admin);

    const page = await fetch(new Request(`http://kobai.test${ADMIN_PATH}/`));
    const asset = await fetch(
      new Request(`http://kobai.test${ADMIN_PATH}/assets/index-abc123.js`),
    );
    const health = await fetch(new Request("http://kobai.test/health"));

    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain("kobai Admin");
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    // Unchanged means unchanged: kobai's own route answers kobai's own body.
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("adds no route of its own to the API, so there is none only the Admin may call", async () => {
    await using kobai = await createTestKobai();
    const fetch = createProjectFetch(kobai, await built({ "index.html": INDEX }));

    // `/admin` is not a prefix of `/admin-ui` at a path boundary, so nothing under kobai's
    // admin surface is diverted — and a path kobai does not serve gets *kobai's* answer
    // rather than one this Project invented.
    const gated = await fetch(new Request("http://kobai.test/admin/products"));
    const invented = await fetch(new Request("http://kobai.test/admin/bulk-import"));
    const store = await fetch(new Request("http://kobai.test/store/variants/x/price"));

    expect(gated.status).toBe(401);
    await expect(gated.json()).resolves.toMatchObject({ reason: "session-missing" });
    // Whatever kobai answers here, it is kobai answering. The Project serves no route under
    // `/admin`, so there is nothing here the public API does not have.
    expect([401, 404]).toContain(invented.status);
    expect(store.status).toBe(401);
  });

  it("sends no CORS header, because there is no second origin to send one about", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const fetch = createProjectFetch(kobai, await built({ "index.html": INDEX }));

    const page = await fetch(new Request(`http://kobai.test${ADMIN_PATH}/`));
    const api = await fetch(
      new Request("http://kobai.test/admin/products", { headers: merchant.headers }),
    );
    const preflight = await fetch(
      new Request("http://kobai.test/admin/products", {
        method: "OPTIONS",
        headers: { origin: "http://elsewhere.test" },
      }),
    );

    for (const response of [page, api, preflight]) {
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    // A preflight that is answered would be a cross-origin Admin working by accident.
    expect(preflight.status).not.toBe(204);
  });

  it("serves a deep link inside the Admin as the Admin, and a missing asset as missing", async () => {
    await using kobai = await createTestKobai();
    const fetch = createProjectFetch(kobai, await built({ "index.html": INDEX }));

    const deep = await fetch(new Request(`http://kobai.test${ADMIN_PATH}/products/1`));
    const missing = await fetch(
      new Request(`http://kobai.test${ADMIN_PATH}/assets/gone.js`),
    );
    const bare = await fetch(new Request(`http://kobai.test${ADMIN_PATH}`));

    await expect(deep.text()).resolves.toContain("kobai Admin");
    // Not the page: a fingerprinted asset that is missing is a stale deploy, and answering
    // HTML would put it inside a `<script>` tag instead of saying so.
    expect(missing.status).toBe(404);
    expect(bare.status).toBe(308);
    expect(bare.headers.get("location")).toBe(`${ADMIN_PATH}/`);
  });

  it("refuses to climb out of the Admin's directory", async () => {
    await using kobai = await createTestKobai();
    const fetch = createProjectFetch(kobai, await built({ "index.html": INDEX }));

    // `new URL` normalises the `..` before the handler sees it, which is why the check is on
    // the resolved path rather than on the request's.
    const climbed = await fetch(
      new Request(`http://kobai.test${ADMIN_PATH}/assets/../../../../etc/passwd`),
    );

    expect(climbed.status).toBe(404);
  });

  it("is served at the same path the Admin was built for", async () => {
    // Two literals in two packages: `ADMIN_PATH` here, and Vite's `base`, which is baked
    // into every asset URL in the built `index.html`. If they drift the page loads and every
    // asset on it 404s — a failure that shows up only in a browser, and only after a build.
    // Neither the compiler nor the tests above can see across that boundary, so the config is
    // read as the text it is.
    const config = await readFile(
      new URL("../admin/vite.config.ts", import.meta.url),
      "utf8",
    );
    const base = /const ADMIN_BASE = "([^"]+)"/.exec(config)?.[1];

    expect(base, "vite.config.ts no longer declares ADMIN_BASE").toBeDefined();
    expect(base).toBe(`${ADMIN_PATH}/`);
  });

  it("says so when the Admin has not been built, rather than 404ing", async () => {
    await using kobai = await createTestKobai();
    const fetch = createProjectFetch(kobai, await built({}));

    const page = await fetch(new Request(`http://kobai.test${ADMIN_PATH}/`));

    expect(page.status).toBe(503);
    await expect(page.json()).resolves.toMatchObject({ reason: "admin-not-built" });
  });
});
