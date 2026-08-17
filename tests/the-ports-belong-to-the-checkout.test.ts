import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDevbox, runInitHook } from "./support/init-hook.ts";

/**
 * The ports in `devbox.json`'s `init_hook`, run rather than read.
 *
 * Two checkouts of kobai — a second clone, a git worktree — differ by their path and nothing
 * else, so the hook hashes that path into a Postgres port (#21) and an application port
 * (#61) and exports both in front of every script. `AGENTS.md` § The ports belong to the
 * checkout is the prose; this is what holds it up.
 *
 * Running the hook rather than reading it is what makes that possible at all, and
 * `tests/support/init-hook.ts` is where that lives — the credentials the same hook carries
 * are asserted next door, against the same runner.
 */

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

/** Runs the hook against a checkout and reports the three names this file is about. */
async function derive(options: {
  readonly root: string;
  readonly env?: Readonly<Record<string, string>>;
}): Promise<DerivedAddresses> {
  const derived = await runInitHook({
    ...options,
    report: ["PORT", "POSTGRES_PORT", "COMPOSE_PROJECT_NAME"],
  });

  return {
    port: Number(derived.PORT),
    postgresPort: Number(derived.POSTGRES_PORT),
    composeProjectName: derived.COMPOSE_PROJECT_NAME,
  };
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
