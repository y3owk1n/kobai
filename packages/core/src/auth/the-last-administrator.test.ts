import { describe, expect, it } from "vitest";
import { expectStatus } from "../testing/expect-status.ts";
import {
  createTestKobai,
  sessionOf,
  signInTestMerchant,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";
import { PERMISSIONS } from "./permissions.ts";

/**
 * That two Merchants cannot each remove the last administrator at the same time.
 *
 * `role.test.ts` already asserts the refusal one request at a time, and **that proves nothing
 * about the property this file is about**: the check reads rows the request never named — is
 * there any *other* Merchant, on any *other* Role, still holding `merchant:write` — and a
 * subquery locks none of them. So two transactions each stripping a different last
 * administrator both find the other's Role, both pass the check, and both commit. That is write
 * skew, it is invisible to every sequential assertion, and the state it leaves is the exact
 * lockout the refusal exists to prevent: a deployment with no way back in short of raw SQL.
 *
 * ADR-0018's usual answer does not reach it either. Inventory claims stock in one conditional
 * `update` because the condition is about the row being written, so Postgres takes the row lock
 * before evaluating it; here the condition is about other rows, so the guard is a lock taken
 * *before* the read — `auth/role.ts` explains which and why.
 *
 * **This was watched failing before it was made to pass**, which is the discipline
 * `reservation/the-variant-that-vanished.test.ts` records and the only proof there is. With the
 * `pg_advisory_xact_lock` line taken out of `updateRole`, this file failed the way the bug
 * looks rather than the way a bug usually looks —
 * `expected [ 200, 200, 200, 200, 200, 200 ] to have a length of 5`. Every one of the six
 * requests succeeded, so every Role carrying `merchant:write` was stripped and the deployment
 * was left with nobody able to administer Merchants: every session still valid, every one of
 * them powerless, and nothing anywhere reporting an error. With the lock in, five answer 200
 * and the sixth is refused. It was watched twice — once when the lock was unconditional, and
 * again after it was narrowed to the bodies that name `permissions`, because moving where a
 * lock is taken is exactly the change a green run cannot vouch for.
 *
 * **A green run proves less than it looks**, for the reason the other two race tests say in as
 * many words: once the lock is in, a request that landed inside the window and one that arrived
 * after the other transaction committed answer identically. So changing how these requests are
 * dispatched obliges you to watch it fail again rather than to trust that it still would.
 *
 * **Two routes can reach this state, which is what the second case is about** (#202).
 * `PATCH /admin/roles/{id}` takes the Permission off a Role and `PATCH /admin/merchants/{id}`
 * moves the last Merchant who holds it somewhere that does not, and the deployment cannot tell
 * the two ruins apart. ADR-0066 said whoever added the second route would inherit this invariant
 * "in the harder form", and the hard part is not either check — it is that **both must take the
 * same lock**. Two correct guards on two keys serialise nothing against each other: a strip and
 * a move each find the other's administrator, both pass, and both commit. No test dispatching
 * one kind of request can see that, however many it dispatches, which is why the second case
 * mixes them and why `auth/administrators.ts` is a module rather than a helper in each.
 *
 * **It too was watched failing, against exactly that build**: a second advisory key for the
 * second route, everything else untouched. Every one of the six rounds came back
 * `{ refused: [], succeeded: 2, administratorsLeft: 0 }` — both requests answered 200, and
 * nobody on the deployment could administer Merchants afterwards. With one key, six rounds of
 * one refusal and one administrator left. **Getting it to fail took an arrangement change and
 * that is the durable finding**, written out at {@link warmTheConnectionPool}: without it the
 * two requests never overlapped at all and the broken build passed. Re-watch this one if you
 * change how the pair is dispatched — the requests silently ceasing to overlap is the way this
 * case goes quietly useless.
 */

/**
 * How many Roles carry `merchant:write` when the requests go out, one Merchant on each.
 *
 * Six rather than two: with two, a scheduling that happened to serialise them is as likely as
 * one that did not, and the test would pass a broken build about half the time. Six is well
 * inside the connection pool, which matters — requests queueing behind connections serialise
 * the very thing this test exists to overlap.
 */
const ADMINISTRATORS = 6;

describe("stripping every administering Role at once", () => {
  it("leaves exactly one Merchant able to administer Merchants", async () => {
    await using kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    // **Each administrator strips their own Role, signed in as themselves**, and that is the
    // arrangement rather than a flourish: six requests on one session would contend on that
    // session's row and, worse, a caller whose own Role had already been stripped would be
    // turned back by the gate at 403 — a refusal that looks like this one and means something
    // else entirely. Nobody's Role is stripped by anybody but them, so every gate here answers
    // the same whenever it runs.
    const administrators = await everyAdministrator(kobai, owner);

    const responses = await Promise.all(
      administrators.map((each) =>
        kobai.request(`/admin/roles/${each.role}`, {
          method: "PATCH",
          headers: { ...each.session.headers, "content-type": "application/json" },
          body: JSON.stringify({ permissions: [PERMISSIONS.storeRead] }),
        }),
      ),
    );
    const statuses = responses.map((response) => response.status);
    const refusals = await Promise.all(
      responses
        .filter((response) => response.status !== 200)
        .map((response) => response.json()),
    );

    // Exactly one is refused, and refused for the reason that is true rather than by failing
    // some other way — a 403 from the gate, a deadlock or a 500 would leave the same one Role
    // standing and would mean something entirely different about how it got there.
    expect(statuses.filter((status) => status === 200)).toHaveLength(ADMINISTRATORS - 1);
    expect(refusals).toEqual([expect.objectContaining({ reason: "last-administrator" })]);

    // And then the thing the statuses cannot say: somebody can still administer Merchants,
    // asked the way a deployment locked out of itself would find out — by every one of them
    // trying, and exactly one getting in.
    //
    // **The probe is a write, because administering is the write.** `merchant:read` opens the
    // reads on this surface and puts nobody's Permission back (ADR-0066), so a Merchant who can
    // list Roles and nothing else is exactly the locked-out state this file is about — and a
    // read would report them as the administrator who is still standing.
    const admits = await Promise.all(
      administrators.map(
        async (each, index) =>
          (
            await kobai.request("/admin/roles", {
              method: "POST",
              headers: { ...each.session.headers, "content-type": "application/json" },
              body: JSON.stringify({ name: `made-by-${index}`, permissions: [] }),
            })
          ).status,
      ),
    );
    expect(admits.filter((status) => status === 201)).toHaveLength(1);
  });
});

/**
 * The Role a moved administrator lands on: it can sign in and read the Store, and it
 * administers nobody.
 *
 * A Role rather than one of the administering ones, because a move onto a Role that *does*
 * carry `merchant:write` takes nothing away and is never asked about — which would make every
 * request below a 200 and the case itself vacuous.
 */
const BYSTANDER = "bystander";

/**
 * How many times the two are raced.
 *
 * **This one is two requests and cannot be six, which is why it is repeated instead.** The
 * first case gets its reliability from putting six requests on one lock; here the whole subject
 * is a *strip* meeting a *move*, and there are only ever two of those at the moment it matters —
 * a third of either kind serialises behind its own sibling and never reaches the window. A
 * scheduling that happens to separate two requests is about as likely as one that does not, so
 * a single round would pass a broken build about half the time, and rounds are what buys back
 * what six requests buy the case above. Six rounds of a coin that lands wrong half the time is
 * a build that goes green about once in sixty.
 *
 * A round is a database of its own, because the state under test is *the deployment's* — once a
 * round has run there is exactly one administrator left, and putting a second one back would be
 * arranging the next round out of the last one's outcome.
 */
const ROUNDS = 6;

describe("stripping a Role and moving a Merchant off one, at once", () => {
  it("leaves exactly one Merchant able to administer Merchants, in every round", async () => {
    const rounds: unknown[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      rounds.push(await aStripAgainstAMove());
    }

    // Every round reported as a whole, so a failure names which one and what it left behind
    // rather than reading `expected 2 to be 1` six times over.
    expect(rounds).toEqual(
      Array.from({ length: ROUNDS }, () => ({
        refused: ["last-administrator"],
        succeeded: 1,
        administratorsLeft: 1,
      })),
    );
  });
});

/**
 * One round: two administrators, and the two different ways of unmaking one dispatched together.
 *
 * **Each acts on themselves**, for the first case's reason — a Merchant narrowed by somebody
 * else could be turned back by the gate at 403, which looks like this refusal and means
 * something else entirely.
 *
 * Under one lock the loser re-reads a database the winner has already changed, finds itself the
 * only administrator left, and is refused. Under two — one key per route, which is what a second
 * copy of the guard in the second module would be — the strip reads the mover's Merchant and the
 * move reads the stripper's Role, neither has been committed yet, both pass, and the deployment
 * ends with nobody who can administer Merchants and nothing anywhere reporting an error.
 */
async function aStripAgainstAMove(): Promise<{
  readonly refused: readonly string[];
  readonly succeeded: number;
  readonly administratorsLeft: number;
}> {
  await using kobai = await createTestKobai();
  const owner = await signInTestMerchant(kobai);
  await roleCarrying(kobai, owner, BYSTANDER, [PERMISSIONS.storeRead]);
  const stripper = {
    role: await roleNamed(kobai, owner, "owner"),
    merchant: await whoAmI(kobai, owner),
    session: owner,
  };
  const mover = await administrator(kobai, owner, 1);
  await warmTheConnectionPool(kobai, owner);

  const responses = await Promise.all([
    kobai.request(`/admin/roles/${stripper.role}`, {
      method: "PATCH",
      headers: { ...stripper.session.headers, "content-type": "application/json" },
      body: JSON.stringify({ permissions: [PERMISSIONS.storeRead] }),
    }),
    kobai.request(`/admin/merchants/${mover.merchant}`, {
      method: "PATCH",
      headers: { ...mover.session.headers, "content-type": "application/json" },
      body: JSON.stringify({ role: BYSTANDER }),
    }),
  ]);

  const refused = await Promise.all(
    responses
      .filter((response) => response.status !== 200)
      .map(async (response) => ((await response.json()) as { reason: string }).reason),
  );

  // And then the thing the statuses cannot say, asked as a **write** for the first case's
  // reason: `merchant:read` opens the reads on this surface and puts nobody's Permission back,
  // so a Merchant who can list Roles and nothing else is exactly the locked-out state.
  const admits = await Promise.all(
    [stripper, mover].map(
      async (each, index) =>
        (
          await kobai.request("/admin/roles", {
            method: "POST",
            headers: { ...each.session.headers, "content-type": "application/json" },
            body: JSON.stringify({ name: `made-by-${index}`, permissions: [] }),
          })
        ).status,
    ),
  );

  return {
    refused,
    succeeded: responses.filter((response) => response.status === 200).length,
    administratorsLeft: admits.filter((status) => status === 201).length,
  };
}

/**
 * Opens as many Postgres connections as the race needs, **before** the race.
 *
 * This is not tidying and the case does not work without it. `pg.Pool` opens a connection when
 * one is asked for and none is idle, and opening one costs a TCP connect and an authentication
 * handshake — around 7ms here, against the 1ms the guarded transaction takes end to end. Every
 * arrangement above leaves exactly *one* idle connection behind, so of two requests dispatched
 * together the first takes it and starts immediately while the second waits for a connection
 * that is still being made: the first has locked, read, written and committed before the second
 * reaches its own read. They do not overlap, so the window under test is never entered, and the
 * case goes green against a build with no serialisation between the two routes at all.
 *
 * **That is ADR-0049's trap wearing a race's clothes** — an arrangement that quietly stopped
 * overlapping looks exactly like a fix. It was found by logging the moment each request asked
 * for the lock: 7ms apart with one warm connection, and inside the same millisecond with two.
 * Concurrent rather than sequential, because a sequential pair hands the same connection back
 * and reuses it, which leaves the pool exactly as it found it.
 */
async function warmTheConnectionPool(
  kobai: TestKobai,
  session: TestSession,
): Promise<void> {
  await Promise.all([
    kobai.request("/admin/session", { headers: session.headers }),
    kobai.request("/admin/session", { headers: session.headers }),
  ]);
}

/**
 * {@link ADMINISTRATORS} Merchants who can each administer Merchants, one Role apiece.
 *
 * The seeded owner is the first of them and is arranged differently from the rest — they exist
 * already and their Role is `owner` — which is why the identifier comes from
 * `GET /admin/session` rather than from a creation response.
 */
async function everyAdministrator(
  kobai: TestKobai,
  owner: TestSession,
): Promise<readonly Administrator[]> {
  const administrators: Administrator[] = [
    {
      role: await roleNamed(kobai, owner, "owner"),
      merchant: await whoAmI(kobai, owner),
      session: owner,
    },
  ];
  for (let index = 1; index < ADMINISTRATORS; index++) {
    administrators.push(await administrator(kobai, owner, index));
  }
  return administrators;
}

/** A Merchant who can administer Merchants, and the Role they hold it through. */
type Administrator = {
  readonly role: string;
  /** Their own identifier — what the second case addresses them by to move them. */
  readonly merchant: string;
  readonly session: Pick<TestSession, "headers">;
};

/** A Merchant on a Role of their own carrying `merchant:write` — a rival for the last one. */
async function administrator(
  kobai: TestKobai,
  owner: TestSession,
  index: number,
): Promise<Administrator> {
  const name = `administrator-${index}`;
  const role = await roleCarrying(kobai, owner, name, [PERMISSIONS.merchantWrite]);

  const credentials = {
    email: `${name}@example.test`,
    password: `an administrator's very long password ${index}`,
  };
  const merchant = await kobai.request("/admin/merchants", {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ ...credentials, role: name }),
  });
  const added = (await expectStatus(merchant, 201, `adding a Merchant to ${name}`)) as {
    id: string;
  };

  const session = await kobai.request("/admin/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
  await expectStatus(session, 201, `signing ${name} in`);

  return { role, merchant: added.id, session: sessionOf(session) };
}

/** A Role holding exactly what it is given, made the way a Merchant makes one (#173). */
async function roleCarrying(
  kobai: TestKobai,
  owner: TestSession,
  name: string,
  permissions: readonly string[],
): Promise<string> {
  const response = await kobai.request("/admin/roles", {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ name, permissions }),
  });
  const created = (await expectStatus(response, 201, `creating ${name}`)) as {
    id: string;
  };
  return created.id;
}

/** Who the caller is, which is the only way to learn the seeded Merchant's identifier. */
async function whoAmI(kobai: TestKobai, session: TestSession): Promise<string> {
  const response = await kobai.request("/admin/session", { headers: session.headers });
  const { merchant } = (await expectStatus(response, 200, "reading the session")) as {
    merchant: { id: string };
  };
  return merchant.id;
}

async function roleNamed(
  kobai: TestKobai,
  owner: TestSession,
  name: string,
): Promise<string> {
  const response = await kobai.request("/admin/roles", { headers: owner.headers });
  const { roles } = (await expectStatus(response, 200, "listing Roles")) as {
    roles: { id: string; name: string }[];
  };
  const found = roles.find((role) => role.name === name);
  if (!found) throw new Error(`no Role named ${name} exists`);
  return found.id;
}
