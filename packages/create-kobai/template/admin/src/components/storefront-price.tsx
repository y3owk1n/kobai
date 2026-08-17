import type { KobaiClient, ResolvedPrice } from "@kobai/client";
import { useState } from "react";
import { Problem } from "@/components/problem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { messageOf, reasonOf } from "@/lib/refusal";

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
 */
export function StorefrontPrice({
  client,
  variantId,
  entered,
}: {
  readonly client: KobaiClient;
  readonly variantId: string;
  /** The newest Price the Merchant entered, if there is one, to compare against. */
  readonly entered: { readonly amount: number; readonly currency: string } | null;
}) {
  const [resolved, setResolved] = useState<ResolvedPrice | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(): Promise<void> {
    setBusy(true);
    setProblem(null);
    setResolved(null);

    const held = readPreviewKey();
    const minted = held ? { ok: true as const, key: held } : await mintPreviewKey(client);
    if (!minted.ok) {
      setProblem(minted.problem);
      setBusy(false);
      return;
    }

    const storefront = createStorefrontClient(minted.key);
    const { data, error } = await storefront.GET("/store/variants/{id}/price", {
      params: { path: { id: variantId } },
    });

    if (data) {
      setResolved(data);
    } else if (reasonOf(error)?.startsWith("api-key-")) {
      // The key kept for this browser session has been revoked, or was minted against a
      // database that has since gone. Forgetting it is what makes the next attempt mint a
      // fresh one, rather than leaving the Merchant stuck presenting a dead credential.
      clearPreviewKey();
      setProblem(
        "The publishable key this browser was using no longer works — it has been revoked. Ask again and a fresh one will be minted.",
      );
    } else {
      setProblem(messageOf(error, "The store surface refused to resolve a price."));
    }
    setBusy(false);
  }

  const differs =
    resolved !== null && entered !== null && resolved.price.amount !== entered.amount;
  const replaced = (resolved?.workflow.steps ?? []).filter(
    (ran) => ran.implementation !== ran.step,
  );

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void ask()}>
          {resolved ? "Ask again" : "What would a storefront receive?"}
        </Button>
        <span className="text-muted-foreground text-xs">
          Asked over <code>/store</code>, with a publishable API key — the way a
          storefront asks.
        </span>
      </div>

      <Problem problem={problem} title="No price came back." />

      {resolved ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div>
              <div className="text-muted-foreground text-xs">Entered by you</div>
              <div className="text-lg font-medium">
                {entered ? formatAmount(entered.amount, entered.currency) : "—"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">
                Received by a storefront
              </div>
              <div className="text-lg font-medium">
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
type MintedPreviewKey =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly problem: string };

async function mintPreviewKey(client: KobaiClient): Promise<MintedPreviewKey> {
  const { data, error } = await client.POST("/admin/api-keys", {
    body: { name: PREVIEW_KEY_NAME, kind: "publishable" },
  });
  if (!data) {
    return {
      ok: false,
      problem: messageOf(error, "A publishable key could not be minted."),
    };
  }
  writePreviewKey(data.key);
  return { ok: true, key: data.key };
}
