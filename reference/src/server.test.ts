import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@kobai/core/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * The one seam that cannot be reached in-process: the process itself.
 *
 * Everything else in this repository dispatches HTTP straight at the application object.
 * "Exits non-zero" is not a property of an application object, so this spawns the real
 * entrypoint — the built artifact the Dockerfile runs — and watches what it does.
 */
const entrypoint = fileURLToPath(new URL("../dist/src/server.js", import.meta.url));

let child: ChildProcess | undefined;
let database: TestDatabase | undefined;

beforeAll(() => {
  if (!existsSync(entrypoint)) {
    throw new Error(
      `${entrypoint} does not exist. This test runs the shipped artifact rather than the source, so it needs a build first: \`devbox run build\` (or \`devbox run ci\`, which builds).`,
    );
  }
});

afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  await database?.drop();
  database = undefined;
});

describe("the reference Project's entrypoint", () => {
  it("boots, migrates, and serves health on the port it was given", async () => {
    database = await createTestDatabase();
    child = start(database.url);
    const output = capture(child);

    const listening = await waitForLog(child, output, "listening");
    // The listener binds before migrations run, so that /health can answer throughout —
    // that is what makes a booting instance distinguishable from a broken one. "ready" is
    // logged only once they have applied.
    await waitForLog(child, output, "ready");
    const response = await fetch(`http://127.0.0.1:${listening.port}/health`);

    expect(response.status).toBe(200);
    // All three sets, from the *built* artifact: a Plugin resolves its migrations folder
    // relative to its own module, so this is where a package that ships `dist` but forgets
    // to ship `migrations` would be caught. Source-resolved tests never see that.
    //
    // `project` is this Project's own set, and it is the one this assertion most needs to
    // run against the built artifact. It resolves `migrations/` by asking Node where this
    // Project's `package.json` is, precisely because `src/` and `dist/src/` sit at
    // different depths — a path correct in source and wrong in `dist` would apply no
    // migrations at all rather than throwing, and only a test of the built thing sees it.
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      migrations: {
        sets: [{ name: "core" }, { name: "plugin-price-log" }, { name: "project" }],
      },
    });
  });

  it("exits non-zero, and serves nothing, when a migration fails", async () => {
    database = await createTestDatabase();
    // Core's first migration creates `core_store`. Getting there first makes it fail for a
    // reason a real deployment can hit — someone's hand-rolled table, a partial restore —
    // rather than by taking the database away.
    await database.query('create table "core_store" (squatter text)');

    child = start(database.url);
    const output = capture(child);

    const exitCode = await waitForExit(child);

    expect(exitCode).toBe(1);
    expect(output()).toContain("refusing to start");
    // It never declared itself ready, so nothing downstream was ever told to send it work.
    expect(output()).not.toContain('"ready"');
  });
});

function start(databaseUrl: string): ChildProcess {
  return spawn(process.execPath, [entrypoint], {
    // PORT=0 lets the kernel pick, so concurrent test files never collide on a port.
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function capture(process: ChildProcess): () => string {
  let output = "";
  const append = (chunk: unknown) => {
    output += String(chunk);
  };
  process.stdout?.on("data", append);
  process.stderr?.on("data", append);
  return () => output;
}

type LogLine = { message?: string; port?: number };

async function waitForLog(
  process: ChildProcess,
  output: () => string,
  message: string,
): Promise<LogLine> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const line of output().split("\n")) {
      const parsed = parseLog(line);
      if (parsed?.message === message) return parsed;
    }
    if (process.exitCode !== null) break;
    await sleep(50);
  }
  throw new Error(`The server never logged "${message}". Its output was:\n${output()}`);
}

function parseLog(line: string): LogLine | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as LogLine;
  } catch {
    return undefined;
  }
}

function waitForExit(process: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The server did not exit within 20s.")),
      20_000,
    );
    process.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
