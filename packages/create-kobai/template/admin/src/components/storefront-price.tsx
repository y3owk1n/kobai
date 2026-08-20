import type { KobaiClient, ProductStatus, ResolvedPrice } from "@kobai/client";
import { useMutation } from "@tanstack/react-query";
import { ActionButton } from "@/components/action-button";
import { Problem } from "@/components/problem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createStorefrontClient } from "@/lib/kobai";
import { formatAmount } from "@/lib/money";
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { clearPreviewKey, heldPreviewKey, PreviewRefused } from "@/lib/preview-key";
import { isApiKeyRejected } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The price a storefront would receive (spec story 53), and the screen that closes the loop.
 *
 * **For a Product that is on sale it asks by being a storefront**, which is the shape this
 * screen has always had and the one to keep: a resolved price is what the **store** surface
 * answers, behind an API key, and the only way to find out what a storefront gets is to make a
 * storefront's request (ADR-0010 — the Admin is a consumer of the public API, not a privileged
 * one). So it mints a publishable key through `POST /admin/api-keys`, and then calls
 * `GET /store/variants/{id}/price` with it, exactly as a storefront's browser would.
 *
 * **For a draft or an archived Product there is no storefront to be** (#276). The store surface
 * answers only published Products — on the price route as well as on the two catalog reads, as
 * of that ticket — so a request over `/store` for a Product a Merchant has not published yet
 * comes back `variant-not-found`, which is the correct answer to a question no storefront could
 * ask. Checking a price *before* putting something on sale is exactly when a Merchant wants to
 * know it, so the ask moves to `GET /admin/variants/{id}/price`: the same `resolve-price`, the
 * same Steps, the same body, on the surface a Merchant's session opens. The screen **says which
 * of the two it did**, because "what a storefront receives" and "what a storefront would receive
 * if you published this" are two sentences and a Merchant should not have to work out which one
 * they are reading.
 *
 * That indirection is the point rather than an inconvenience. In this Project the answer is
 * **not** the Price the Merchant entered: `kobai.config.ts` replaces the `select-price` Step
 * with `everything-costs-one-cent`, so a Variant priced at 12.50 resolves to one cent. The
 * difference is rendered loudly, and named — `workflow.steps` reports the slot and what
 * filled it, so the Admin can say *which* Step is somebody else's rather than only that the
 * number is odd.
 *
 * **It is a mutation rather than a query, and that is not a technicality.** Asking costs a
 * key — the first ask on a browser session with none mints one — so it happens when a Merchant
 * asks for it and never because a component mounted, and TanStack Query's word for a call made
 * on purpose is a mutation. `PriceRefusal` is one of the two families whose `reason` is an open
 * string (ADR-0060), because a Project's own Step may refuse with a word Core has never heard
 * of, so what comes back here takes the prose by design rather than a narrowed arm.
 */
export function StorefrontPrice({
  variantId,
  status,
  entered,
}: {
  readonly variantId: string;
  /**
   * The **Product's** status, which decides which surface can answer at all.
   *
   * It comes from the record above rather than being read here: the screen has already asked
   * for the Product, and a second read to find out something it is holding would be a second
   * answer that could disagree with the badge beside it.
   */
  readonly status: ProductStatus;
  /** The newest Price the Merchant entered, if there is one, to compare against. */
  readonly entered: { readonly amount: number; readonly currency: string } | null;
}) {
  const client = useKobaiClient();
  const onSale = status === "published";

  /**
   * Asking as a storefront costs a key, so that ask's Permission is the one that mints one.
   *
   * `api-key:write` rather than anything about the catalog: the store surface is reached with a
   * credential and the first ask on a browser session with none mints it, so a Role that cannot
   * mint cannot make a storefront's request at all. It is shown and explained rather than
   * hidden, like every other unavailable action (ADR-0063) — this is the one screen that says
   * what a storefront actually receives, and a Merchant who cannot see the control has no way
   * to learn the question can be asked.
   *
   * **It is deliberately wider than the operation**, by exactly one case: a browser session
   * already holding a preview key needs no mint, so a Role narrowed *since* that key was stored
   * is told it cannot do something it could. Asking `readPreviewKey()` instead would be worse
   * than the case it fixes — `sessionStorage` is not something React re-renders for, so the
   * control would go available only on the next render that happened for some other reason,
   * which is the flicker `screens/api-keys.tsx` mirrors that value into state to avoid.
   */
  const cannotMint = useUnavailable(
    PERMISSIONS.apiKeyWrite,
    "ask what a storefront would receive",
  );
  /**
   * And the Permission the *other* ask needs, which is the one that reads the catalog (#276).
   *
   * Both hooks are called on every render because that is what a hook is; which of the two
   * answers is used is the branch below. A Merchant looking at this screen at all holds
   * `catalog:read`, so this is `null` in practice — it is asked rather than assumed because the
   * route really is gated on it, and an affordance that guessed would be the one thing
   * `lib/permissions.ts` says these checks must not do.
   */
  const cannotRead = useUnavailable(
    PERMISSIONS.catalogRead,
    "ask what a storefront would receive",
  );
  const unavailable = onSale ? cannotMint : cannotRead;

  const ask = useMutation({
    mutationFn: (): Promise<ResolvedPrice> =>
      onSale ? askAsAStorefront(client, variantId) : askAsAMerchant(client, variantId),
  });

  const resolved = ask.data;
  const differs =
    resolved !== undefined &&
    entered !== null &&
    resolved.price.amount !== entered.amount;
  const replaced = (resolved?.workflow.steps ?? []).filter(
    (ran) => ran.implementation !== ran.step,
  );

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <ActionButton
          size="sm"
          variant="outline"
          unavailable={unavailable}
          disabled={ask.isPending}
          onClick={() => ask.mutate()}
        >
          {ask.isPending ? <Spinner /> : null}
          {resolved ? "Ask again" : "What would a storefront receive?"}
        </ActionButton>
        <span className="text-muted-foreground text-xs">
          {onSale ? (
            <>
              Asked over <code>/store</code>, with a publishable API key — the way a
              storefront asks.
            </>
          ) : (
            <>
              This Product is not published, so no storefront can ask at all. Asked over{" "}
              <code>/admin</code> instead — the same <code>resolve-price</code> Workflow,
              on a Product a Shopper cannot see.
            </>
          )}
        </span>
      </div>

      <Problem
        title="No price came back."
        problem={ask.isError ? whyNoPrice(ask.error) : null}
      />

      {resolved ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div>
              <div className="text-muted-foreground text-xs">Entered by you</div>
              <div className="font-medium text-lg">
                {entered ? formatAmount(entered.amount, entered.currency) : "—"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">
                Received by a storefront
              </div>
              <div className="font-medium text-lg">
                {formatAmount(resolved.price.amount, resolved.price.currency)}
              </div>
            </div>
          </div>

          {differs ? (
            <Alert variant="destructive">
              <AlertTitle>This Project changed the price.</AlertTitle>
              <AlertDescription>
                A storefront is told{" "}
                {formatAmount(resolved.price.amount, resolved.price.currency)}, not the{" "}
                {entered
                  ? formatAmount(entered.amount, entered.currency)
                  : "amount you entered"}
                . That is not a bug in kobai:{" "}
                {replaced.length > 0 ? (
                  <>
                    the <code>{replaced.map((ran) => ran.step).join(", ")}</code> Step of{" "}
                    <code>{resolved.workflow.name}</code> is filled by this Project's own{" "}
                    <code>{replaced.map((ran) => ran.implementation).join(", ")}</code>.
                  </>
                ) : (
                  <>
                    the <code>{resolved.workflow.name}</code> Workflow decided it.
                  </>
                )}
              </AlertDescription>
            </Alert>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Filled by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resolved.workflow.steps.map((ran) => (
                <TableRow key={ran.step}>
                  <TableCell>
                    <code>{ran.step}</code>
                  </TableCell>
                  <TableCell>
                    <code>{ran.implementation}</code>{" "}
                    {ran.implementation === ran.step ? null : (
                      <Badge variant="destructive">replaced</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

/** What to show when no price came back — never `TypeError: Failed to fetch`. */
function whyNoPrice(thrown: unknown): string {
  if (thrown instanceof PreviewRefused) return thrown.message;
  return "kobai could not be reached at all, so no price was resolved.";
}

/**
 * The same question, asked over `/admin`, for a Product no storefront may see (#276).
 *
 * No key and no second client: this is the Merchant's own session, on a route that runs the
 * deployment's `resolve-price` and answers the identical body — which is what makes the number
 * on screen the one a storefront *would* be told the moment this Product is published. It is
 * deliberately not a fallback the storefront path drops into on a refusal: the two are asked in
 * two different situations, and a screen that retried over `/admin` whenever `/store` said no
 * would quietly paper over a real refusal on a Product that is on sale.
 */
async function askAsAMerchant(
  client: KobaiClient,
  variantId: string,
): Promise<ResolvedPrice> {
  const { data, error } = await client.GET("/admin/variants/{id}/price", {
    params: { path: { id: variantId } },
  });
  if (data) return data;

  throw new PreviewRefused(error, "kobai refused to resolve a price.");
}

/**
 * One storefront's request for a price, with a storefront's credential.
 *
 * The key kept for this browser session is reused; a session with none mints one. A refusal
 * whose `reason` names the key itself means the stored one has been revoked, or was minted
 * against a database that has since gone — so it is forgotten, which is what makes the next
 * attempt mint a fresh one rather than leaving the Merchant presenting a dead credential.
 */
async function askAsAStorefront(
  client: KobaiClient,
  variantId: string,
): Promise<ResolvedPrice> {
  const held = await heldPreviewKey(client);
  const storefront = createStorefrontClient(held);

  const { data, error } = await storefront.GET("/store/variants/{id}/price", {
    params: { path: { id: variantId } },
  });
  if (data) return data;

  if (isApiKeyRejected(error)) {
    // The key kept for this browser session has been revoked, or was minted against a database
    // that has since gone. Forgetting it is what makes the next attempt mint a fresh one,
    // rather than leaving the Merchant presenting a dead credential.
    clearPreviewKey();
    throw new PreviewRefused(
      null,
      "The publishable key this browser was using no longer works — it has been revoked. Ask again and a fresh one will be minted.",
    );
  }

  throw new PreviewRefused(error, "The store surface refused to resolve a price.");
}
