import type { ProductStatus } from "../catalog/status.ts";
import type { Kobai } from "../kobai.ts";
import { createTestApiKey, type TestApiKey } from "./api-key.ts";
import { expectStatus } from "./expect-status.ts";
import { signInTestMerchant, type TestSession } from "./merchant.ts";

/**
 * What a test asks for: one Variant's Prices, in minor units.
 *
 * `[]` is a Variant with no Price at all — the arrangement a refusal test needs, and one a
 * caller must never have to hand-roll the rest of the Product for.
 */
export type TestVariantSpec = {
  /** Defaults to `POSTER-A2`, `POSTER-A3`, `POSTER-A4` — by position, so two need no names. */
  readonly sku?: string;
  /**
   * The Fulfilment Strategy this Variant points at, **by name**. Defaults to `physical`.
   *
   * Named by a test whose subject is what a Strategy answers — that a `digital` Variant needs
   * no Inventory row, that a Plugin's Strategy is only reachable once the Project wired it. A
   * name this deployment has not wired is refused by the route, and this helper fails saying
   * so, which is the same answer a Merchant would get.
   *
   * Spelled out rather than `fulfilment`, because the request body's `fulfilment` is the object
   * `{ strategy }` and this is the name inside it.
   */
  readonly fulfilmentStrategy?: string;
  /**
   * Minor units, in the Store's default currency. `1250` is USD 12.50.
   *
   * Several, because a Price is a row rather than a column (ADR-0008) — the arrangement a
   * test about price *selection* is actually about. Defaults to one Price of `1250`.
   */
  readonly prices?: readonly number[];
  /**
   * What this Variant **is**, for each option its Product is chosen by — `{ Size: "A2" }`.
   *
   * **The Product declares whichever options its Variants answer, and there is no second place
   * to say it.** A Product's options and a Variant's values for them are one fact read from two
   * ends, and `POST /admin/products` refuses a Variant that answers an option its Product never
   * declared. So this helper never takes the declaration: it reads it off the Variants, which
   * makes the mismatch unarrangeable rather than merely discouraged.
   *
   * **The order a storefront offers them in is the order the first Variant writes them in.** A
   * Product's option list is ordered and the order is the Merchant's, so `{ Size, Finish }`
   * declares Size first — object keys, in the order they are written.
   *
   * A record rather than the route's own `[{ name, value }]`, because a key is one key: a
   * Variant that answers `Size` twice — which the route also refuses — cannot be written down.
   *
   * Two things the helper refuses before it sends anything, each because the API would refuse
   * them and a 422 out of an arrangement names the helper rather than the test:
   *
   * - **Variants answering different sets of options.** One that leaves a declared option
   *   unanswered is a Variant a picker cannot place, so every Variant of one call answers the
   *   same option names — `{}` and nothing at all being the same answer, which is a Product
   *   with no options and the ordinary case (ADR-0008).
   * - **Two Variants answering one combination**, refused since #277: a storefront maps a
   *   chosen combination to a SKU, and it can only do that where the mapping is a function.
   *   Inside a create that is a body disagreeing with itself, so it is `invalid` at 400 rather
   *   than the `variant-combination-taken` a Variant added to a Product that already exists
   *   gets. A Product declaring no options has no combinations, so any number of its Variants
   *   is fine — that is the same reading the route takes.
   */
  readonly options?: Readonly<Record<string, string>>;
};

/** A Collection the catalog was seeded into, by the identifier everything addresses one by. */
export type TestCatalogCollection = {
  readonly id: string;
  readonly title: string;
};

/**
 * The Product to seed.
 *
 * `prices` is the one-Variant shorthand and `variants` is the general form; naming both is a
 * type error rather than a precedence rule nobody would remember.
 */
