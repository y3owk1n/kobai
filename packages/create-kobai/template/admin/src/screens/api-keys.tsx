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
import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { ListboxField } from "@/components/listbox-field";
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
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { clearPreviewKey, readPreviewKey, writePreviewKey } from "@/lib/preview-key";
import {
  apiKeyNotFoundReasonOf,
  mintApiKeyReasonOf,
  orThrow,
  problemOf,
} from "@/lib/refusal";
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

/**
 * What the mint form's Channel picker calls *no Channel at all* (#291).
 *
 * A sentinel rather than `""`, because `""` is what a `ListboxField` means by "nothing chosen"
 * and this is a choice: a key in no particular Channel is what every key is until a Merchant
 * decides otherwise, and it is the right answer for a Store with one route to market.
 */
const NO_CHANNEL = "none";

/** Its own cache key, deliberately not the Channels screen's — see `lib/store.ts`. */
const OFFERED_CHANNELS = "offered-channels";

export function ApiKeys() {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const after = usePageCursor();
  // Asked once for the screen rather than once per row: a hook cannot be called inside the map
  // below, and the answer is a property of the Role rather than of the key (ADR-0063).
  const cannotRevoke = useUnavailable(PERMISSIONS.apiKeyWrite, "revoke a key");

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
                        <ActionButton
                          size="sm"
                          variant="destructive"
                          // Shown and explained rather than hidden when the Role cannot revoke:
                          // a Merchant who may list keys and not revoke them should be able to
                          // see that revoking is a thing this deployment does (ADR-0063).
                          unavailable={cannotRevoke}
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
                        </ActionButton>
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
  /**
   * Which Channel every request presenting this key is in, or `""` for none (#291).
   *
   * **`""` is a real answer here and not an unfilled field**, which is why there is no `min(1)`
   * beside the name's: a key in no particular Channel is what every key is until a Merchant
   * decides otherwise, and it is the right answer for a Store that sells through one route to
   * market. The submit turns it into an absent `channelId` rather than sending an empty string.
   */
  channelId: z.string(),
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
  const unavailable = useUnavailable(PERMISSIONS.apiKeyWrite, "mint a key");

  const form = useForm<MintKeyValues>({
    resolver: zodResolver(MintKeyForm),
    defaultValues: { name: "", channelId: NO_CHANNEL },
  });

  // The Channels a key may be bound to, read from kobai rather than written down — the same rule
  // the Fulfilment Strategy picker follows. It does not page, which is the known gap
  // `lib/collections.ts` names: a Store with more than a hundred Channels has some this control
  // cannot offer, and the Channels section is where all of them are.
  const channels = useQuery({
    queryKey: [OFFERED_CHANNELS],
    queryFn: async () =>
      orThrow(await client.GET("/admin/channels", { params: { query: { limit: 100 } } })),
  });

  const mint = useMutation({
    mutationFn: async ({ name, channelId }: MintKeyValues) =>
      orThrow(
        await client.POST("/admin/api-keys", {
          body: {
            name,
            kind: "publishable",
            // Absent rather than empty: kobai reads a missing `channelId` as *in no particular
            // Channel*, and an empty string is a body it would refuse.
            ...(channelId === NO_CHANNEL ? {} : { channelId }),
          },
        }),
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
      {/* No guard of its own: Enter in the field above is implicit submission, which a browser
          performs by clicking this form's default button — the `ActionButton` below, whose
          handler is the no-op. */}
      <form onSubmit={form.handleSubmit((values) => mint.mutate(values))}>
        <CardContent className="grid gap-4">
          <Problem
            title="The key was not minted."
            problem={mint.isError ? whyNotMinted(mint.error) : null}
          />
          <FormField
            id="mint-key-name"
            label="Name"
            placeholder="the shop's browser"
            error={form.formState.errors.name}
            {...form.register("name")}
          />
          <ListboxField
            control={form.control}
            name="channelId"
            id="mint-key-channel"
            label="Channel"
            options={[
              // **In no particular Channel is an option rather than an empty picker**, because
              // it is the answer most keys want and a Merchant should be able to choose it on
              // purpose. It heads the list for the same reason.
              { value: NO_CHANNEL, label: "In no particular Channel" },
              ...(channels.data?.channels ?? []).map((channel) => ({
                value: channel.id,
                label: channel.name,
              })),
            ]}
            description="Which route to market every request presenting this key is in. It is decided here and cannot be changed afterwards — a key in the wrong Channel is replaced by minting another and revoking this one."
          />
        </CardContent>
        <CardFooter className="mt-4 gap-2">
          <ActionButton type="submit" unavailable={unavailable} disabled={mint.isPending}>
            {mint.isPending ? <Spinner /> : null}
            Mint
          </ActionButton>
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
 * Why a key was not **minted**, in words a Merchant can act on (#291).
 *
 * Exhaustive over `MintApiKeyRefusal`, which is its own family and not the store gate's: this is
 * a Merchant being turned back at `POST /admin/api-keys`, where `ApiKeyRefusal` is a storefront
 * presenting a credential kobai will not take.
 */
function whyNotMinted(thrown: unknown): string {
  const fallback = "kobai turned the request back.";
  const reason = mintApiKeyReasonOf(thrown);

  switch (reason) {
    case "channel-not-found":
      return "That Channel is no longer there — somebody else deleted it, or this page has been open a while. Choose another, or mint the key in no particular Channel.";

    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
      return problemOf(thrown, fallback);

    case undefined:
      // A 500, which carries no `reason` on purpose, or the network being gone.
      return fallback;

    default: {
      const unreached: never = reason;
      return unreached;
    }
  }
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
