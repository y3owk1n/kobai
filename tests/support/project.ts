import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

/**
 * Running commands in a generated Project, and booting one.
 *
 * Shared because two tests drive a Project on this machine rather than in a container —
 * `a-generated-project-boots.test.ts`, which proves one can be generated and served, and
 * `the-upgrade-gate.test.ts`, which does it twice around a version bump.
 */

const run = promisify(execFile);

/** An install, a TypeScript build, a Vite build and a boot, on a cold CI runner. */
export const PROJECT_TIMEOUT = 900_000;

/**
 * Runs a command in a Project, and on failure says what it printed.
 *
 * `execFile`'s own error is `Command failed: pnpm -r build` and nothing else, which here is
 * the least useful sentence available: everything that can go wrong goes wrong inside a
 * compiler or a package manager, and all of the diagnosis is in the output it throws away.
 */
export async function runInProject(
  directory: string,
  command: string,
  args: readonly string[],
  /**
   * Added to the environment the command runs in, never replacing it — a Project's install
   * needs the caller's PATH, HOME and pnpm store to work at all. What this is for is a test
   * that needs a command to meet an environment the machine it runs on does not have; see
   * the `CI` set on the upgrade in `the-upgrade-gate.test.ts`.
   */
  environment: Readonly<Record<string, string>> = {},
): Promise<string> {
  try {
    const { stdout } = await run(command, [...args], {
      cwd: directory,
      env: { ...process.env, ...environment },
      timeout: PROJECT_TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (cause) {
    const { stdout = "", stderr = "" } = cause as { stdout?: string; stderr?: string };
    throw new Error(
      `\`${command} ${args.join(" ")}\` failed in the Project at ${directory}.\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
      { cause },
    );
  }
}

export type BootedProject = {
  readonly origin: string;
  /** Everything it printed, for an assertion that needs to say why it failed. */
  logs(): string;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * Starts a Project the way its own Dockerfile does — `node dist/src/server.js`, the built
 * artifact, against a real database — and waits for it to say it is ready.
 *
 * Waits for the log rather than polling a port because a Project binds its listener *before*
 * migrations run, deliberately, so that `/health` can answer throughout. A port that accepts
 * connections therefore does not yet mean the schema is there.
 */
export async function bootProject(
  directory: string,
  databaseUrl: string,
  /**
   * Anything else the Project's environment must carry — `KOBAI_INITIAL_MERCHANT_*` for a
   * test that then signs in, since the first Merchant is seeded at boot and cannot be
   * created over HTTP (#25).
   */
  environment: Readonly<Record<string, string>> = {},
): Promise<BootedProject> {
  const child = spawn("node", ["dist/src/server.js"], {
    cwd: directory,
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: "0", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  };

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `The Project exited with ${child.exitCode} instead of serving. Its output:\n${output}`,
      );
    }

    // `listening` carries the port it actually bound; `ready` means migrations applied.
    const port = /"port":\s*(\d+)/.exec(output)?.[1];
    if (port !== undefined && output.includes("ready")) {
      return {
        origin: `http://127.0.0.1:${port}`,
        logs: () => output,
        stop,
        [Symbol.asyncDispose]: stop,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await stop();
  throw new Error(`The Project never became ready. Its output:\n${output}`);
}
