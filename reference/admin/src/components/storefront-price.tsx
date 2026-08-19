import type { KobaiClient, ResolvedPrice } from "@kobai/client";
import { useMutation } from "@tanstack/react-query";
import { Problem } from "@/components/problem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  clearPreviewKey,
  PREVIEW_KEY_NAME,
  readPreviewKey,
  writePreviewKey,
} from "@/lib/preview-key";
import { isApiKeyRejected, messageOf, Refused } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The price a storefront would receive (spec story 53), and the screen that closes the loop.
 *
 * It does not ask the admin surface what the price is. There is no such route, and there
 * should not be: a resolved price is what the **store** surface answers, behind an API key,
 * and the only way to find out what a storefront gets is to make a storefront's request
 * (ADR-0010 — the Admin is a consumer of the public API, not a privileged one). So this
 * mints a publishable key through `POST /admin/api-keys`, and then calls
 * `GET /store/variants/{id}/price` with it, exactly as a storefront's browser would.
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
  entered,
}: {
  readonly variantId: string;
  /** The newest Price the Merchant entered, if there is one, to compare against. */
  readonly entered: { readonly amount: number; readonly currency: string } | null;
}) {
  const client = useKobaiClient();

  const ask = useMutation({
    mutationFn: (): Promise<ResolvedPrice> => askAsAStorefront(client, variantId),
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
        <Button
          size="sm"
          variant="outline"
          disabled={ask.isPending}
          onClick={() => ask.mutate()}
        >
          {ask.isPending ? <Spinner /> : null}
          {resolved ? "Ask again" : "What would a storefront receive?"}
        </Button>
        <span className="text-muted-foreground text-xs">
          Asked over <code>/store</code>, with a publishable API key — the way a
          storefront asks.
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

/**
 * Something the store surface, or the mint before it, would not do.
 *
 * It extends {@link Refused} rather than `Error` so that the refusal **body travels**, which is
 * the whole reason that class carries one: a screen that has to narrow still can, and
 * `problemOf` reads it like any other refusal. What it adds is the sentence to show when kobai
 * sent no prose of its own — the mint and the price want different ones, and the revoked-key
 * case has no body at all, because from kobai's side that was an ordinary `api-key-revoked`
 * and the sentence a Merchant needs is about this browser rather than about that request.
 */
class PreviewRefused extends Refused {
  constructor(refusal: unknown, fallback: string) {
    super(refusal);
    this.name = "PreviewRefused";
    this.message = messageOf(refusal, fallback);
  }
}

/** What to show when no price came back — never `TypeError: Failed to fetch`. */
function whyNoPrice(thrown: unknown): string {
  if (thrown instanceof PreviewRefused) return thrown.message;
  return "The store surface could not be reached at all, so no price was resolved.";
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
  const held = readPreviewKey() ?? (await mintPreviewKey(client));
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

/**
 * A publishable key for this browser session, minted through the public API.
 *
 * Publishable rather than secret on purpose: `kobai_pk_` is the kind that is safe in a
 * browser, and both kinds open the price route because a resolved price is public
 * information. A secret key here would be the exact mistake the two prefixes exist to make
 * visible.
 *
 * The value is shown once and never again, so it is kept for the rest of this browser
 * session and reused. Revoke it from the API keys screen, where every key this deployment
 * has issued is listed.
 */
async function mintPreviewKey(client: KobaiClient): Promise<string> {
  const { data, error } = await client.POST("/admin/api-keys", {
    body: { name: PREVIEW_KEY_NAME, kind: "publishable" },
  });
  if (!data) {
    throw new PreviewRefused(error, "A publishable key could not be minted.");
  }
  writePreviewKey(data.key);
  return data.key;
}