export type TestCatalogOptions = {
  /**
   * What the Product is called. Defaults to `A poster`.
   *
   * **A second catalog in one deployment needs its own, exactly as it needs its own SKUs.** A
   * handle is proposed from the title and is unique across the Store, so two default catalogs
   * are refused `handle-taken` — one door along from the `sku-taken` two of them were already
   * refused with. Nothing is passed for the handle itself, deliberately: every test in this
   * repository that seeds a catalog is then exercising what the route does when a create names
   * no handle at all, which is the case a Merchant meets first.
   */
  readonly title?: string;
  /**
   * The copy a Merchant wrote — its own column since #250. Left out entirely unless a test
   * names one, so what a create does with no description is what every other test exercises.
   */
  readonly description?: string;
  /**
   * What the Product is grouped under, **created into them** by the create itself (#280).
   *
   * A title makes a Collection of that name; a `TestCatalogCollection` a previous seed handed
   * back puts this Product into *that* one, which is what a second catalog in the same grouping
   * needs — Collection titles are deliberately not unique (there is no `collection-title-taken`),
   * so naming the same title twice would make a second Collection rather than reuse the first.
   *
   * ```ts
   * const posters = await seedTestCatalog(kobai, { collections: ["Wall art"] });
   * await seedTestCatalog(kobai, {
   *   merchant: posters.merchant,
   *   title: "A mug",
   *   collections: [posters.collection("Wall art")],
   * });
   * ```
   *
   * Two entries of one title are refused here rather than sent: the route would take them, and
   * {@link TestCatalog.collection} is asked by title.
   */
  readonly collections?: readonly (string | TestCatalogCollection)[];
  /**
   * What the Product ends up in — `draft`, `published` or `archived`. Defaults to `published`.
   *
   * **Published by default, because a helper hides the arrangement and never the subject.** What
   * this seeds is a Store with something to *sell*, and `POST /admin/products` deliberately
   * creates a draft, which no storefront can see — so a helper that stopped there would arrange
   * a catalog every store-surface test then had to publish for itself. Publishing is one more
   * `PATCH /admin/products/{id}` through the public API, exactly as a Merchant would.
   *
   * A test whose subject *is* the status says so, and gets the Product left where it asked:
   *
   * ```ts
   * await seedTestCatalog(kobai, { status: "draft" });     // left where the create leaves it
   * await seedTestCatalog(kobai, { status: "archived" });  // off the storefront
   * ```
   */
  readonly status?: ProductStatus;
  /**
   * A Merchant who is already signed in.
   *
   * The first Merchant is seeded once per deployment and there is no HTTP way to make
   * another (ADR-0041), so a test that already holds a session hands it over here rather
   * than watching `signInTestMerchant` refuse a second claim.
   */
  readonly merchant?: TestSession;
} & (
  | { readonly prices?: readonly number[]; readonly variants?: never }
  | { readonly variants?: readonly TestVariantSpec[]; readonly prices?: never }
);

export type TestCatalogPrice = {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
};

export type TestCatalogVariant = {
  readonly id: string;
  readonly sku: string;
  /** In the order they were set, which is the order they were asked for. */
  readonly prices: readonly TestCatalogPrice[];
};

export type TestCatalog = {
  /** Signed in and holding `owner`, for anything the test does on the admin surface. */
  readonly merchant: TestSession;
  /** A secret key, for anything it does on the store surface. */
  readonly apiKey: TestApiKey;
  readonly productId: string;
  /** The first Variant's id — a test with one Variant should not have to say which. */
  readonly variantId: string;
  readonly variants: readonly TestCatalogVariant[];
  /** In the order they were asked for — `[]` where the test named none. */
  readonly collections: readonly TestCatalogCollection[];
  /** The Variant with this SKU, or a failure naming the ones there are. */
  variant(sku: string): TestCatalogVariant;
  /**
   * The Collection with this title, or a failure naming the ones there are.
   *
   * By title rather than by position, for the reason {@link TestCatalog.variant} is by SKU: what
   * a test knows about a Collection it asked for is what it called it.
   */
  collection(title: string): TestCatalogCollection;
};

const DEFAULT_TITLE = "A poster";

/** USD 12.50, and the amount every test that does not care about the amount gets. */
const DEFAULT_AMOUNT = 1250;

