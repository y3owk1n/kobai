import type { MerchantIdentity, RoleSummary } from "../auth/identity.ts";
import { seedInitialMerchant } from "../auth/seed.ts";
import { SESSION_COOKIE } from "../auth/session-cookie.ts";
import type { Kobai } from "../kobai.ts";
import { expectStatus } from "./expect-status.ts";

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
  /**
   * The session token itself, read out of the cookie.
   *
   * Nothing but a test wants this: the token is in no response body, and a browser never sees
   * it either — it stores the cookie and sends it back without reading it. It is here for the
   * one test whose subject *is* the token, which is that `core_session` holds only a hash of
   * it.
   */
  readonly token: string;
  /**
   * Ready to spread into a `RequestInit` — `{ headers: merchant.headers }`.
   *
   * Spelled as the one header it is rather than as a bag of them, so a caller that wants the
   * cookie value itself — the generated client's tests, which play the browser by hand — reads
   * `merchant.headers.cookie` and gets a `string`.
   */
  readonly headers: { readonly cookie: string };
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
 * Seeds the deployment's first Merchant, the way a boot does.
 *
 * There is no HTTP way to do this and there is deliberately not going to be one: Core has no
 * unauthenticated write path, so the first Merchant is the one thing a deployment is *given*
 * rather than asked for (#25). This is the same call `Kobai.seedInitialMerchant()` makes, so
 * a test arranging a Merchant is doing what a real deployment's first boot did.
 */
export async function seedTestMerchant(
  kobai: Kobai,
  credentials: TestCredentials = TEST_MERCHANT,
): Promise<void> {
  const seeded = await seedInitialMerchant(kobai.db, credentials);
  if (seeded.status !== "seeded") {
    throw new Error(
      `seeding the first Merchant answered ${JSON.stringify(seeded)} — this deployment already had one, or the credentials were not usable.`,
    );
  }
}

/**
 * Seeds the deployment's first Merchant and signs them in.
 *
 * The Merchant holds the seeded `owner` Role, so they hold every permission Core defines. A
 * test about *not* holding one should create a narrower Role and a second Merchant itself —
 * that is the thing under test, and hiding it in a helper would hide the point. Both go
 * through the public API with this one's session, `POST /admin/roles` and then
 * `POST /admin/merchants`, which is the only way there is.
 */
export async function signInTestMerchant(
  kobai: Kobai,
  credentials: TestCredentials = TEST_MERCHANT,
): Promise<TestSession> {
  await seedTestMerchant(kobai, credentials);

  const response = await kobai.request("/admin/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credentials),
  });
  const session = (await expectStatus(response, 201, "signing in")) as Omit<
    TestSession,
    "headers" | "token"
  >;

  return { ...session, ...sessionOf(response) };
}

/**
 * The `Cookie` header a browser would send back, taken off a sign-in response.
 *
 * A test that signs a *second* Merchant in — the narrower Role a permission test is about —
 * needs this, because `signInTestMerchant` above also claims the deployment and can only be
 * the first. Doing by hand what a browser does is the honest way to drive a cookie session,
 * and it is two lines rather than a cookie jar.
 *
 * ```ts
 * const signedIn = await kobai.request("/admin/session", …);
 * const response = await kobai.request("/admin/store", { headers: sessionOf(signedIn).headers });
 * ```
 */
export function sessionOf(response: Response): Pick<TestSession, "headers" | "token"> {
  const setCookie = response.headers.get("set-cookie") ?? "";
  // The name comes from the module that sets the cookie, so renaming it moves both halves
  // together rather than leaving a test to discover the mismatch at runtime.
  const token = new RegExp(`(?:^|[;\\s])${SESSION_COOKIE}=([^;]*)`).exec(setCookie)?.[1];
  if (token === undefined || token === "") {
    throw new Error(
      `that response set no ${SESSION_COOKIE} cookie: ${setCookie === "" ? "(no set-cookie header)" : setCookie}`,
    );
  }
  return { token, headers: { cookie: `${SESSION_COOKIE}=${token}` } };
}
