import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Enough Docker to build an image, ask the one that was built what it contains, and boot it.
 *
 * **Asking the built image is the point.** A Dockerfile can be read and believed; an image
 * is what actually ships. The 933 MB image #12 inherited survived every reading of its
 * Dockerfile — `pnpm install --prod` is right there in the runtime stage — because the bug
 * was that the command *relinks rather than prunes*, which no reading of the file reveals
 * and one `ls` inside the image does.
 *
 * A module rather than a detail inside one test file because two images are exercised: the
 * repository's, which `devbox run up` builds, and the one a generated Project builds for
 * itself from its own Dockerfile and brings up with its own compose file.
 */

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** A cold `docker build` installs every dependency and runs a Vite build inside it. */
const BUILD_TIMEOUT = 900_000;
/** `docker build` is chatty and its output is the only diagnosis when it fails. */
const MAX_BUFFER = 64 * 1024 * 1024;
/** Migrations against a real Postgres, from a container that has just started. */
const READY_TIMEOUT = 120_000;
/** What the application prints once every migration set has applied. */
const READY = '"message":"ready"';

export type BuiltImage = {
  readonly tag: string;
  /**
   * Whichever of these npm package names the image has installed.
   *
   * Asked as a set rather than one at a time so a failure names every offender at once —
   * "these four build tools are in the image" is a finding, and four separate failures are
   * four guesses at the same one.
   */
  installs(names: readonly string[]): Promise<string[]>;
  /** Whether a path exists inside the image. */
  has(path: string): Promise<boolean>;
  /** What a path weighs inside the image, in kilobytes. */
  kilobytesOf(path: string): Promise<number>;
  /** Every path inside the image matching a shell glob; empty when nothing matches. */
  list(glob: string): Promise<string[]>;
  /**
   * Every file under `within` whose bytes contain `text`.
   *
   * For asking whether a credential shipped. A container off an image sees that image's
   * layers flattened, and a multi-stage build's earlier stages are not among them, so this
   * reads exactly what somebody who pulled the image would be able to read.
   */
  grep(text: string, within: string): Promise<string[]>;
  remove(): Promise<void>;
};

type DockerOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Return what the command wrote to stderr as well.
   *
   * `docker compose` writes progress there and interleaves `logs` output across both, so a
   * caller reading either has to be handed both. Everything parsed rather than searched
   * wants stdout alone, because a warning on stderr would land in the middle of it.
   */
  readonly includeStderr?: boolean;
};

async function docker(
  args: string[],
  what: string,
  options: DockerOptions = {},
): Promise<string> {
  const { cwd = repoRoot, env, includeStderr = false } = options;
  try {
    const { stdout, stderr } = await run("docker", args, {
      cwd,
      env: env === undefined ? process.env : { ...process.env, ...env },
      timeout: BUILD_TIMEOUT,
      maxBuffer: MAX_BUFFER,
    });
    return includeStderr ? `${stdout}${stderr}` : stdout;
  } catch (cause) {
    const { stdout = "", stderr = "" } = cause as { stdout?: string; stderr?: string };
    throw new Error(`${what}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`, { cause });
  }
}

export async function buildImage(options: {
  /** Unique per run, so two checkouts building at once do not overwrite each other's. */
  readonly tag: string;
  /** The build context, absolute. */
  readonly context: string;
  /** The Dockerfile, absolute. */
  readonly dockerfile: string;
}): Promise<BuiltImage> {
  const { tag, context, dockerfile } = options;

  await docker(
    ["build", "--tag", tag, "--file", dockerfile, context],
    `\`docker build\` failed for ${dockerfile}. The image under test was never produced, so nothing below it ran.`,
  );

  return imageAt(tag);
}

/**
 * An image somebody else built, by tag — `docker compose build` among them.
 *
 * The same questions are worth asking of an image a Project's own compose file produced as
 * of one this module built directly, and the answers come from the same two commands.
 */