/**
 * A Store with something to sell — a Product, a Variant, a Price — and the credentials to
 * ask about it with.
 *
 * Nearly every test past the first one needs this arrangement before it can resolve,
 * describe or serve anything, so the common case is one line:
 *
 * ```ts
 * await using kobai = await createTestKobai();
 * const catalog = await seedTestCatalog(kobai);
 *
 * const price = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
 *   headers: catalog.apiKey.headers,
 * });
 * ```
 *
 * That is one **published** Product titled `A poster`, reachable at the handle `a-poster`, one
 * Variant `POSTER-A2`, one Price of `1250` in the Store's default currency, a signed-in Merchant
 * and a secret API key. Published because a Product is created a draft and a draft is invisible
 * to the store surface — so a helper that left it there would be arranging a catalog nothing
 * could buy from. A test about drafting asks for `{ status: "draft" }`.
 *
 * **Amounts are integer minor units** and a Price's currency is the Store's
 * default, which since #5 is the only currency a Price may carry — so the helper never takes
 * one, and the correct thing is the only thing.
 *
 * **Two catalogs in one deployment each need their own `title` as well as their own SKUs.** A
 * handle is unique across the Store and is proposed from the title, so the second default one
 * is refused `handle-taken`.
 *
 * The interesting cases stay expressible, because a helper must hide the arrangement a test
 * does not care about and never the thing the test is about:
 *
 * ```ts
 * await seedTestCatalog(kobai, { prices: [1250, 900] });  // two Prices on one Variant
 * await seedTestCatalog(kobai, { prices: [] });           // a Variant with no Price
 * await seedTestCatalog(kobai, {                          // several Variants
 *   variants: [{ prices: [1250] }, { sku: "MUG", prices: [] }],
 * });
 * await seedTestCatalog(kobai, { merchant });             // one already signed in
 * await seedTestCatalog(kobai, { status: "draft" });      // never published
 * await seedTestCatalog(kobai, {                          // grouped, described, and chosen by
 *   description: "Printed to order.",                     //   two options
 *   collections: ["Wall art"],
 *   variants: [
 *     { sku: "POSTER-A2-MATTE", options: { Size: "A2", Finish: "Matte" } },
 *     { sku: "POSTER-A3-MATTE", options: { Size: "A3", Finish: "Matte" } },
 *   ],
 * });
 * ```
 *
 * **A Product's options are read off its Variants and are never given separately**, which is
 * what makes a Variant answering an option its Product does not declare unwritable rather than
 * merely refused — see {@link TestVariantSpec.options}, which also lists the two arrangements
 * this helper declines to send.
 *
 * **No `handle`, on purpose**, and no `media`. The handle is the sharper of the two: a create
 * that names none proposes one from the title, so every catalog seeded here exercises that
 * path, which is the one a Merchant meets first. A test whose subject is an address of its own
 * asks for it with a `PATCH`, in the open.
 *
 * Everything goes through the public API rather than through the database, like
 * `signInTestMerchant` and `createTestApiKey` — so a test can never prove a capability the
 * API does not actually have, and a Plugin's test is doing exactly what a Plugin can do.
 */
