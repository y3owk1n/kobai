import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
 *
 * **Writing is scoped to `@kobai/*` too**, and the catch-all below grants read only. That
 * matters more than it looks now that this can bind every interface for a build container
 * (see {@link LocalRegistryOptions}): an anonymous-publish catch-all on a laptop is a
 * writable registry anyone on the network can put any package name into, for as long as the
 * test runs. Nothing here publishes anything outside the scope.
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

  /**
   * Stops the registry and removes what it was reading, **in that order**.
   *
   * `kill` only *asks*: it returns as soon as the signal is delivered, so removing `storage`
   * on the next line took `config.yaml`, `htpasswd` and the package storage out from under a
   * process that was still shutting down — a directory being swept while its owner still has
   * it open, which is the `ENOTEMPTY`/`EBUSY` family (#313). **That gap was watched rather
   * than argued**: against the two-line version this replaces, `close()` returned in about a
   * millisecond with the process still alive and its storage already gone; it now returns in
   * about six, with the process reaped first.
   *
   * Retrying the removal would only paper over it. The writer `removeAll` retries around is a
   * *detached* `git maintenance` no caller was ever handed; this one is a child of this
   * process, so the answer is to wait for it — the same wait `bootProject`'s `stop` in
   * `./project.ts` does, differing in the one detail below.
   *
   * **The `exited` flag rather than `child.exitCode`.** A process killed by a signal reports
   * `exitCode: null` for as long as it is dead, so a guard on that would fall through and
   * await an `exit` that has already been emitted — waiting forever. The flag is set by the
   * handler above whichever way the process went, and nothing can slip between reading it and
   * subscribing, because `exit` is emitted asynchronously and both lines run in one turn.
   *
   * **Nothing here can hang on a registry that ignores the signal**: verdaccio installs its
   * `SIGTERM` handler only under `VERDACCIO_HANDLE_KILL_SIGNALS`, which nothing in this
   * repository sets, so the signal keeps its default disposition. The removal below is left a
   * plain `rm` for the same reason the wait replaced a retry: with the process reaped there is
   * nothing left holding the directory open.
   */
  const close = async () => {
    if (exited === undefined) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
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
  options: PublishOptions = {},
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
      await run("pnpm", ["pack", "--pack-destination", destination], {
        cwd: absolute,
        timeout: PUBLISH_TIMEOUT,
      });
    }

    const tarballs = await readdir(destination);
    if (tarballs.length !== packageDirectories.length) {
      throw new Error(
        `Packing ${packageDirectories.length} package(s) produced ${tarballs.length} tarball(s): ${tarballs.join(", ")}`,
      );
    }

    for (const tarball of tarballs) {
      const published =
        options.version === undefined
          ? join(destination, tarball)
          : await republishedAs(join(destination, tarball), options.version, destination);

      await run("npm", ["publish", published, "--registry", registry.url], {
        cwd: repoRoot,
        env: { ...process.env, npm_config_userconfig: registry.npmrc },
        timeout: PUBLISH_TIMEOUT,
      });
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

export type PublishOptions = {
  /**
   * Publish these packages as this version instead of the one their manifests carry.
   *
   * **This is how #12's synthetic major exists.** ADR-0029 makes "the reference Project
   * upgrades cleanly across a Core major" a release gate, and a gate that ran only when
   * kobai actually released a major would run approximately never — so the gate manufactures
   * one, on every commit, out of the packages this commit built.
   *
   * It is a rewrite of one manifest field and nothing else, which is exactly what a real
   * version bump is. The tarball is the one `pnpm pack` produced, unpacked and repacked, so
   * the files inside it are the files `tests/packaged-migrations.test.ts` reads. Nothing in
   * the working tree is touched: a test that edited a manifest to publish it would leave a
   * dirty repository behind the moment it crashed, and `tests/publish-guard.test.ts` asserts
   * those versions stay in step.
   *
   * What it deliberately does *not* manufacture is a breaking change. There is none to make:
   * `1.0.0` here is `0.1.0`'s code under another number. So the gate proves the path a
   * Developer walks — bump, install, run the shipped command, boot, serve — and proves that
   * a deeply customised Project survives it. It does not prove that a codemod transforms
   * anything, because kobai ships none; `packages/core/src/upgrade/codemods.test.ts` is where
   * that is pinned down. See docs/adr/0035.
   */
  readonly version?: string;
};

/**
 * The same tarball, at another version.
 *
 * Every `@kobai/*` dependency moves too, and that is not a nicety: `pnpm pack` resolves a
 * `workspace:*` to an exact pin, so a `@kobai/plugin-price-log@1.0.0` still asking for
 * `@kobai/core@0.1.0` would install a *second* Core beside the new one. The Project would
 * then hold two Cores, two migration runners and two sets of Workflow declarations, and the
 * upgrade would appear to work while the Plugin talked to the old one.
 *
 * **One thing a real release may not copy from this.** It rewrites `manifest.version` and
 * nothing else, which is what makes it a faithful stand-in
 * for a version bump — except that since #158 a version bump is *two* edits: the manifest, and
 * `packages/core/openapi.json`, whose `info.version` is read from that manifest when the
 * description is generated (ADR-0060). So the tarball this produces serves one version and
 * carries a description naming another. Nothing is wrong here, because nothing asks: the upgrade
 * gate never reads the description's version.
 *
 * **A release process that bumped at publish time would ship exactly that mismatch**, to a
 * Developer consuming `@kobai/core/openapi.json`, which ADR-0006 makes the supported path for
 * anyone not writing TypeScript. So the version is bumped **in a commit**, with the artifacts
 * regenerated in that same commit — one entry on the list of what the first publish owes,
 * `docs/adr/0061-what-the-first-publish-owes.md`.
 */
async function republishedAs(
  tarball: string,
  version: string,
  workingDirectory: string,
): Promise<string> {
  const staged = await mkdtemp(join(workingDirectory, "staged-"));
  await run("tar", ["-xzf", tarball, "-C", staged]);

  const manifestPath = join(staged, "package", "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  manifest.version = version;

  for (const block of ["dependencies", "peerDependencies"] as const) {
    const dependencies = manifest[block];
    if (dependencies === null || typeof dependencies !== "object") continue;
    for (const name of Object.keys(dependencies as Record<string, string>)) {
      if (!name.startsWith("@kobai/")) continue;
      (dependencies as Record<string, string>)[name] = version;
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const republished = join(workingDirectory, `${version}-${basename(tarball)}`);
  await run("tar", ["-czf", republished, "-C", staged, "package"]);
  return republished;
}
