import { zodResolver } from "@hookform/resolvers/zod";
import type { IssuedApiKey } from "@kobai/client";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormField } from "@/components/form-field";
import { Pager, usePageCursor } from "@/components/pager";
import { Problem } from "@/components/problem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { clearPreviewKey, readPreviewKey, writePreviewKey } from "@/lib/preview-key";
import { apiKeyNotFoundReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * Every API key this deployment has issued, and the way to revoke one.
 *
 * `GET /admin/api-keys` exists because of what was missing without it: minting shows the
 * value once and the id once, so a Merchant who lost that response held a live credential
 * they could not name. Nothing in the list is presentable — only a digest of a key is
 * stored, so there is no value to show and no fragment of one is offered instead. `name` is
 * what tells two keys apart, which is why minting demands one.
 *
 * **It pages through the cursor like the other two lists**, with the cursor in the URL
 * (ADR-0064). Keys accumulate whether or not anybody is minting them: the storefront price
 * preview mints one per browser session that has none, because a key's value cannot be
 * recovered and so cannot be reused across sessions. A screen showing the first page and no
 * more is a screen on which the older half of a deployment's credentials cannot be revoked.
 */
const API_KEYS = "api-keys";

export function ApiKeys() {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const after = usePageCursor();

  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  // `sessionStorage` is not something React re-renders for, so what is held there is mirrored
  // into state. Reading it during render instead would leave the "Forget" button on screen
  // after it had done its work.
  const [previewing, setPreviewing] = useState(readPreviewKey() !== null);

  const page = useQuery({
    queryKey: [API_KEYS, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/api-keys", {
          params: { query: after === undefined ? {} : { after } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const revoked = await client.DELETE("/admin/api-keys/{id}", {
        params: { path: { id } },
      });
      // A 204 carries no body, so `data` is `undefined` either way and `error` is what tells
      // the two apart — which is exactly what `orThrow` is for.
      orThrow(revoked);
      return id;
    },
    onSuccess: (id) => {
      // Revoking the key still on screen takes its value off the screen with it: offering to
      // copy a credential that has stopped working is worse than offering nothing.
      setIssued((shown) => (shown?.id === id ? null : shown));
    },
    // Read back rather than patched in place — there is no optimistic update anywhere in this
    // Admin (ADR-0063), and when a key was revoked is kobai's answer.
    onSettled: () => queries.invalidateQueries({ queryKey: [API_KEYS] }),
  });

  const keys = page.data?.apiKeys;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            API keys
            {page.isFetching && !page.isPending ? <Spinner /> : null}
          </CardTitle>
          <CardDescription>
            The credentials a storefront presents at <code>/store</code>. A key's value is
            shown once, at creation, and stored only as a digest — so this list can name a
            key and never hand one back.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Problem
            problem={
              page.isError
                ? problemOf(page.error, "The API keys could not be read.")
                : null
            }
          />

          {issued ? (
            <Alert>
              <AlertTitle>Copy this now — it is shown once.</AlertTitle>
              <AlertDescription className="grid gap-2">
                <code className="break-all">{issued.key}</code>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      writePreviewKey(issued.key);
                      setPreviewing(true);
                      setIssued(null);
                    }}
                  >
                    Use it for storefront previews
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          {page.isPending ? <ApiKeysLoading /> : null}

          {keys !== undefined && keys.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRoundIcon />
                </EmptyMedia>
                <EmptyTitle>No keys have been minted</EmptyTitle>
                <EmptyDescription>
                  Nothing can reach <code>/store</code> until one exists — a storefront
                  presents a key on every request. Mint one below.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {keys !== undefined && keys.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Revoke</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">
                      {key.name}
                      <div className="text-muted-foreground text-xs">
                        <code>{key.id}</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={key.kind === "secret" ? "destructive" : "secondary"}
                      >
                        {key.kind}
                      </Badge>
                    </TableCell>
                    <TableCell>{new Date(key.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      {key.revokedAt
                        ? `revoked ${new Date(key.revokedAt).toLocaleString()}`
                        : "live"}
                    </TableCell>
                    <TableCell>
                      {key.revokedAt ? null : (
                        <Button
                          size="sm"
                          variant="destructive"
                          // Every Revoke is disabled while one is in flight — the list is
                          // about to be re-read, and two revocations racing would report
                          // against whichever finished last. The spinner is what says which
                          // row is the one being revoked, so "disabled" does not read as
                          // "broken" on the other five.
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(key.id)}
                        >
                          {revoke.isPending && revoke.variables === key.id ? (
                            <Spinner />
                          ) : null}
                          Revoke
                        </Button>
                      )}
                      {/* Where it was attempted, and not at the top of a card six rows away
                          (ADR-0063, spec story 25). A refusal here names one key, so it
                          belongs in that key's row. */}
                      {revoke.isError && revoke.variables === key.id ? (
                        <div className="mt-1 max-w-64 text-destructive text-xs">
                          {whyNotRevoked(revoke.error)}
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <Pager nextCursor={page.data?.nextCursor} label="API keys" />
        </CardContent>
      </Card>

      <MintKey
        onMinted={(key) => setIssued(key)}
        previewing={previewing}
        onForgetPreview={() => {
          clearPreviewKey();
          setPreviewing(false);
        }}
      />
    </div>
  );
}

/** A page of keys, before there is one. */
function ApiKeysLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the API keys">
      {["first", "second"].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The shape of the form, and **only** the shape (ADR-0063).
 *
 * `min(1)` is the field being **required** — what the `required` attribute said before there
 * was a schema — and not a claim about what kobai will accept. Whether a name is already
 * taken, how long one may be: those are Core's, they may change there, and they arrive as a
 * refusal rather than as a second stale copy of the rule in a browser.
 */
const MintKeyForm = z.object({
  name: z.string().min(1, "A key is told from another by its name, so it needs one."),
});

type MintKeyValues = z.infer<typeof MintKeyForm>;

/**
 * Minting a publishable key.
 *
 * Publishable and not secret, deliberately: `kobai_pk_` is the kind that is safe in a browser,
 * and it is the kind this Admin's own storefront preview presents. A secret key minted from a
 * browser screen would be the exact mistake the two prefixes exist to make visible — and a
 * Merchant who needs one for a server has `POST /admin/api-keys` and a terminal.
 */
function MintKey({
  onMinted,
  previewing,
  onForgetPreview,
}: {
  readonly onMinted: (key: IssuedApiKey) => void;
  readonly previewing: boolean;
  readonly onForgetPreview: () => void;
}) {
  const client = useKobaiClient();
  const queries = useQueryClient();

  const form = useForm<MintKeyValues>({
    resolver: zodResolver(MintKeyForm),
    defaultValues: { name: "" },
  });

  const mint = useMutation({
    mutationFn: async ({ name }: MintKeyValues) =>
      orThrow(
        await client.POST("/admin/api-keys", { body: { name, kind: "publishable" } }),
      ),
    onSuccess: (key) => {
      onMinted(key);
      form.reset();
    },
    onSettled: () => queries.invalidateQueries({ queryKey: [API_KEYS] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mint a publishable key</CardTitle>
        <CardDescription>
          <code>kobai_pk_…</code> is the kind that is safe in a browser. The Admin uses
          one to ask <code>/store</code> what price a storefront would receive.
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => mint.mutate(values))}>
        <CardContent className="grid gap-4">
          <Problem
            title="The key was not minted."
            problem={
              mint.isError
                ? problemOf(mint.error, "kobai turned the request back.")
                : null
            }
          />
          <FormField
            id="mint-key-name"
            label="Name"
            placeholder="the shop's browser"
            error={form.formState.errors.name}
            {...form.register("name")}
          />
        </CardContent>
        <CardFooter className="mt-4 gap-2">
          <Button type="submit" disabled={mint.isPending}>
            {mint.isPending ? <Spinner /> : null}
            Mint
          </Button>
          {previewing ? (
            <Button type="button" variant="ghost" onClick={onForgetPreview}>
              Forget the preview key
            </Button>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Why a key was not revoked, in words a Merchant can act on.
 *
 * `ApiKeyNotFound` is a family of one and the arm below is all of it; the `never` is what
 * keeps that true when it stops being one. Revoking a key that is *already* revoked is not
 * here at all, because the route answers 204 for it — the state asked for is the state it is
 * in — so this arrives only for a key that has gone since this page of the list was read.
 */
function whyNotRevoked(thrown: unknown): string {
  const reason = apiKeyNotFoundReasonOf(thrown);

  switch (reason) {
    case "api-key-not-found":
      return "kobai has no key with that identifier. It has gone since this list was read — reload to see what is actually issued.";

    case undefined:
      // A 500, which carries no `reason` on purpose, a refusal from one of the gates above
      // this route, or the network being gone.
      return problemOf(thrown, "kobai did not answer.");

    default: {
      const unreached: never = reason;
      return unreached;
    }
  }
}
