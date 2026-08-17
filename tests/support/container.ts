import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Enough Docker to build an image, look inside the one that was built, and boot it.
 *
 * **Looking inside the built image is the point.** A Dockerfile can be read and believed;
 * an image is what actually ships. The 933 MB image #12 inherited passed every review of
 * its Dockerfile — `pnpm install --prod` is right there in the runtime stage — because the
 * bug was that the command *relinks rather than prunes*, which no reading of the file
 * reveals and one `ls` inside the image does.
 *
 * A module rather than a detail inside one test file because two images are exercised: the
 * repository's, which `devbox run up` builds, and the one a generated Project builds for
 * itself from its own Dockerfile.
 */

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** A cold `docker build` installs every dependency and runs a Vite build inside it. */
const BUILD_TIMEOUT = 900_000;
/** `docker build` is chatty and its output is the only diagnosis when it fails. */
const MAX_BUFFER = 64 * 1024 * 1024;
/** Migrations against a real Postgres, from a container that has just started. */
const READY_TIMEOUT = 120_000;

export type BuiltImage = {
  readonly tag: string;
  /** What the image weighs, in bytes, as `docker image inspect` reports it. */
  size(): Promise<number>;
  /**
   * Runs a shell command inside a throwaway container off this image and returns stdout.
   *
   * The entrypoint is overridden, so this observes the filesystem the image ships without
   * starting the application or needing a database.
   */
  read(script: string): Promise<string>;
  remove(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

async function docker(args: string[], what: string): Promise<string> {
  try {
    const { stdout } = await run("docker", args, {
      cwd: repoRoot,
      timeout: BUILD_TIMEOUT,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
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
 * of one this file built directly, and the answers come from the same two commands.
 */
export function imageAt(tag: string): BuiltImage {
  const remove = async () => {
    // `--force` because a container off this image may still be going away.
    await run("docker", ["image", "rm", "--force", tag]).catch(() => undefined);
  };

  return {
    tag,
    async size() {
      const stdout = await docker(
        ["image", "inspect", tag, "--format", "{{.Size}}"],
        `\`docker image inspect\` could not read ${tag}.`,
      );
      return Number.parseInt(stdout.trim(), 10);
    },
    async read(script) {
      return docker(
        ["run", "--rm", "--entrypoint", "sh", tag, "-c", script],
        `Could not read inside the image ${tag}: \`${script}\` failed.`,
      );
    },
    remove,
    [Symbol.asyncDispose]: remove,
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
 * Waits for the log line rather than for the port, because a Project binds its listener
 * *before* migrations run so that `/health` can answer throughout (`reference/src/server.ts`).
 * A port that accepts connections therefore does not yet mean the schema is there, and a
 * request sent at that moment would be answered 503 by Core's own gate.
 */
export async function startContainer(options: {
  readonly image: string;
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * Names the host reachable as `host.docker.internal` from inside.
   *
   * Docker Desktop provides it; Linux does not, and the Postgres the gate runs against is
   * published on the host. Without this the container resolves nothing and the failure is a
   * DNS error rather than anything about kobai.
   */
  readonly hostGateway?: boolean;
}): Promise<RunningContainer> {
  const { image, name, env, hostGateway = true } = options;

  const args = ["run", "--detach", "--name", name, "--publish", "127.0.0.1::3000"];
  if (hostGateway) args.push("--add-host", "host.docker.internal:host-gateway");
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
  args.push(image);

  await docker(args, `\`docker run\` could not start ${image}.`);

  const logs = async () => {
    const { stdout, stderr } = await run("docker", ["logs", name], {
      maxBuffer: MAX_BUFFER,
    }).catch(() => ({ stdout: "", stderr: "" }));
    return `${stdout}${stderr}`;
  };

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
    const origin = `http://127.0.0.1:${port}`;

    const deadline = Date.now() + READY_TIMEOUT;
    while (Date.now() < deadline) {
      const output = await logs();
      if (output.includes('"message":"ready"')) {
        return { origin, logs, stop, [Symbol.asyncDispose]: stop };
      }

      const { stdout: state } = await run("docker", [
        "inspect",
        name,
        "--format",
        "{{.State.Status}} {{.State.ExitCode}}",
      ]);
      if (state.startsWith("exited")) {
        throw new Error(
          `The container exited (${state.trim()}) instead of becoming ready. Its output:\n${output}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
      `The container never printed \`ready\` within ${READY_TIMEOUT}ms. Its output:\n${await logs()}`,
    );
  } catch (cause) {
    await stop();
    throw cause;
  }
}

/**
 * A database URL a container can dial, from one that only works on this machine.
 *
 * The gate's Postgres is published on the host on a port derived from the checkout's path
 * (#21), so `127.0.0.1` inside a container is the container itself and reaches nothing.
 */
export function fromContainer(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.hostname = "host.docker.internal";
  return url.toString();
}

export type ComposeProject = {
  /** Where the `app` service answers, from this machine. */
  readonly origin: string;
  /** The image compose built for `app`, so it can be inspected like any other. */
  readonly appImage: string;
  logs(): Promise<string>;
  down(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
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
   * `POSTGRES_PORT` and `PORT`, which the gate must override rather than inherit.
   *
   * `devbox run ci` exports a `POSTGRES_PORT` of its own in front of every script (#21), and
   * a nested compose project inheriting it would try to publish this Project's Postgres on
   * the port the repository's is already on. Overriding it here changes nothing about the
   * repository's own database — it is one child process's environment.
   */
  readonly env: Readonly<Record<string, string>>;
  /** The host port `PORT` publishes the application on. */
  readonly appPort: number;
}): Promise<ComposeProject> {
  const { directory, files, projectName, env, appPort } = options;
  const base = ["compose", "--project-name", projectName];
  for (const file of files) base.push("--file", file);

  const compose = (args: string[], what: string) =>
    composeDocker(directory, env, [...base, ...args], what);

  const down = async () => {
    await run("docker", [...base, "down", "--volumes", "--remove-orphans"], {
      cwd: directory,
      env: { ...process.env, ...env },
      timeout: BUILD_TIMEOUT,
      maxBuffer: MAX_BUFFER,
    }).catch(() => undefined);
  };

  const logs = async () => compose(["logs", "app"], "").catch(() => "");

  try {
    await compose(
      ["up", "--build", "--detach"],
      "`docker compose up --build` failed on the Project's own compose file. Nothing below it ran.",
    );

    const deadline = Date.now() + READY_TIMEOUT;
    while (Date.now() < deadline) {
      const output = await logs();
      if (output.includes('"message":"ready"')) {
        return {
          origin: `http://127.0.0.1:${appPort}`,
          appImage: `${projectName}-app`,
          logs,
          down,
          [Symbol.asyncDispose]: down,
        };
      }
      const state = await compose(
        ["ps", "--all", "--format", "{{.Service}} {{.State}}"],
        "",
      );
      if (/^app exited/m.test(state)) {
        throw new Error(
          `The Project's \`app\` service exited instead of becoming ready.\n\n${state}\n\nIts output:\n${output}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
      `The Project's \`app\` service never printed \`ready\` within ${READY_TIMEOUT}ms. Its output:\n${await logs()}`,
    );
  } catch (cause) {
    await down();
    throw cause;
  }
}

async function composeDocker(
  cwd: string,
  env: Readonly<Record<string, string>>,
  args: string[],
  what: string,
): Promise<string> {
  try {
    const { stdout, stderr } = await run("docker", args, {
      cwd,
      env: { ...process.env, ...env },
      timeout: BUILD_TIMEOUT,
      maxBuffer: MAX_BUFFER,
    });
    // Compose writes progress to stderr and `logs` output to both, so a caller reading
    // either has to be handed both.
    return `${stdout}${stderr}`;
  } catch (cause) {
    const { stdout = "", stderr = "" } = cause as { stdout?: string; stderr?: string };
    throw new Error(`${what}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`, { cause });
  }
}
