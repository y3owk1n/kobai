import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "create-kobai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminBuildTooling } from "./support/build-tooling.ts";
import { type ComposeProject, composeUp, imageAt } from "./support/container.ts";
import { freePort } from "./support/free-port.ts";
import {
  type LocalRegistry,
  publishPackages,
  startLocalRegistry,
} from "./support/local-registry.ts";
import {
  migrationReportFindings,
  packagesShippingAMigrationSet,
} from "./support/migration-sets.ts";
import { publishedKobaiPackageDirectories } from "./support/workspace.ts";

/**
 * `docker compose up`, on the compose file and the Dockerfile a Developer actually receives.
 *
 * Both are generated from `reference/` and checked in, and until #12 nothing ran either of
 * them: `tests/create-kobai-matches-the-reference-project.test.ts` compares their bytes with
 * the reference Project's, and the repository root's own `Dockerfile` and `compose.yaml` are
 * what `pnpm run up` and the rest of the suite use. ADR-0034 recorded the gap in as many
 * words — *"generated but not exercised here"* — and #11 named it its own weakest point. A
 * compose file that has never been brought up is a promise, and the first person to find out
 * it was wrong would be a Developer on their first afternoon.
 *
 * So this generates a Project, hands it the one `.npmrc` line that points `@kobai` at the
 * registry holding this commit's packages, and runs `docker compose up --build` in it. The
 * build has no workspace to reach: the Project's Dockerfile copies its own directory and
 * nothing else, and every kobai package arrives from a registry as an ordinary versioned
 * dependency (ADR-0001).
 */

/** Two installs, a Vite build and a boot, all inside a container, on a cold runner. */
const CONTAINER_TIMEOUT = 1_500_000;

/**
 * A credential distinctive enough to find, so "the token did not ship" is a search rather
 * than an inference.
 *
 * A Project installing kobai from a private mirror puts one of these in `.npmrc`, and until
 * #12 that file arrived through `COPY . .` and stayed in a layer — readable by anyone who
 * could pull the image, whatever a later `rm` said.
 */
const LEAKABLE_TOKEN = "kobai-gate-npm-token-do-not-ship-this";

/**
 * The Merchant this deployment is told about at boot, so there is somebody to upload as.
 *
 * `compose.yaml` forwards both by bare name and Core seeds the first Merchant from them
 * (ADR-0041), which makes this the whole of what it takes to have an authenticated caller
 * here — no fixture reaches inside the container. Comfortably past Core's minimum length,
 * because a password Core refuses would be reported in a boot log nothing in this file reads
 * and would surface here as a sign-in that fails for no visible reason.
 */
const MERCHANT_EMAIL = "owner@example.test";
const MERCHANT_PASSWORD = "compose-gate-password";

/** A one-pixel PNG: real bytes of a real content type, small enough to write out here. */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let registry: LocalRegistry;
let workspace: string;
let project: string;
let compose: ComposeProject;

beforeAll(async () => {
  // Reachable from a container: the `pnpm install` that needs `@kobai/*` runs *inside* the
  // build, where `127.0.0.1` is the build container rather than this machine.
  registry = await startLocalRegistry({ reachableFromContainers: true });
  // Every package a generated Project resolves from a registry, taken from the list
  // `create-kobai` itself uses to rewrite a `workspace:*` into a range. It was typed out
  // here as well, and a package added to one and not the other failed inside the image build
  // with a 404 naming the registry rather than the list it was missing from (#129).
  await publishPackages(registry, await publishedKobaiPackageDirectories());

  workspace = await mkdtemp(join(tmpdir(), "kobai-containerised-"));
  project = join(workspace, "my-store");
  await scaffold({ directory: project });

  // The one line a Developer would not write, spelled the way a container resolves it —
  // plus a token, which this registry does not check and which is here on purpose: it is
  // what the assertions below look for in the built image.
  await writeFile(
    join(project, ".npmrc"),
    `@kobai:registry=http://host.docker.internal:${registry.port}/\n//host.docker.internal:${registry.port}/:_authToken=${LEAKABLE_TOKEN}\n`,
  );

  // Everything this overlay adds is about reaching a registry that only exists during this
  // test. It deliberately adds nothing else: the compose file under test is the Project's
  // own, unedited, and `docker compose` merges this on top of it.
  //
  // The `.npmrc` goes in as a **build secret**, which is not a convenience here — it is the
  // supported way to give a Project's build a private registry credential, and the only one
  // that does not end up in a layer. `.dockerignore` refuses the file, so this is also the
  // only way the build sees it at all.
  const overlay = join(workspace, "compose.registry.yaml");
  await writeFile(
    overlay,
    `services:
  app:
    build:
      extra_hosts:
        - "host.docker.internal:host-gateway"
      secrets:
        - npmrc
secrets:
  npmrc:
    file: ./.npmrc
`,
  );

  // Both ports are overridden rather than inherited. `pnpm run ci` exports a
  // `POSTGRES_PORT` for the repository's own Postgres (#21), and a nested compose project
  // taking it would try to publish a second database on a port already in use.
  const postgresPort = await freePort();
  const appPort = await freePort();

  compose = await composeUp({
    directory: project,
    files: [join(project, "compose.yaml"), overlay],
    projectName: `kobai-gate-project-${randomBytes(6).toString("hex")}`,
    env: {
      POSTGRES_PORT: String(postgresPort),
      PORT: String(appPort),
      KOBAI_INITIAL_MERCHANT_EMAIL: MERCHANT_EMAIL,
      KOBAI_INITIAL_MERCHANT_PASSWORD: MERCHANT_PASSWORD,
    },
    appPort,
  });
}, CONTAINER_TIMEOUT);

