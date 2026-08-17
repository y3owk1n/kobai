import type { MerchantIdentity, RoleSummary } from "../auth/identity.ts";
import type { Kobai } from "../kobai.ts";

/**
 * A signed-in Merchant, for every test whose subject is something *behind* the gate.
 *
 * The admin surface is closed by default, so a test of the catalog, of the Store, or of
 * anything else a Merchant reaches has to get through the door first. Doing that by hand is
 * three requests of boilerplate in front of the assertion that matters, so it lives here —
 * and it goes through the same public HTTP surface a Merchant does, rather than reaching into
 * the database, so a test never proves something the API cannot actually do.
 *
 * ```ts
 * await using kobai = await createTestKobai();
 * const merchant = await signInTestMerchant(kobai);
 *
 * const response = await kobai.request("/admin/store", { headers: merchant.headers });
 * ```
 */
export type TestSession = {
  /** The bearer token itself. */
  readonly token: string;
  /** Ready to spread into a `RequestInit` — `{ headers: merchant.headers }`. */
  readonly headers: Record<string, string>;
  readonly merchant: MerchantIdentity;
  readonly role: RoleSummary;
  readonly expiresAt: string;
};

export type TestCredentials = {
  readonly email: string;
  readonly password: string;
};

/** The Merchant a test gets when it does not care which Merchant it is. */
export const TEST_MERCHANT: TestCredentials = {
  email: "merchant@example.test",
  password: "a merchant's very long password",
};

/**
 * Creates the deployment's first Merchant and signs them in.
 *
 * The Merchant holds the seeded `owner` Role, so they hold every permission Core defines. A
 * test about *not* holding one should create a narrower Role and a second Merchant itself —
 * that is the thing under test, and hiding it in a helper would hide the point.
 */
export async function signInTestMerchant(
  kobai: Kobai,
  credentials: TestCredentials = TEST_MERCHANT,
): Promise<TestSession> {
  await expectStatus(
    kobai.request("/admin/merchants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    }),
    201,
    "creating the first Merchant",
  );

  const session = (await expectStatus(
    kobai.request("/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    }),
    201,
    "signing in",
  )) as Omit<TestSession, "headers">;

  return { ...session, headers: { authorization: `Bearer ${session.token}` } };
}

async function expectStatus(
  pending: Promise<Response>,
  status: number,
  what: string,
): Promise<unknown> {
  const response = await pending;
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status !== status) {
    throw new Error(
      `${what} answered ${response.status}, expected ${status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}
