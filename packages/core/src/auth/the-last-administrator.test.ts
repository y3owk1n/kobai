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
    const administrators: Administrator[] = [
      { role: await roleNamed(kobai, owner, "owner"), session: owner },
    ];
    for (let index = 1; index < ADMINISTRATORS; index++) {
      administrators.push(await administrator(kobai, owner, index));
    }

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

/** A Merchant who can administer Merchants, and the Role they hold it through. */
type Administrator = {
  readonly role: string;
  readonly session: Pick<TestSession, "headers">;
};

/** A Merchant on a Role of their own carrying `merchant:write` — a rival for the last one. */
async function administrator(
  kobai: TestKobai,
  owner: TestSession,
  index: number,
): Promise<Administrator> {
  const name = `administrator-${index}`;
  const created = await kobai.request("/admin/roles", {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ name, permissions: [PERMISSIONS.merchantWrite] }),
  });
  const role = (await expectStatus(created, 201, `creating ${name}`)) as { id: string };

  const credentials = {
    email: `${name}@example.test`,
    password: `an administrator's very long password ${index}`,
  };
  const merchant = await kobai.request("/admin/merchants", {
    method: "POST",
    headers: { ...owner.headers, "content-type": "application/json" },
    body: JSON.stringify({ ...credentials, role: name }),
  });
  await expectStatus(merchant, 201, `adding a Merchant to ${name}`);

  const session = await kobai.request("/admin/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
  await expectStatus(session, 201, `signing ${name} in`);

  return { role: role.id, session: sessionOf(session) };
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