export function imageAt(tag: string): BuiltImage {
  /**
   * Runs a shell command inside a throwaway container off this image.
   *
   * The entrypoint is overridden, so this observes the filesystem the image ships without
   * starting the application or needing a database.
   */
  const read = (script: string) =>
    docker(
      ["run", "--rm", "--entrypoint", "sh", tag, "-c", script],
      `Could not read inside the image ${tag}: \`${script}\` failed.`,
    );

  return {
    tag,

    async installs(names) {
      // One directory per installed package version, named `<name>@<version>` with `/`
      // written as `+`. Workspace packages are symlinked rather than stored here, which is
      // right: those are the ones that *should* ship.
      const entries = (await read("ls node_modules/.pnpm")).split("\n").filter(Boolean);
      return names.filter((name) =>
        entries.some((entry) => entry.startsWith(`${name.replace("/", "+")}@`)),
      );
    },

    async has(path) {
      return (await read(`test -e '${path}' && echo yes || echo no`)).trim() === "yes";
    },

    async kilobytesOf(path) {
      const measured = Number.parseInt(
        (await read(`du -sk '${path}'`)).trim().split(/\s+/)[0] ?? "",
        10,
      );
      if (!Number.isFinite(measured)) {
        throw new Error(`\`du -sk ${path}\` inside ${tag} reported nothing measurable.`);
      }
      return measured;
    },

    async grep(text, within) {
      if (!/^[\w.@:/-]+$/.test(text)) {
        // Every caller passes a constant, and keeping it that way is what lets this go
        // through a shell at all.
        throw new Error(
          `Refusing to search the image for ${JSON.stringify(text)}: this runs through a shell and takes plain text only.`,
        );
      }
      const found = await read(
        `grep -rlI -F -- '${text}' '${within}' 2>/dev/null || true`,
      );
      return found.split("\n").filter(Boolean);
    },

    async list(glob) {
      // `|| true` so a glob matching nothing is an empty list rather than a failed command:
      // "the image has none of these" is an answer this asks for on purpose.
      const listed = await read(`ls ${glob} 2>/dev/null || true`);
      return listed.split("\n").filter(Boolean);
    },

    async remove() {
      // `--force` because a container off this image may still be going away.
      await run("docker", ["image", "rm", "--force", tag]).catch(() => undefined);
    },
  };
}

