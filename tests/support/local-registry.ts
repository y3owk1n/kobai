import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freePort } from "./free-port.ts";

/**
 * A real npm registry, on this machine, holding the packages this commit builds.
 *
 * This exists because of one sentence in ADR-0001: Core is an **ordinary versioned
 * dependency** of a Project. A generated Project therefore has to say
 * `"@kobai/core": "^0.1.0"` and resolve it the way any dependency resolves — and
 * `workspace:*` does not resolve outside this workspace, so nothing in a temp directory
 * could install one. See ADR-0034.
 *
 * Publishing to npmjs.com instead would *look* like the answer and would be worse: CI would
 * install the last **released** Core rather than the Core in the commit under test, so
 * "generate a Project, boot it, serve a request" would stop being a test of the commit that
 * ran it. A registry holding this working tree keeps the acceptance test honest.
 *
 * #12 needs exactly this to bump Core across a synthetic major, which is why it is a module
 * with an interface rather than a detail inside one test file.
 */

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Long enough for a cold `verdaccio` boot on a CI runner, short enough to fail a hung one. */
const START_TIMEOUT = 60_000;
/** Packing and publishing shells out per package; CI runners are slower than laptops. */
const PUBLISH_TIMEOUT = 180_000;

export type LocalRegistryOptions = {
  /**
   * Accept connections from a container as well as from this machine's loopback.
   *
   * A `docker build` that installs `@kobai/*` cannot use `127.0.0.1` — inside the container
   * that address is the container. It reaches the host as `host.docker.internal`, which on
   * Linux is the bridge gateway rather than loopback, so a registry bound to `127.0.0.1`
   * refuses the connection and the build fails with `ECONNREFUSED` naming an address that
   * looks right.
   *
   * Off by default because publishing here is anonymous: binding a writable registry to
   * every interface on a laptop is a real, if small, exposure, and only the test that builds
   * a Project's image needs it.
   */
  readonly reachableFromContainers?: boolean;
};

export type LocalRegistry = {
  /** Where it listens — `http://127.0.0.1:<port>`, on a port nothing else claimed. */
  readonly url: string;
  /**
   * The port it claimed, for a caller that has to spell the host differently.
   *
   * A container reaching this registry writes `http://host.docker.internal:<port>` — same
   * process, same port, an address that resolves where it is being asked from.
   */
  readonly port: number;
  /**
   * An npm userconfig naming this registry and a token for it.
   *
   * Point `npm_config_userconfig` at this and both publishing and installing reach this
   * registry rather than the public one. It is a file rather than a flag because
   * `publishConfig.registry` in a manifest beats `--registry` on the command line — see
   * {@link publishPackages}.
   */
  readonly npmrc: string;
  /** Stops the process and removes its storage. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * `uplinks: {}` is load-bearing: this registry proxies **nothing**.
 *
 * Only `@kobai/*` is ever asked of it — a generated Project's `.npmrc` scopes it to that,
 * and everything else comes from wherever npm normally looks. So it needs no network, and
 * cannot silently answer for a package this commit did not build.
 */
function configYaml(storage: string): string {
  return `storage: ${join(storage, "storage")}
auth:
  htpasswd:
    file: ${join(storage, "htpasswd")}
uplinks: {}
packages:
  '@kobai/*':
    access: $all
    publish: $anonymous
    unpublish: $anonymous
  '**':
    access: $all
    publish: $anonymous
log:
  type: stdout
  format: pretty
  level: error
`;
}

export async function startLocalRegistry(
  options: LocalRegistryOptions = {},
): Promise<LocalRegistry> {
  const storage = await mkdtemp(join(tmpdir(), "kobai-registry-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // What it binds, which is not always what a caller dials: everything on this machine
  // still reaches it at `url`, and a container reaches the same process by another name.
  const listen = options.reachableFromContainers
    ? `http://0.0.0.0:${port}`
    : `http://127.0.0.1:${port}`;

  const configPath = join(storage, "config.yaml");
  await writeFile(configPath, configYaml(storage));

  const npmrc = join(storage, "npmrc");
  // The token's value is never checked — `publish: $anonymous` above lets anyone write —
  // but npm refuses to *attempt* a publish to a host it holds no token for, failing with
  // ENEEDAUTH before it opens a connection. So the line has to be here even though the
  // registry does not care what it says.
  await writeFile(
    npmrc,
    `registry=${url}\n//127.0.0.1:${port}/:_authToken=kobai-local\n`,
  );

  const verdaccio = join(repoRoot, "node_modules/.bin/verdaccio");
  const child = spawn(verdaccio, ["--config", configPath, "--listen", listen], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Kept so a failure to start can say what the process complained about, rather than only
  // that it never answered.
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let exited: { code: number | null } | undefined;
  child.on("exit", (code) => {
    exited = { code };
  });

  const close = async () => {
    if (exited === undefined) child.kill();
    await rm(storage, { recursive: true, force: true });
  };

  const deadline = Date.now() + START_TIMEOUT;
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      await close();
      throw new Error(
        `The local registry exited with code ${exited.code} before it answered. Its stderr:\n${stderr}`,
      );
    }
    try {
      const response = await fetch(`${url}/-/ping`);
      if (response.ok) {
        return {
          url,
          port,
          npmrc,
          close,
          [Symbol.asyncDispose]: close,
        };
      }
    } catch {
      // Not listening yet; the loop is the wait.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await close();
  throw new Error(
    `The local registry did not answer at ${url} within ${START_TIMEOUT}ms. Its stderr:\n${stderr}`,
  );
}

/**
 * Packs each workspace package and publishes the tarball to this registry.
 *
 * **Two steps rather than `pnpm publish`, and that is forced.** Every publishable manifest
 * pins `publishConfig.registry` at a loopback address so a stray publish cannot reach
 * npmjs.com (ADR-0034), and that pin beats both `--registry` and `npm_config_registry` —
 * measured, not assumed. Publishing an explicit **tarball** is the one form that honours
 * `--registry`, so the guard stays effective and CI can still publish. `pnpm pack` is also
 * exactly what `tests/packaged-migrations.test.ts` reads, so what is published here is the
 * same bytes that test proves carry their migrations.
 */
export async function publishPackages(
  registry: LocalRegistry,
  packageDirectories: readonly string[],
): Promise<void> {
  if (packageDirectories.length === 0) {
    // Failing open would leave the registry empty and every install failing later with a
    // 404 that says nothing about why.
    throw new Error(
      "No package directories were given to publish, so the registry is empty.",
    );
  }

  const destination = await mkdtemp(join(tmpdir(), "kobai-publish-"));
  try {
    for (const directory of packageDirectories) {
      const absolute = join(repoRoot, directory);
      await run("pnpm", ["pack", "--pack-destination", destination], { cwd: absolute });
    }

    const tarballs = await readdir(destination);
    if (tarballs.length !== packageDirectories.length) {
      throw new Error(
        `Packing ${packageDirectories.length} package(s) produced ${tarballs.length} tarball(s): ${tarballs.join(", ")}`,
      );
    }

    for (const tarball of tarballs) {
      await run(
        "npm",
        ["publish", join(destination, tarball), "--registry", registry.url],
        {
          cwd: repoRoot,
          env: { ...process.env, npm_config_userconfig: registry.npmrc },
        },
      );
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}