export async function seedTestCatalog(
  kobai: Kobai,
  options?: TestCatalogOptions,
): Promise<TestCatalog> {
  const specs = options?.variants ?? [{ prices: options?.prices }];
  if (specs.length === 0) {
    throw new Error(
      "a Product is never sellable in itself (ADR-0008), so seedTestCatalog needs at least one Variant. For a Variant with no Price, ask for `{ prices: [] }`.",
    );
  }

  const asked = specs.map((spec, index) => ({ ...spec, sku: spec.sku ?? skuFor(index) }));

  // Everything the helper can judge for itself is judged here, before a Merchant is signed in
  // and before a byte is sent — so an arrangement the API would refuse names the arrangement,
  // rather than arriving as a 4xx against a request this helper made and the test never saw.
  const declared = optionsDeclaredBy(asked);
  refuseARepeatedCombination(asked, declared);
  const grouping = options?.collections ?? [];
  refuseATitleTwice(grouping);

  const merchant = options?.merchant ?? (await signInTestMerchant(kobai));
  const json = { ...merchant.headers, "content-type": "application/json" };

  // Before the Product, because the create names them by identifier — one request each, which
  // is what a Merchant makes too, and none at all for the test that groups nothing.
  const collections: TestCatalogCollection[] = [];
  for (const wanted of grouping) {
    if (typeof wanted !== "string") {
      collections.push(wanted);
      continue;
    }
    const collection = (await expectStatus(
      await kobai.request("/admin/collections", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ title: wanted }),
      }),
      201,
      `making the Collection ${wanted}`,
    )) as TestCatalogCollection;
    collections.push({ id: collection.id, title: collection.title });
  }

  const created = (await expectStatus(
    await kobai.request("/admin/products", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        title: options?.title ?? DEFAULT_TITLE,
        // Each left out entirely unless a test asked, so what a create does when a Merchant
        // names none of them is what every other test in this repository exercises.
        ...(options?.description === undefined
          ? {}
          : { description: options.description }),
        ...(declared.length === 0 ? {} : { options: declared.map((name) => ({ name })) }),
        ...(collections.length === 0
          ? {}
          : { collections: collections.map(({ id }) => ({ id })) }),
        variants: asked.map(({ sku, fulfilmentStrategy, options: answers }) => ({
          sku,
          // The same rule one level down: a Variant that says nothing about its Strategy is
          // what every other test in this repository is exercising.
          ...(fulfilmentStrategy === undefined
            ? {}
            : { fulfilment: { strategy: fulfilmentStrategy } }),
          // A Variant answers a *set* — the order a storefront offers the options in is the
          // Product's, declared above — so these go over as they were written.
          ...(declared.length === 0
            ? {}
            : {
                options: Object.entries(answers ?? {}).map(([name, value]) => ({
                  name,
                  value,
                })),
              }),
        })),
      }),
    }),
    201,
    "creating a Product",
  )) as { id: string; variants: readonly { id: string; sku: string }[] };

  // Published unless the test said otherwise, and skipped entirely for a draft — which is what
  // the create already left it as, so asking for one is asking for no second request rather than
  // for a request that sets it back.
  const status = options?.status ?? "published";
  if (status !== "draft") {
    await expectStatus(
      await kobai.request(`/admin/products/${created.id}`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ status }),
      }),
      200,
      `putting the Product into ${status}`,
    );
  }

  const variants: TestCatalogVariant[] = [];
  // By SKU rather than by position: a Product reports its Variants in SKU order, not in the
  // order they were asked for, so pairing them off by index prices the wrong Variant as soon
  // as a test seeds two.
  for (const spec of asked) {
    const variant = created.variants.find((row) => row.sku === spec.sku);
    if (variant === undefined) {
      throw new Error(
        `creating a Product answered without the Variant ${spec.sku}: ${created.variants.map((row) => row.sku).join(", ")}`,
      );
    }

    const prices: TestCatalogPrice[] = [];
    // In series rather than in parallel: setting a Price is an insert, so the order they
    // arrive in is the order they are in, and a test about the newest one depends on it.
    for (const amount of spec.prices ?? [DEFAULT_AMOUNT]) {
      const price = (await expectStatus(
        await kobai.request(`/admin/variants/${variant.id}/prices`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ amount }),
        }),
        201,
        `pricing ${variant.sku} at ${amount}`,
      )) as TestCatalogPrice;
      prices.push(price);
    }

    variants.push({ id: variant.id, sku: variant.sku, prices });
  }

  // One Variant per spec, and there is at least one spec — so this is the compiler's question
  // rather than a real one, and the answer costs a line.
  const [first] = variants;
  if (first === undefined) throw new Error("unreachable: a seeded catalog has a Variant");

  const apiKey = await createTestApiKey(kobai, merchant, { name: "storefront" });

  return {
    merchant,
    apiKey,
    productId: created.id,
    variantId: first.id,
    variants,
    collections,
    variant: (sku) => {
      const found = variants.find((candidate) => candidate.sku === sku);
      if (found === undefined) {
        throw new Error(
          `this catalog holds no Variant with SKU ${sku}: ${variants.map((candidate) => candidate.sku).join(", ")}`,
        );
      }
      return found;
    },
    collection: (title) => {
      const found = collections.find((candidate) => candidate.title === title);
      if (found === undefined) {
        throw new Error(
          `this catalog is in no Collection called ${title}: ${collections.length === 0 ? "it was seeded into none" : collections.map((candidate) => candidate.title).join(", ")}`,
        );
      }
      return found;
    },
  };
}

/** A Variant as the two judgements below read it: the SKU it will be named by, and its answers. */
type AskedVariant = TestVariantSpec & { readonly sku: string };

/** `POSTER-A2`, `POSTER-A3`, `POSTER-A4` — paper sizes, so a second Variant names itself. */
function skuFor(index: number): string {
  return `POSTER-A${index + 2}`;
}

