import type { ApiKeyKind } from "../auth/api-key.ts";
import type { Kobai } from "../kobai.ts";
import { expectStatus } from "./expect-status.ts";
import type { TestSession } from "./merchant.ts";

/**
 * An API key, for every test whose subject is something on the **store surface**.
 *
 * That surface is closed by default, so a test about a resolved price has to get through the
 * door first — and getting through it means a Merchant minting a key, which is three
 * requests of arrangement in front of the assertion that matters.
 *
 * ```ts
 * await using kobai = await createTestKobai();
 * const merchant = await signInTestMerchant(kobai);
 * const key = await createTestApiKey(kobai, merchant);
 *
 * const response = await kobai.request("/store/variants/…/price", { headers: key.headers });
 * ```
 *
 * It goes through the public API, like `signInTestMerchant`, so a test can never prove
 * something the API cannot actually do. The kind defaults to `secret`, which is what a test
 * that does not care should take; a test whose subject *is* the difference between the kinds
 * should name the one it means, because leaning on the default would hide the point.
 *
 * **A key is in a Channel or in none, and that is the whole of how a request is in one**
 * (#292, ADR-0020). A test about a Price constrained to a Channel therefore mints its key into
 * that Channel — `channelId` is the `id` `POST /admin/channels` answered with — and one about
 * anything else leaves it out, which is the unconstrained key every deployment mints today:
 *
 * ```ts
 * const marketplace = await createTestApiKey(kobai, merchant, { channelId });
 * ```
 */
export type TestApiKey = {
  readonly id: string;
  /** The value. Real tests should keep it exactly as long as this one does: one request. */
  readonly key: string;
  /** Ready to spread into a `RequestInit` — `{ headers: key.headers }`. */
  readonly headers: Record<string, string>;
  readonly kind: ApiKeyKind;
  /** The Channel every request presenting it is in, or `null` for a key in no particular one. */
  readonly channelId: string | null;
};

export async function createTestApiKey(
  kobai: Kobai,
  /** A signed-in Merchant holding `api-key:write` — what `signInTestMerchant` hands back. */
  merchant: Pick<TestSession, "headers">,
  options?: {
    readonly name?: string;
    readonly kind?: ApiKeyKind;
    readonly channelId?: string;
  },
): Promise<TestApiKey> {
  const kind = options?.kind ?? "secret";

  const response = await kobai.request("/admin/api-keys", {
    method: "POST",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({
      name: options?.name ?? "a test storefront",
      kind,
      // Left out rather than sent as `null`, so a key this helper mints with no Channel is
      // byte for byte the request a storefront that has never heard of Channels makes.
      ...(options?.channelId === undefined ? {} : { channelId: options.channelId }),
    }),
  });

  const created = (await expectStatus(response, 201, "creating an API key")) as {
    id: string;
    key: string;
    kind: ApiKeyKind;
    channelId: string | null;
  };
  return {
    id: created.id,
    key: created.key,
    kind: created.kind,
    channelId: created.channelId,
    headers: { authorization: `Bearer ${created.key}` },
  };
}
