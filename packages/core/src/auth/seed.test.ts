import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../config.ts";
import { createKobai } from "../kobai.ts";
import {
  createTestKobai,
  signInTestMerchant,
  silentLogger,
  type TestKobai,
} from "../testing/index.ts";

/**
 * The first Merchant, seeded at boot from what the deployment was configured with.
 *
 * There is no other way to create one on a fresh deployment: Core has no unauthenticated
 * write path (#25), so `POST /admin/merchants` is an ordinary guarded route and somebody has
 * to hold `merchant:write` before it can be called at all. This is where that somebody comes
 * from.
 *
 * Everything here is asserted through the seam a Project actually uses — `createKobai` with
 * the credentials its environment supplied, then `seedInitialMerchant()` beside `migrate()` —
 * and confirmed through the public HTTP API, because a Merchant nobody can sign in as is not
 * a Merchant.
 */

/**
 * The instance under test, closed by `afterEach` as in `auth.test.ts` and `health.test.ts`.
 *
 * Three tests below open a *second* instance and dispose it themselves, with `await using` or
 * a `finally` — a second boot against the same database, and one instance per case of a
 * loop. Neither belongs to the whole test, so neither belongs here.
 */
let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

const CREDENTIALS = {
  email: "owner@example.test",
  password: "the owner's very long password",
};

const signIn = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("seeding the first Merchant", () => {
  it("creates one a Merchant can then sign in as", async () => {
    kobai = await createTestKobai({ initialMerchant: CREDENTIALS });

    const seeded = await kobai.seedInitialMerchant();

    expect(seeded).toMatchObject({ status: "seeded" });
    // Through the public API, because credentials that only work inside the process are
    // not credentials. The Role is the seeded `owner`, which holds every permission Core
    // defines — including the `merchant:write` that adding a colleague now needs.
    const signedIn = await kobai.request("/admin/session", signIn(CREDENTIALS));
    expect(signedIn.status).toBe(201);
    await expect(signedIn.json()).resolves.toMatchObject({
      merchant: { email: CREDENTIALS.email },
      role: { name: "owner" },
    });
  });

  it("stores the credential exactly as a signed-in Merchant's is stored", async () => {
    kobai = await createTestKobai({ initialMerchant: CREDENTIALS });

    await kobai.seedInitialMerchant();

    const [row] = await kobai.database.query<{ merchant: string }>(
      "select to_jsonb(core_merchant)::text as merchant from core_merchant",
    );
    // The same bargain `POST /admin/merchants` makes, and the reason seeding goes through
    // the same code path rather than writing a row of its own: a password that arrived from
    // an environment is still never recoverable from anything kobai stores.
    expect(row?.merchant).not.toContain(CREDENTIALS.password);
    expect(row?.merchant).toContain("$argon2id$");
  });
});

describe("booting twice", () => {
  it("creates no second Merchant, and says the second boot changed nothing", async () => {
    kobai = await createTestKobai({ initialMerchant: CREDENTIALS });

    const first = await kobai.seedInitialMerchant();
    const second = await kobai.seedInitialMerchant();

    expect(first).toMatchObject({ status: "seeded" });
    // Not a failure, and not a second Merchant: the ordinary restart is the commonest thing
    // that happens to a deployment, so it has to be the quietest.
    expect(second).toEqual({ status: "already-present" });
    await expect(merchantCount(kobai)).resolves.toBe(1);
  });

  it("leaves the Merchant it finds alone, whatever it was configured with since", async () => {
    kobai = await createTestKobai({ initialMerchant: CREDENTIALS });
    await kobai.seedInitialMerchant();

    // The *same database*, booted by a process configured with somebody else — a rotated
    // variable, a copied compose file. Seeding is for a deployment that has nobody, so this
    // must not quietly add an account or fail a boot that is otherwise fine.
    const rebooted = createKobai({
      databaseUrl: kobai.database.url,
      initialMerchant: {
        email: "someone@example.test",
        password: "another very long password",
      },
      logger: silentLogger,
    });
    try {
      await expect(rebooted.seedInitialMerchant()).resolves.toEqual({
        status: "already-present",
      });
      await expect(merchantCount(kobai)).resolves.toBe(1);
    } finally {
      await rebooted.close();
    }
  });

  it("creates one Merchant when two processes boot against one database at once", async () => {
    kobai = await createTestKobai({ initialMerchant: CREDENTIALS });

    // What the check before the transaction cannot answer: both look, both find nothing,
    // and one has to lose. The advisory lock and the re-check inside the transaction are
    // what decide it — never a second Merchant, and never a failed boot for the loser.
    const [first, second] = await Promise.all([
      kobai.seedInitialMerchant(),
      kobai.seedInitialMerchant(),
    ]);

    expect([first?.status, second?.status].sort()).toEqual(["already-present", "seeded"]);
    await expect(merchantCount(kobai)).resolves.toBe(1);
  });
});

