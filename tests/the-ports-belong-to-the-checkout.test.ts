import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The derivation in `devbox.json`'s `init_hook`, run rather than read.
 *
 * Two checkouts of kobai — a second clone, a git worktree — differ by their path and nothing
 * else, so the hook hashes that path into a Postgres port (#21) and an application port
 * (#61) and exports both in front of every script. `AGENTS.md` § The ports belong to the
 * checkout is the prose; this is what holds it up.
 *
 * It has to *execute* the hook. The gate always runs with those variables already exported,
 * so every other test in this repository sees the result and none of them can see the rule
 * that produced it: a hook that had stopped deriving anything, and simply left the fallbacks
 * standing, would be green everywhere until two Developers ran `devbox run up` at once. The
 * lines are therefore read out of `devbox.json` and handed to `sh`, with the checkout and
 * the environment this file chooses.
 *
 * Reading those lines rather than restating them is the whole arrangement — a second copy of
 * the derivation here would agree with itself forever.
 */

const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

/** What the hook hands every script, and what this file asks it for. */
type DerivedAddresses = {
  readonly port: number;
  readonly postgresPort: number;
  readonly composeProjectName: string;
};

/**
 * Two checkouts, written down rather than made.
 *
 * `DEVBOX_PROJECT_ROOT` is only hashed and looked in for a `.env`, so a path that does not
 * exist derives exactly what a real checkout there would — and a fixed pair keeps this
 * deterministic, where two `mkdtemp` names would re-roll the dice on every run.
 */
const ONE_CHECKOUT = "/checkouts/kobai";
const ANOTHER_CHECKOUT = "/checkouts/kobai-worktree";

/** The ranges `AGENTS.md` promises: the port each service is known by, with a 5 in front. */
const APPLICATION_RANGE = { from: 53000, to: 53999 } as const;
const POSTGRES_RANGE = { from: 55000, to: 55999 } as const;

type DevboxConfig = {
  shell?: {
    init_hook?: string[] | null;
    scripts?: Record<string, string> | null;
  } | null;
};

async function readDevbox(): Promise<DevboxConfig> {
  const contents = await readFile(
    fileURLToPath(new URL("devbox.json", repoRoot)),
    "utf8",
  );
  const errors: ParseError[] = [];
  // `allowTrailingComma` because `devbox add` rewrites the file in that style, which
  // `tests/no-push-script.test.ts` has to allow for too.
  const config = parseJsonc(contents, errors, {
    allowTrailingComma: true,
  }) as DevboxConfig;

  const [failure] = errors;
  if (failure !== undefined) {
    throw new Error(
      `devbox.json did not parse: ${printParseErrorCode(failure.error)} at offset ${failure.offset}.`,
    );
  }
  return config;
}

/**
 * Runs the hook against a checkout and reports what a script would have been given.
 *
 * The environment is built from `PATH` and what a caller passes, and nothing else. Under the
 * gate this process already carries a derived `PORT` and `POSTGRES_PORT` — devbox exported
 * them before vitest started — and inheriting those would pin every case below to whatever
 * the checkout running the suite happens to have, which is the one thing that must not
 * decide the answer.
 *
 * `corepack` is stubbed rather than run: the hook's first line activates pnpm, has nothing to
 * do with an address, and would otherwise write into a directory this test only invented.
 */
async function derive(options: {
  readonly root: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<DerivedAddresses> {
  const { shell } = await readDevbox();
  const lines = shell?.init_hook ?? [];
  if (lines.length === 0) {
    // Failing open would be worse than failing: with no lines to run, every assertion below
    // would be about an empty script rather than about the derivation.
    throw new Error(
      "devbox.json declares no `shell.init_hook`, so there is no derivation to run. That is where PORT, POSTGRES_PORT, COMPOSE_PROJECT_NAME and both database addresses are set.",
    );
  }

  const script = [
    "corepack() { :; }",
    ...lines,
    'printf "%s\\n%s\\n%s\\n" "$PORT" "$POSTGRES_PORT" "$COMPOSE_PROJECT_NAME"',
  ].join("\n");

  const { stdout } = await run("sh", ["-c", script], {
    env: {
      PATH: process.env.PATH ?? "",
      DEVBOX_PROJECT_ROOT: options.root,
      ...options.env,
    },
  });

  const [port, postgresPort, composeProjectName] = stdout.trim().split("\n");
  if (
    port === undefined ||
    postgresPort === undefined ||
    composeProjectName === undefined
  ) {
    throw new Error(
      `The hook reported fewer than the three values asked of it:\n${stdout}`,
    );
  }

  return { port: Number(port), postgresPort: Number(postgresPort), composeProjectName };
}

let workspace: string;

/** A checkout that exists, because a pin in `.env` needs a file to be read out of. */
async function checkoutPinning(dotenv: string): Promise<string> {
  const root = await mkdtemp(join(workspace, "checkout-"));
  await writeFile(join(root, ".env"), dotenv);
  return root;
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "kobai-derived-ports-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("the ports a checkout derives", () => {
  it("gives the application a port of its own, in the range AGENTS.md promises", async () => {
    const { port } = await derive({ root: ONE_CHECKOUT });

    expect(port).toBeGreaterThanOrEqual(APPLICATION_RANGE.from);
    expect(port).toBeLessThanOrEqual(APPLICATION_RANGE.to);
  });

  it("keeps the database in its own range, well clear of the application's", async () => {
    const { postgresPort } = await derive({ root: ONE_CHECKOUT });

    expect(postgresPort).toBeGreaterThanOrEqual(POSTGRES_RANGE.from);
    expect(postgresPort).toBeLessThanOrEqual(POSTGRES_RANGE.to);
  });

  it("derives both ports from one number, so a `docker ps` reads as one checkout", async () => {
    const { port, postgresPort } = await derive({ root: ONE_CHECKOUT });

    expect(
      port - APPLICATION_RANGE.from,
      "The two ports no longer share their last three digits, so 53154 beside 55154 no longer reads as one checkout. Both are meant to come from the same hash.",
    ).toBe(postgresPort - POSTGRES_RANGE.from);
  });

  it("gives a second checkout different ports, with nothing passed by hand", async () => {
    // The whole ticket, in two lines: this is the collision a Developer hits when one
    // checkout is already serving and another runs `devbox run up`.
    const one = await derive({ root: ONE_CHECKOUT });
    const another = await derive({ root: ANOTHER_CHECKOUT });

    expect(another.port).not.toBe(one.port);
    expect(another.postgresPort).not.toBe(one.postgresPort);
    expect(another.composeProjectName).not.toBe(one.composeProjectName);
  });

  it("gives one checkout the same ports every time", async () => {
    // Why the path is hashed rather than a free port taken: a container outlives the run
    // that started it, and yesterday's has to still be findable today.
    const first = await derive({ root: ONE_CHECKOUT });
    const again = await derive({ root: ONE_CHECKOUT });

    expect(again).toEqual(first);
  });
});

describe("an explicit port still wins", () => {
  it("takes PORT from the environment", async () => {
    const { port } = await derive({ root: ONE_CHECKOUT, env: { PORT: "3000" } });

    expect(port).toBe(3000);
  });

  it("takes PORT from `.env`, which is where a Developer is told to put it", async () => {
    // docker compose reads that file too, so a pin it honoured while devbox derived over the
    // top of it would be #21's disagreement in a new place.
    const root = await checkoutPinning("PORT=4321\nPOSTGRES_PORT=54321\n");

    const { port, postgresPort } = await derive({ root });

    expect(port).toBe(4321);
    expect(postgresPort).toBe(54321);
  });

  it("lets the environment beat `.env`", async () => {
    const root = await checkoutPinning("PORT=4321\n");

    const { port } = await derive({ root, env: { PORT: "5000" } });

    expect(port).toBe(5000);
  });

  it("does not mistake POSTGRES_PORT for the application's", async () => {
    // Both names end in `PORT`, and a reader anchored loosely enough to match the longer one
    // would hand the application the database's port.
    const root = await checkoutPinning("POSTGRES_PORT=54321\n");

    const { port, postgresPort } = await derive({ root });

    expect(postgresPort).toBe(54321);
    expect(port).toBeGreaterThanOrEqual(APPLICATION_RANGE.from);
    expect(port).toBeLessThanOrEqual(APPLICATION_RANGE.to);
  });
});

describe("`devbox run up` says where it is serving", () => {
  it("prints a URL built from the variable compose publishes on", async () => {
    // A derived database port needs no announcement; a derived application port does, because
    // a Developer types it into a browser. An `up` that stopped saying so would leave them
    // reading `docker ps` for the address 3000 used to give them for free.
    const { shell } = await readDevbox();
    const up = shell?.scripts?.up;

    expect(up, "devbox.json declares no `up` script.").toBeDefined();
    expect(up).toContain("http://localhost");
    expect(
      up,
      "`devbox run up` prints an address that is not built from PORT, which is the variable `compose.yaml` publishes the app service on — so the two can now disagree.",
    ).toContain("PORT");
  });
});
