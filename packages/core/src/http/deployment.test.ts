import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../auth/permissions.ts";
import type { LoadedPrices, ResolvedPrice } from "../pricing/resolve-price.ts";
import {
  createTestKobai,
  sessionOf,
  signInTestMerchant,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";
import { defineStep } from "../workflow/step.ts";
import { OPENAPI_DOCUMENT_PATH } from "./openapi.ts";

/**
 * What a running deployment says about itself — `GET /admin/deployment` and
 * `GET /admin/openapi.json` (ADR-0080).
 *
 * Everything a deployment has been configured into is decided in `kobai.config.ts` and then
 * disappears into a process. These two routes are the way back: which release of Core this is,
 * which Step is filling each of a Workflow's positions and where it came from, whether a
 * Payment Provider is wired, and the description of the surface this server actually serves.
 *
 * **The provenance is the substantial half, and it is asserted here rather than at the Workflow
 * seam** — the Workflow seam earns its exemption from HTTP only for what HTTP cannot see, and a
 * Step's origin is exactly what a Developer reads off this route. The two cases that matter are
 * the two a `slot === step.name` inference gets wrong, silently and confidently: an **inserted**
 * Step occupies a position under its own name, and a **replacement** may reuse the slot's name.
 * Both are arranged below with names chosen to make that inference agree with them, so a build
 * that derived the answer rather than recording it passes nothing here.
 *
 * **Watched failing** against exactly that build: with `origin` replaced by
 * `slot === step.name ? "stock" : "replaced"`, the two provenance cases went red and the other
 * twelve stayed green — which is the shape of the bug, since a stock deployment is the one
 * arrangement the inference gets right.
 */

/** The Steps `resolve-price` declares, in order, read out of `pricing/resolve-price.ts`. */
const RESOLVE_PRICE_SLOTS = ["load-prices", "select-price"] as const;

/**
 * A replacement that answers to **the slot's own name**.
 *
 * Deliberately: a Project replacing `select-price` is free to call its Step anything, and
 * calling it what the slot is called is the ordinary thing to do. That makes `slot === name`
 * true of a Step that is not stock, which is the first of the two traps ADR-0080 records.
 */
const ourSelectPrice = defineStep("select-price", (): ResolvedPrice => {
  // Never reached: every case here asks what the deployment *is*, not what it does, so nothing
  // below prices anything. A Step that did would be arranging a second subject.
  throw new Error("this deployment's own select-price was not meant to run");
});

/**
 * A Step inserted after `load-prices`, watching what it produced.
 *
 * It occupies a position of its own under its own name, so `slot === name` is true of it too —
 * the second trap, and the one that reads an *observation* as Core's own code.
 */
const watchTheLoad = defineStep("watch-the-load", (loaded: LoadedPrices) => loaded);

describe("a deployment says what it is", () => {
  it("answers the release of Core it is running", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/deployment", {
      headers: merchant.headers,
    });

    // The checked-in description rather than `coreVersion()`, which is the very function the
    // route reads: a version taken from the side under test agrees with itself. `openapi.json`
    // is the second artifact — `openapi.test.ts` holds *it* to the manifest — so this is the
    // pairing that says the route reads the fact Core already reads and not a copy of it.
    const described = JSON.parse(await readFile(OPENAPI_DOCUMENT_PATH, "utf8")) as {
      info: { version: string };
    };

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: described.info.version,
    });
  });

  it("names every Workflow it declares, and every position in each", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/deployment", {
      headers: merchant.headers,
    });

    const body = (await response.json()) as DeploymentBody;

    // In name order, like `GET /admin/fulfilment-strategies`: an object's key order is not a
    // promise anybody should be reading a list out of.
    expect(body.workflows.map((workflow) => workflow.name)).toEqual([
      "place-order",
      "resolve-price",
    ]);
    expect(workflowNamed(body, "resolve-price").steps).toEqual([
      { slot: "load-prices", step: "load-prices", origin: "stock" },
      { slot: "select-price", step: "select-price", origin: "stock" },
    ]);
  });

  it("calls a Step nothing has touched stock, on every position it has", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/deployment", {
      headers: merchant.headers,
    });

    const body = (await response.json()) as DeploymentBody;
    const positions = body.workflows.flatMap((workflow) => workflow.steps);

    // Story 4: a Developer ruling customisation *out* needs the stock answer to be an answer
    // rather than the absence of another one. Emptiness guard first, because a route that
    // reported no Workflows at all would satisfy every `every` below it.
    expect(positions.length).toBeGreaterThan(RESOLVE_PRICE_SLOTS.length);
    expect(positions.map((position) => position.origin)).toEqual(
      positions.map(() => "stock"),
    );
  });

  it("calls a replaced Step replaced, even where it answers to the slot's own name", async () => {
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": ourSelectPrice } } },
    });
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/deployment", {
      headers: merchant.headers,
    });

    // Story 2, and the trap: this deployment prices with a Project's own rule, and every field
    // a name-equality inference could read says `select-price`.
    await expect(response.json()).resolves.toMatchObject({
      workflows: expect.arrayContaining([
        {
          name: "resolve-price",
          steps: [
            { slot: "load-prices", step: "load-prices", origin: "stock" },
            { slot: "select-price", step: "select-price", origin: "replaced" },
          ],
        },
      ]),
    });
  });

  it("calls an inserted Step inserted, and leaves the position it watches stock", async () => {
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { after: { "load-prices": [watchTheLoad] } } },
    });
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/deployment", {
      headers: merchant.headers,
    });

    // Story 3, and the other half of the trap: an inserted Step fills no slot Core declared, so
    // it answers to itself and `slot === name` is true of it. The position it watches is
    // untouched and has to keep saying so.
    await expect(response.json()).resolves.toMatchObject({
      workflows: expect.arrayContaining([
        {
          name: "resolve-price",
          steps: [
            { slot: "load-prices", step: "load-prices", origin: "stock" },
            { slot: "watch-the-load", step: "watch-the-load", origin: "inserted" },
            { slot: "select-price", step: "select-price", origin: "stock" },
          ],
        },
      ]),
    });
  });

  it("says a Payment Provider is configured when one is wired", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/deployment", {
      headers: merchant.headers,
    });

    // `createTestKobai` wires one, because almost no test is about not having one (ADR-0053).
    await expect(response.json()).resolves.toMatchObject({
      payments: { configured: true },
    });
  });

  it("serves both routes on a deployment that has no Payment Provider", async () => {
    await using kobai = await createTestKobai({ payments: {} });
    const merchant = await signInTestMerchant(kobai);

    const deployment = await kobai.request("/admin/deployment", {
      headers: merchant.headers,
    });
    const description = await kobai.request("/admin/openapi.json", {
      headers: merchant.headers,
    });

    // Story 7: a deployment with no provider is a working deployment that refuses to place an
    // Order and nothing else — so the route that explains why has to be one of the things it
    // still answers.
    expect([deployment.status, description.status]).toEqual([200, 200]);
    await expect(deployment.json()).resolves.toMatchObject({
      payments: { configured: false },
    });
  });
});