export type RunningContainer = {
  /** Where the application answers, from this machine. */
  readonly origin: string;
  /** Everything the container has printed, for a failure that needs to say why. */
  logs(): Promise<string>;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * Starts a container off an image and waits until it says it is ready.
 *
 * `host.docker.internal` is always named, because the Postgres the gate runs against is
 * published on the host and Linux provides no such name of its own. Without it the container
 * fails to resolve an address and the error is about DNS rather than about kobai.
 */
export async function startContainer(options: {
  readonly image: string;
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<RunningContainer> {
  const { image, name, env } = options;

  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::3000",
    "--add-host",
    "host.docker.internal:host-gateway",
  ];
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
  args.push(image);

  await docker(args, `\`docker run\` could not start ${image}.`);

  const logs = async () =>
    docker(["logs", name], "", { includeStderr: true }).catch(() => "");

  const stop = async () => {
    await run("docker", ["rm", "--force", name]).catch(() => undefined);
  };

  try {
    const published = await docker(
      ["port", name, "3000/tcp"],
      `\`docker port\` could not say where ${name} published its port.`,
    );
    const port = published.trim().split("\n")[0]?.split(":").pop();
    if (port === undefined) {
      throw new Error(`${name} published no host port for 3000: ${published}`);
    }

    await waitForReady({
      what: "The container",
      logs,
      exited: async () => {
        const state = await docker(
          ["inspect", name, "--format", "{{.State.Status}} {{.State.ExitCode}}"],
          `\`docker inspect\` could not read the state of ${name}.`,
        );
        return state.startsWith("exited") ? state.trim() : undefined;
      },
    });

    return {
      origin: `http://127.0.0.1:${port}`,
      logs,
      stop,
      [Symbol.asyncDispose]: stop,
    };
  } catch (cause) {
    await stop();
    throw cause;
  }
}

export type ComposeProject = {
  /** Where the `app` service answers, from this machine. */
  readonly origin: string;
  /** The image compose built for `app`, so it can be asked what it contains. */
  readonly appImage: string;
  logs(): Promise<string>;
  /**
   * Throws the `app` container away and starts another off the same image, waiting until it
   * is ready again.
   *
   * **A redeploy, minus the rebuild** — which is the half that decides where a Project's
   * uploaded files were. A container's own filesystem goes with the container and a mounted
   * volume does not, so this is the only question that can tell the two apart, and reading a
   * file back afterwards is the only way to ask it. `--no-deps`, so the database this Project
   * has been using is left running underneath exactly as a real redeploy leaves it.
   */
  recreateApp(): Promise<void>;
  down(): Promise<void>;
};

/**
 * Brings a compose file up and waits for its `app` service to say it is ready.
 *
 * This is how `reference/compose.yaml` and `reference/Dockerfile` stop being generated files
 * nobody runs. They are what every Developer receives from `create-kobai` and what
 * `docker compose up` executes on their first afternoon, and until #12 the only thing that
 * had ever read them was a byte comparison against the template (ADR-0034 records the gap).
 */
export async function composeUp(options: {
  /** The Project directory — compose resolves the build context against it. */
  readonly directory: string;
  /** Compose files, in order, absolute. */
  readonly files: readonly string[];
  /** Unique, so this compose project owns its own containers, network and volume. */
  readonly projectName: string;
  /**
   * Whatever this compose file reads out of the environment — the two ports at least.
   *
   * `POSTGRES_PORT` and `PORT` have to be *overridden* rather than inherited: `devbox run ci`
   * exports a `POSTGRES_PORT` of its own in front of every script (#21), and a nested compose
   * project inheriting it would try to publish this Project's Postgres on the port the
   * repository's is already on. Doing it here changes nothing about the repository's own
   * database — it is one child process's environment. Anything else a test needs the running
   * Project configured with travels the same way, because the compose file forwards it by
   * name and reads no `.env` this test wrote.
   */
  readonly env: Readonly<Record<string, string>>;
  /** The host port `PORT` publishes the application on. */
  readonly appPort: number;
}): Promise<ComposeProject> {
  const { directory, files, projectName, env, appPort } = options;
  const base = ["compose", "--project-name", projectName];
  for (const file of files) base.push("--file", file);

  const compose = (args: string[], what: string) =>
    docker([...base, ...args], what, { cwd: directory, env, includeStderr: true });

  const down = async () => {
    await run("docker", [...base, "down", "--volumes", "--remove-orphans"], {
      cwd: directory,
      env: { ...process.env, ...env },
      timeout: BUILD_TIMEOUT,
      maxBuffer: MAX_BUFFER,
    }).catch(() => undefined);
  };

  const logs = async () => compose(["logs", "app"], "").catch(() => "");

  const exited = async () => {
    const state = await compose(
      ["ps", "--all", "--format", "{{.Service}} {{.State}}"],
      "`docker compose ps` could not read the Project's services.",
    );
    return /^app exited/m.test(state) ? state.trim() : undefined;
  };

  const recreateApp = async () => {
    await compose(
      ["up", "--detach", "--force-recreate", "--no-deps", "app"],
      "`docker compose up --force-recreate app` failed, so the Project was never redeployed and nothing below it was asked.",
    );
    await waitForReady({
      what: "The Project's `app` service, after being recreated",
      logs,
      exited,
    });
  };

  try {
    await compose(
      ["up", "--build", "--detach"],
      "`docker compose up --build` failed on the Project's own compose file. Nothing below it ran.",
    );

    await waitForReady({ what: "The Project's `app` service", logs, exited });

    return {
      origin: `http://127.0.0.1:${appPort}`,
      appImage: `${projectName}-app`,
      logs,
      recreateApp,
      down,
    };
  } catch (cause) {
    await down();
    throw cause;
  }
}

/**
 * Waits for the application to print `ready`, rather than for its port to accept.
 *
 * A Project binds its listener *before* migrations run so that `/health` can answer
 * throughout (`reference/src/server.ts`), so a port that accepts connections does not yet
 * mean the schema is there — a request sent at that moment is answered 503 by Core's own
 * gate. Every way out of this loop says which of the three things happened: it became ready,
 * it exited, or it never did either — and the last two carry the output, because a bare
 * timeout is the least useful sentence available here.
 */
async function waitForReady(options: {
  readonly what: string;
  readonly logs: () => Promise<string>;
  readonly exited: () => Promise<string | undefined>;
}): Promise<void> {
  const { what, logs, exited } = options;
  const deadline = Date.now() + READY_TIMEOUT;

  while (Date.now() < deadline) {
    const output = await logs();
    if (output.includes(READY)) return;

    const state = await exited();
    if (state !== undefined) {
      throw new Error(
        `${what} exited (${state}) instead of becoming ready. Its output:\n${output}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `${what} never printed \`ready\` within ${READY_TIMEOUT}ms. Its output:\n${await logs()}`,
  );
}

/**
 * A database URL a container can dial, from one that only works on this machine.
 *
 * The gate's Postgres is published on the host on a port derived from the checkout's path
 * (#21), so `127.0.0.1` inside a container is the container itself and reaches nothing.
 */
export function databaseUrlForContainer(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.hostname = "host.docker.internal";
  return url.toString();
}