// `CONTAINER_TIMEOUT` here too, and it is the one hook in this file that was left on
// vitest's 30-second default. Tearing down is not the cheap half: this is the only teardown
// in the suite that runs a `docker compose down` — stopping two containers, removing them,
// their network and their volume — *and* deletes the application image afterwards, and it
// does it at the end of a run that has had every other container in the gate through the
// same daemon. Thirty seconds is a budget for none of that.
//
// The failure it produces is also worth knowing, because it does not look like a slow
// teardown: every test in the file passes and the *file* fails, so the report says a suite
// failed while naming no assertion. Worse, the hook is abandoned mid-way, which leaves the
// containers and the image behind for the next run to trip over.
afterAll(async () => {
  await compose?.down();
  if (compose) await imageAt(compose.appImage).remove();
  await registry?.close();
  await rm(workspace, { recursive: true, force: true });
}, CONTAINER_TIMEOUT);

describe("a generated Project, brought up by its own compose file", () => {
  it(
    "boots, applies every migration set and serves",
    async () => {
      const health = await fetch(`${compose.origin}/health`);
      expect(
        health.status,
        `The Project answered /health with ${health.status}. Its output:\n${await compose.logs()}`,
      ).toBe(200);

      const body = (await health.json()) as {
        migrations: { sets: { name: string; applied: number }[] };
      };
      expect(body).toMatchObject({ status: "ok" });

      // Not merely that the sets are listed: that each of them applied something, and that
      // there are as many as this workspace ships packages that own one. This Project was
      // generated into a temp directory and installed from a registry, so it cannot see that
      // workspace — but the template it was generated from is that workspace's own reference
      // Project, which is what makes the count a question. See `migrationReportFindings`
      // and #129.
      expect(
        migrationReportFindings(
          body.migrations.sets,
          await packagesShippingAMigrationSet(),
        ),
        "The container's migrations disagree with what this workspace ships. Whatever the Dockerfile prunes, `migrations/` is not it.",
      ).toEqual([]);

      // The Admin, from the same process and the same origin — one container, no CORS
      // (ADR-0010).
      const admin = await fetch(`${compose.origin}/admin-ui/`);
      expect(admin.status).toBe(200);
      expect(admin.headers.get("content-type")).toContain("text/html");

      // ...and the store surface is closed by default.
      const store = await fetch(`${compose.origin}/store/variants/none/price`);
      expect(store.status).toBe(401);
    },
    CONTAINER_TIMEOUT,
  );

  it(
    "builds an image carrying no build tooling",
    async () => {
      const image = imageAt(compose.appImage);
      const forbidden = [
        "drizzle-kit",
        "typescript",
        // Read from the generated tree rather than from `reference/admin/`, so this is the
        // manifest the image was actually built from.
        ...(await adminBuildTooling(join(project, "admin/package.json"))),
      ];

      await expect(
        image.installs(forbidden),
        "The image a Developer deploys carries the tools that built it. `pnpm install --prod` in the runtime stage relinks over `node_modules/.pnpm` rather than pruning it, so the prune has to happen in the build stage — see this Project's Dockerfile and #12.",
      ).resolves.toEqual([]);

      // The Admin ships as bytes, not as source (ADR-0033).
      await expect(image.has("/app/admin/dist/index.html")).resolves.toBe(true);
      await expect(image.has("/app/admin/src")).resolves.toBe(false);
    },
    CONTAINER_TIMEOUT,
  );

  it(
    "ships no registry credential, though the build needed one",
    async () => {
      // The build that produced this image installed `@kobai/*` from a registry it had to
      // authenticate to, with a token in `.npmrc`. Both halves of the fix are asserted here
      // rather than read off the Dockerfile: `.dockerignore` keeps the file out of the build
      // context, and the secret mount is what lets the install still see it — for the length
      // of one command, in a stage the runtime image does not carry.
      const image = imageAt(compose.appImage);

      await expect(
        image.has("/app/.npmrc"),
        "The Project's `.npmrc` is in the shipped image. On a private mirror that file holds an auth token, and a token in a layer is readable by anyone who can pull the image.",
      ).resolves.toBe(false);

      await expect(
        image.grep(LEAKABLE_TOKEN, "/app"),
        "The npm auth token the build used is in the shipped image. `.dockerignore` should keep `.npmrc` out of the build context and `Dockerfile` should mount it as a build secret — check that both are still in place.",
      ).resolves.toEqual([]);

      // Where a stray copy would most plausibly land instead: the home directory of the user
      // the container runs as, and root's.
      await expect(image.has("/home/node/.npmrc")).resolves.toBe(false);
      await expect(image.has("/root/.npmrc")).resolves.toBe(false);
    },
    CONTAINER_TIMEOUT,
  );

  // **Last, and it has to stay last.** It replaces the shared `app` container, which resets
  // what `compose.logs()` can say about the boot every case above reads. A case appended after
  // this one would be asking a Project that has already been redeployed once.
  it(
    "still serves an uploaded image after the container is replaced",
    async () => {
      // #283. This Project configures no `media` storage, so it gets the one kobai ships,
      // which writes a Merchant's uploads to a directory inside the container. A container's
      // own filesystem goes away with the container — so a Developer's second deploy used to
      // lose every image in their catalog, and nothing said so until a page rendered without
      // them. The compose file a Developer receives now mounts a volume there, and this is
      // that claim asked of a running Project rather than read off the YAML.
      //
      // **Reading the YAML would have passed while the fix did not work.** A named volume
      // mounted over a path the image does not contain is created by Docker owned by root,
      // and this application runs as `node`, so the *first* upload failed with `EACCES` and
      // there was never anything to persist. That is why the `Dockerfile` creates the
      // directory and chowns it, and why this test uploads before it redeploys.
      const signIn = await fetch(`${compose.origin}/admin/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: MERCHANT_EMAIL, password: MERCHANT_PASSWORD }),
      });
      expect(
        signIn.status,
        `Signing in as the Merchant this deployment was seeded with answered ${signIn.status}. Its output:\n${await compose.logs()}`,
      ).toBe(201);

      // The cookie only, without its attributes: `fetch` here is not a browser and sends
      // back exactly what it is given.
      const session = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect(session).toContain("kobai_session=");

      const form = new FormData();
      form.set("file", new File([PIXEL_PNG], "pixel.png", { type: "image/png" }));

      const upload = await fetch(`${compose.origin}/admin/media`, {
        method: "POST",
        headers: { cookie: session },
        body: form,
      });
      // Read once and parsed from the text, because the failure message wants the body too
      // and a `Response` gives it up exactly once — a message that read it left `json()` with
      // nothing, and the case failed with `Body is unusable` instead of with the status.
      const uploaded = await upload.text();
      expect(
        upload.status,
        `Uploading an image answered ${upload.status}: ${uploaded}\n\nIf this is a 500, look at whether the process can write its media directory at all — \`COPY\` leaves /app owned by root and the container runs as \`node\`.`,
      ).toBe(201);

      const { url } = JSON.parse(uploaded) as { url: string };
      const before = await fetch(`${compose.origin}${url}`);
      expect(before.status, `The image was not served back from ${url}.`).toBe(200);

      await compose.recreateApp();

      const after = await fetch(`${compose.origin}${url}`);
      expect(
        after.status,
        `${url} answered ${after.status} after the container was replaced, so this deployment lost an image the moment it was redeployed. The \`app\` service's Media volume in this Project's compose.yaml is what keeps it.`,
      ).toBe(200);
      expect(
        Buffer.from(await after.arrayBuffer()).equals(PIXEL_PNG),
        `${url} answered after the redeploy with bytes that are not the ones uploaded.`,
      ).toBe(true);
    },
    CONTAINER_TIMEOUT,
  );
});