describe("a deployment serves its own description", () => {
  it("answers the document this instance produces", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/openapi.json", {
      headers: merchant.headers,
    });

    // Story 8: *this server's* answer rather than a package's build artifact. Compared against
    // `kobai.openapi()` because that is the value ADR-0080 says the route serves, and because a
    // route that read `packages/core/openapi.json` off the disk would pass a comparison against
    // the file and fail this one on any deployment whose description is not the stock one.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual(
      JSON.parse(JSON.stringify(kobai.openapi())),
    );
  });

  it("describes itself — its own path is in the document it returns", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/openapi.json", {
      headers: merchant.headers,
    });

    const document = (await response.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };

    // Story 9. A description whose first omission is the route serving it lies about the server
    // on the one fact it is best placed to know.
    expect(Object.keys(document.paths)).toContain("/admin/openapi.json");
    expect(document.paths["/admin/openapi.json"]).toHaveProperty("get");
    expect(document.paths["/admin/deployment"]).toHaveProperty("get");
  });
});

describe("both routes are closed like every other", () => {
  it("refuses a request carrying no Merchant session", async () => {
    await using kobai = await createTestKobai();

    for (const path of DEPLOYMENT_PATHS) {
      const response = await kobai.request(path);
      expect(response.status, path).toBe(401);
    }
  });

  it("refuses a Merchant whose Role does not hold the Permission, and names it", async () => {
    await using kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const headers = await merchantHolding(kobai, owner, [PERMISSIONS.storeRead]);

    for (const path of DEPLOYMENT_PATHS) {
      const response = await kobai.request(path, { headers });

      // `store:read` deliberately, because that is the Permission a Role would most plausibly
      // already hold: reading which Steps a deployment has replaced is not part of correcting a
      // currency, and ADR-0080 refuses to make it one.
      expect(response.status, path).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        reason: "permission-denied",
        required: PERMISSIONS.deploymentRead,
      });
    }

    // …and the Store they *do* hold a Permission for still answers, so what was refused is the
    // one power rather than the whole surface.
    const store = await kobai.request("/admin/store", { headers });
    expect(store.status).toBe(200);
  });

  it("admits a Role holding nothing else", async () => {
    await using kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const headers = await merchantHolding(kobai, owner, [PERMISSIONS.deploymentRead]);

    for (const path of DEPLOYMENT_PATHS) {
      const response = await kobai.request(path, { headers });
      // Story 31: a contractor gets the shape of the deployment and nothing in the Store.
      expect(response.status, path).toBe(200);
    }

    const products = await kobai.request("/admin/products", { headers });
    expect(products.status).toBe(403);
  });

  it("is refused while migrations have not applied", async () => {
    await using kobai = await createTestKobai({ migrate: false });

    for (const path of DEPLOYMENT_PATHS) {
      const response = await kobai.request(path);

      // Behind the migration gate like every route but `/health`, although neither reads a
      // table: a description generated per surface rather than per deployment state is not a
      // contract, and the gate is mounted on the whole of `/admin`.
      expect(response.status, path).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ status: "booting" });
    }
  });
});