/**
 * The options this Product declares: whichever ones its Variants answer, in the first one's
 * order — or a failure naming the two Variants that do not agree about them.
 *
 * **This is the whole of why the declaration is not an option of its own.** A Variant that
 * answers an option its Product never declared is refused `variant-options-mismatch` at 422, and
 * a helper taking the two halves separately could be handed exactly that; reading one off the
 * other leaves nowhere to write it down. What is left is the *other* direction of the same rule —
 * a Variant leaving a declared option unanswered — and it can only arise between siblings, so it
 * is answered here, naming both, rather than by the route naming this helper's request.
 */
function optionsDeclaredBy(asked: readonly AskedVariant[]): readonly string[] {
  const [first, ...rest] = asked;
  // The caller has already refused an empty list; this is the compiler's question.
  if (first === undefined) return [];

  const declared = Object.keys(first.options ?? {});
  for (const spec of rest) {
    const answered = Object.keys(spec.options ?? {});
    if (
      answered.length !== declared.length ||
      answered.some((name) => !declared.includes(name))
    ) {
      throw new Error(
        `every Variant of one Product answers exactly the options that Product declares, and seedTestCatalog declares whichever ones the Variants answer — so ${first.sku} answering ${spelled(declared)} and ${spec.sku} answering ${spelled(answered)} is a Product neither of them fits. POST /admin/products refuses it as variant-options-mismatch.`,
      );
    }
  }

  return declared;
}

/**
 * A failure where two Variants answer the options the same way — refused since #277.
 *
 * A storefront maps a chosen combination to a SKU, which it can only do where the mapping is a
 * function, so `POST /admin/products` refuses a body naming one combination twice — as `invalid`
 * rather than as `variant-combination-taken`, which is what the two routes that write a Variant
 * into a Product that already exists answer. A Product declaring no options has no combinations
 * at all, and any number of Variants of it is fine — the same reading the route takes.
 */
function refuseARepeatedCombination(
  asked: readonly AskedVariant[],
  declared: readonly string[],
): void {
  if (declared.length === 0) return;

  const skuByCombination = new Map<string, string>();
  for (const spec of asked) {
    const combination = JSON.stringify(declared.map((name) => spec.options?.[name]));
    const already = skuByCombination.get(combination);
    if (already !== undefined) {
      throw new Error(
        `${already} and ${spec.sku} answer this Product's options the same way — ${declared.map((name) => `${name} ${JSON.stringify(spec.options?.[name])}`).join(", ")} — and a storefront maps a combination a Shopper chose to one Variant, so two of them cannot answer it (#277). POST /admin/products refuses that body as invalid.`,
      );
    }
    skuByCombination.set(combination, spec.sku);
  }
}

/**
 * Nothing, or a failure where one Collection is asked for twice.
 *
 * **Keyed by title, which catches two things rather than one.** The Collection a previous seed
 * handed back, named twice, is `collections` carrying one identifier twice — refused 400, and so
 * the arrangement this exists to make unsendable. Two *titles* the same is the wider half and the
 * route takes it, titles being deliberately not unique: it would make a second Collection of the
 * name and leave {@link TestCatalog.collection} able to answer either, which is a helper choosing
 * for the test. Both are one refusal because both are "ask for it once".
 */
function refuseATitleTwice(wanted: readonly (string | TestCatalogCollection)[]): void {
  const seen = new Set<string>();
  for (const one of wanted) {
    const title = typeof one === "string" ? one : one.title;
    if (seen.has(title)) {
      throw new Error(
        `seedTestCatalog was asked for the Collection ${JSON.stringify(title)} twice, and a catalog's Collections are asked for by title. Name it once — a Collection a previous seed handed back groups this Product into that one rather than into a second of the name.`,
      );
    }
    seen.add(title);
  }
}

/** `"Size" and "Finish"`, or `no options at all` — what a refusal above names. */
function spelled(names: readonly string[]): string {
  if (names.length === 0) return "no options at all";
  const quoted = names.map((name) => JSON.stringify(name));
  const last = quoted.at(-1);
  return quoted.length === 1
    ? (last ?? "")
    : `${quoted.slice(0, -1).join(", ")} and ${last}`;
}