describe("booting with nothing configured", () => {
  it("leaves the deployment with no Merchant and says so, rather than failing", async () => {
    const log = recordingLogger();
    kobai = await createTestKobai({ logger: log.logger });

    const seeded = await kobai.seedInitialMerchant();

    expect(seeded).toEqual({ status: "not-configured" });
    await expect(merchantCount(kobai)).resolves.toBe(0);
    // Distinguishable from every other outcome, and reported at the level that gets read:
    // an unconfigured deployment is one nobody can sign in to, which is not a detail.
    expect(log.errors()).toContainEqual(
      expect.objectContaining({ message: "no initial merchant" }),
    );
  });

  it("keeps serving, because a deployment nobody can administer is still a deployment", async () => {
    kobai = await createTestKobai();

    await kobai.seedInitialMerchant();

    // `/health` is the endpoint that tells a booting instance from a broken one, and this is
    // neither: migrations applied. A process that exited here would look, to whatever
    // supervises it, exactly like the failed migration that must exit.
    const health = await kobai.request("/health");
    expect(health.status).toBe(200);
    // …and the admin surface is closed rather than open, which is the property that makes
    // "no Merchant" survivable at all.
    const admin = await kobai.request("/admin/store");
    expect(admin.status).toBe(401);
  });
});

describe("booting with a configuration that cannot be used", () => {
  it.each([
    ["only the email", { email: CREDENTIALS.email }, "password"],
    ["only the password", { password: CREDENTIALS.password }, "email address"],
  ])("names which half is missing — %s", async (_case, initialMerchant, missing) => {
    kobai = await createTestKobai({ initialMerchant });

    const seeded = await kobai.seedInitialMerchant();

    // Half a pair is somebody who meant to configure this and stopped, so it is reported as
    // a mistake rather than as the deliberate absence above.
    expect(seeded).toMatchObject({ status: "not-usable" });
    expect((seeded as { detail: string }).detail).toContain(`The ${missing} was not`);
    await expect(merchantCount(kobai)).resolves.toBe(0);
  });

  it("refuses a password short enough to be guessed, as the API would", async () => {
    kobai = await createTestKobai({
      initialMerchant: { email: CREDENTIALS.email, password: "short" },
    });

    const seeded = await kobai.seedInitialMerchant();

    // The seed is held to the same rules as `POST /admin/merchants`: a credential that
    // arrived from an environment is not a credential with fewer rules.
    expect(seeded).toMatchObject({ status: "not-usable" });
    await expect(merchantCount(kobai)).resolves.toBe(0);
  });

  it("treats a variable set to nothing as one nobody set", async () => {
    kobai = await createTestKobai({ initialMerchant: { email: "  ", password: "" } });

    // `KOBAI_INITIAL_MERCHANT_EMAIL=` in a compose file is an absence, not an empty
    // credential — and reporting it as a bad value would send an operator looking for a
    // typo in a variable they had never filled in.
    await expect(kobai.seedInitialMerchant()).resolves.toEqual({
      status: "not-configured",
    });
  });
});

describe("the boot log", () => {
  it("never prints the password, in any outcome", async () => {
    // Including the outcomes that report a mistake: an operator who swapped the two
    // variables would otherwise have their password written to the log by the very line
    // reporting the swap. The email is not printed either until a Merchant holds it.
    const cases = [
      CREDENTIALS,
      { email: CREDENTIALS.email, password: "short" },
      { password: CREDENTIALS.password },
      {},
    ];

    for (const initialMerchant of cases) {
      const log = recordingLogger();
      await using instance = await createTestKobai({
        initialMerchant,
        logger: log.logger,
      });

      await instance.seedInitialMerchant();
      // Twice, so the `already-present` line is covered too.
      await instance.seedInitialMerchant();

      expect(log.text(), JSON.stringify(initialMerchant)).not.toContain(
        CREDENTIALS.password,
      );
      expect(log.text(), JSON.stringify(initialMerchant)).not.toContain("short");
    }
  });

  it("names the Merchant it created, so an operator can see which account exists", async () => {
    const log = recordingLogger();
    kobai = await createTestKobai({ initialMerchant: CREDENTIALS, logger: log.logger });

    await kobai.seedInitialMerchant();

    // Once a Merchant holds the address it is theirs, rather than a guess about what a
    // variable contained, and knowing which account was created is what an operator signs
    // in with.
    expect(log.text()).toContain(CREDENTIALS.email);
  });
});

describe("a Merchant created any other way", () => {
  it("claims the deployment too, so seeding then finds nothing to do", async () => {
    kobai = await createTestKobai({ initialMerchant: CREDENTIALS });
    // `signInTestMerchant` seeds one of its own, which is what a real deployment's first
    // boot did before this one restarted.
    await signInTestMerchant(kobai);

    await expect(kobai.seedInitialMerchant()).resolves.toEqual({
      status: "already-present",
    });
    await expect(merchantCount(kobai)).resolves.toBe(1);
  });
});

async function merchantCount(harness: TestKobai): Promise<number> {
  const [row] = await harness.database.query<{ count: string }>(
    "select count(*)::text as count from core_merchant",
  );
  return Number(row?.count);
}

type LoggedLine = { readonly message: string; readonly fields?: object };

/** A logger that keeps what it was told, for a test whose subject is what a boot prints. */
function recordingLogger() {
  const infos: LoggedLine[] = [];
  const errors: LoggedLine[] = [];
  const logger: Logger = {
    info: (message, fields) => infos.push({ message, fields }),
    error: (message, fields) => errors.push({ message, fields }),
  };
  return {
    logger,
    errors: () => errors,
    /** Everything printed, as one string — for asking what is *not* in it. */
    text: () => JSON.stringify([...infos, ...errors]),
  };
}