describe("neither route pages", () => {
  it("takes no page query and answers no cursor", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/deployment?limit=1&after=whatever", {
      headers: merchant.headers,
    });

    // ADR-0067's other side: a set fixed by the deployment's own configuration, readable in
    // full, unable to change without a restart. A paging parameter is not refused here because
    // there is no page query to refuse it — it is simply not part of the request, exactly as it
    // is not on `GET /admin/fulfilment-strategies`.
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["payments", "version", "workflows"]);
  });
});

const DEPLOYMENT_PATHS = ["/admin/deployment", "/admin/openapi.json"] as const;

type DeploymentBody = {
  readonly version: string;
  readonly workflows: readonly {
    readonly name: string;
    readonly steps: readonly { slot: string; step: string; origin: string }[];
  }[];
  readonly payments: { readonly configured: boolean };
};

/** One Workflow out of the answer, named rather than taken by position. */
function workflowNamed(body: DeploymentBody, name: string) {
  const found = body.workflows.find((workflow) => workflow.name === name);
  expect(found, `the answer carries no Workflow named ${name}`).toBeDefined();
  return found as DeploymentBody["workflows"][number];
}

/**
 * A second Merchant on a Role carrying exactly these Permissions, signed in.
 *
 * Through the routes a Merchant uses, never `insert into core_role` — a test that built its
 * Role with SQL would pass just as well against a route that is gated wrongly.
 */
async function merchantHolding(
  kobai: TestKobai,
  owner: TestSession,
  permissions: readonly string[],
): Promise<Record<string, string>> {
  const email = "contractor@example.test";
  const password = "a contractor's very long password";
  const json = { ...owner.headers, "content-type": "application/json" };

  const role = await kobai.request("/admin/roles", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "contractor", permissions }),
  });
  expect(role.status).toBe(201);
  const created = await kobai.request("/admin/merchants", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email, password, role: "contractor" }),
  });
  expect(created.status).toBe(201);

  return sessionOf(
    await kobai.request("/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  ).headers;
}
