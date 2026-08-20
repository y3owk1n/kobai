import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RouteIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { ConfirmDelete } from "@/components/confirm-delete";
import { FormField } from "@/components/form-field";
import { LinkButton } from "@/components/link-button";
import { Problem } from "@/components/problem";
import {
  Card,
  CardAction,
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
import { useCrumbTitle } from "@/lib/crumb";
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { channelReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";

/**
 * One Channel: what it is called, and the way to remove it (#291, ADR-0005).
 *
 * **There is no list of the API keys in it and no way to move one**, and both absences are the
 * shape rather than a simplification: a key is bound to a Channel when it is minted and never
 * afterwards, which is what makes the binding something a storefront cannot forge. The API keys
 * screen reports each key's Channel, and the repair for a key in the wrong one is to mint
 * another and revoke it.
 *
 * `metadata` is deliberately never sent, for the Region screen's reason: `PATCH` replaces it
 * rather than merging (ADR-0062), and leaving the field out is what "leave it alone" means.
 */
const CHANNEL = "channel";

export function ChannelScreen() {
  const client = useKobaiClient();
  const id = useRouteId();

  const channel = useQuery({
    queryKey: [CHANNEL, id],
    queryFn: async () =>
      orThrow(await client.GET("/admin/channels/{id}", { params: { path: { id } } })),
  });

  // The breadcrumb otherwise reads as the identifier out of the URL, which is the one thing on
  // this screen a Merchant cannot use to tell one Channel from another.
  useCrumbTitle(channel.data?.name);

  if (channel.isPending) return <ChannelLoading />;

  if (channel.isError) {
    return channelReasonOf(channel.error) === "channel-not-found" ? (
      <NoSuchChannel />
    ) : (
      <Problem
        title="That Channel could not be read."
        problem={problemOf(channel.error, "kobai did not answer.")}
      />
    );
  }

  return (
    <div className="grid gap-6">
      {/* An `h2`: the frame renders the page's `h1` from the route, so this is the heading
          under it rather than a second first-level one. */}
      <h2 className="font-medium text-xl">{channel.data.name}</h2>

      <ChannelIdentity id={id} name={channel.data.name} />
    </div>
  );
}

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * There is no uniqueness rule to mirror: a Channel's name is deliberately not unique, so
 * `min(1)` is the whole of what this field can be wrong about.
 */
const ChannelForm = z.object({
  name: z.string().min(1, "A Channel is named — the route to market, as you call it."),
});

type ChannelValues = z.infer<typeof ChannelForm>;

/** What the Channel is called, and the way to delete it. */
function ChannelIdentity({ id, name }: { readonly id: string; readonly name: string }) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const navigate = useNavigate();
  const unavailable = useUnavailable(PERMISSIONS.storeWrite, "change the Store");

  const form = useForm<ChannelValues>({
    resolver: zodResolver(ChannelForm),
    // `values` rather than `defaultValues`, so a change that landed leaves the form showing
    // what kobai now holds rather than what was typed at it.
    values: { name },
  });

  const save = useMutation({
    mutationFn: async (values: ChannelValues) =>
      orThrow(
        await client.PATCH("/admin/channels/{id}", {
          params: { path: { id } },
          body: { name: values.name },
        }),
      ),
    // Re-read rather than patched in place, like every write in this Admin (ADR-0063).
    onSuccess: () => void queries.invalidateQueries({ queryKey: [CHANNEL, id] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel</CardTitle>
        <CardDescription>
          A route to market. Which requests are in it is decided by the API keys minted
          against it — mint one on the API keys screen.
        </CardDescription>
        <CardAction>
          <ConfirmDelete
            trigger="Delete Channel"
            title="Delete this Channel?"
            // The sentence a Merchant most needs before pressing this, and the one thing about
            // a Channel that is genuinely surprising: the keys are not revoked with it.
            description="Every API key minted against it keeps working, in no particular Channel — which is what every key is until one is minted against one. Nothing is deleted but the Channel itself."
            unavailable={unavailable}
            onDelete={async () =>
              orThrow(
                await client.DELETE("/admin/channels/{id}", { params: { path: { id } } }),
              )
            }
            // Away from an address that no longer resolves. The list behind it re-reads on
            // arrival — nothing in this cache is ever fresh — so there is no key to invalidate.
            onDeleted={() => void navigate("/channels", { replace: true })}
            problemOf={whyNotDeleted}
          />
        </CardAction>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The Channel was not changed."
          />
          <FormField
            id="channel-name"
            label="Name"
            error={form.formState.errors.name}
            {...form.register("name")}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save Channel
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/** The Channel, before it is there. */
function ChannelLoading() {
  return (
    <div className="grid gap-6" role="status" aria-label="Reading the Channel">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** An address naming a Channel this Store does not have. */
function NoSuchChannel() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RouteIcon />
        </EmptyMedia>
        <EmptyTitle>No such Channel</EmptyTitle>
        <EmptyDescription>
          This Store has no Channel at that address. It may have been deleted since the
          link was made — which leaves every API key minted against it working, in no
          particular Channel.
        </EmptyDescription>
      </EmptyHeader>
      <LinkButton to="/channels">Go to Channels</LinkButton>
    </Empty>
  );
}

/** Why kobai refused a **change** to this Channel. */
function whyNotChanged(thrown: unknown): string {
  const fallback = "kobai would not make that change.";
  const reason = channelReasonOf(thrown);

  switch (reason) {
    case "channel-not-found":
      return "It is no longer there — somebody else deleted this Channel, or this page has been open a while. The API keys minted against it are unaffected.";

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
 * Why kobai refused the **deletion**, rendered inside the dialog it was attempted from
 * (ADR-0059).
 *
 * There is one reason it can be, and no rule anywhere that would add a second: a Channel with a
 * hundred keys against it deletes exactly as one with none does.
 */
function whyNotDeleted(thrown: unknown): string {
  const fallback = "The Channel was not deleted.";
  const reason = channelReasonOf(thrown);

  switch (reason) {
    case "channel-not-found":
      return "It is already gone — somebody else deleted it, or this page has been open a while.";

    case "invalid":
    case "malformed-body":
      // Not reachable from a delete, which sends no body. Reported as kobai said it rather than
      // as a sentence written here for a case nobody has seen.
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
