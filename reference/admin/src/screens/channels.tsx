import { zodResolver } from "@hookform/resolvers/zod";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { RouteIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { LinkButton } from "@/components/link-button";
import { Pager, usePageCursor } from "@/components/pager";
import { Problem } from "@/components/problem";
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
import { channelReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The routes to market this Store sells through, and the way to define another (#291).
 *
 * **A Channel is a name and nothing else, and there is no switcher anywhere in this Admin.**
 * ADR-0005 names kobai's Channel as a *sales channel only*, against Vendure's, which overloads
 * the same word to mean tenant boundary — so nothing on this screen scopes anything, and a
 * control that made one Channel "current" would be the first move of exactly the retrofit that
 * record exists to refuse.
 *
 * **Which requests are in a Channel is decided by the API key that presents them**, so there is
 * no list of keys on a row here: a key is bound to a Channel when it is minted, on the API keys
 * screen, and `GET /admin/api-keys` is where that binding is read back.
 */
const CHANNELS = "channels";

export function Channels() {
  const client = useKobaiClient();
  const after = usePageCursor();

  const page = useQuery({
    queryKey: [CHANNELS, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/channels", {
          params: { query: after === undefined ? {} : { after } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const channels = page.data?.channels;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Channels
            {page.isFetching && !page.isPending ? <Spinner /> : null}
          </CardTitle>
          <CardDescription>
            How this Store reaches its Shoppers — your own storefront, a marketplace
            listing. A Channel is a route to market and nothing else: nothing is scoped by
            one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Problem
            problem={
              page.isError
                ? problemOf(page.error, "The Channels could not be read.")
                : null
            }
          />

          {page.isPending ? <ChannelsLoading /> : null}

          {channels !== undefined && channels.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RouteIcon />
                </EmptyMedia>
                <EmptyTitle>No Channels yet</EmptyTitle>
                <EmptyDescription>
                  A Store that sells through one route to market needs none — every API
                  key is then in no particular Channel, which is what they all are. Define
                  one when a second route needs prices of its own.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {channels !== undefined && channels.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((channel) => (
                  <TableRow key={channel.id}>
                    <TableCell className="font-medium">{channel.name}</TableCell>
                    <TableCell>
                      <LinkButton
                        to={`/channels/${channel.id}`}
                        size="sm"
                        variant="outline"
                      >
                        Open
                      </LinkButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <Pager nextCursor={page.data?.nextCursor} label="Channels" />
        </CardContent>
      </Card>

      <NewChannel />
    </div>
  );
}

/** A page of Channels, before there is one. */
function ChannelsLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the Channels">
      {["first", "second", "third"].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * `min(1)` on the name is the field being required. There is nothing else to check: a name is
 * deliberately **not** unique — a Channel is addressed by its identifier everywhere — so there
 * is no taken-name rule to mirror here and no refusal to predict.
 */
const NewChannelForm = z.object({
  name: z.string().min(1, "A Channel is named — the route to market, as you call it."),
});

type NewChannelValues = z.infer<typeof NewChannelForm>;

/** A Channel, which is a name and nothing else. */
function NewChannel() {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.storeWrite, "define a Channel");

  const form = useForm<NewChannelValues>({
    resolver: zodResolver(NewChannelForm),
    defaultValues: { name: "" },
  });

  const create = useMutation({
    mutationFn: async (values: NewChannelValues) =>
      orThrow(await client.POST("/admin/channels", { body: { name: values.name } })),
    onSuccess: () => form.reset(),
    // Read back rather than patched in: there is no optimistic update anywhere in this Admin
    // (ADR-0063).
    onSettled: () => queries.invalidateQueries({ queryKey: [CHANNELS] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Channel</CardTitle>
        <CardDescription>
          A name, and nothing else. Bind an API key to it when you mint one, and every
          request presenting that key is in this Channel.
        </CardDescription>
      </CardHeader>
      {/* No guard of its own: Enter in a field is implicit submission, which a browser
          performs by clicking this form's default button — the `ActionButton` below, whose
          handler is the no-op for a Merchant who may not define one. */}
      <form onSubmit={form.handleSubmit((values) => create.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={create.isError ? whyNotCreated(create.error) : null}
            title="The Channel was not created."
          />
          <FormField
            id="new-channel-name"
            label="Name"
            placeholder="Marketplace"
            error={form.formState.errors.name}
            {...form.register("name")}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton
            type="submit"
            unavailable={unavailable}
            disabled={create.isPending}
          >
            {create.isPending ? <Spinner /> : null}
            Create Channel
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Why kobai turned the creation back, in words a Merchant can act on.
 *
 * Exhaustive over `ChannelRefusal`, and the `never` at the bottom is what keeps it so. The
 * family is as small as a Collection's, and every arm below is honest about that — a creation
 * cannot be not-found, so it reports kobai's own prose rather than a sentence written here for a
 * case nobody has seen.
 */
function whyNotCreated(thrown: unknown): string {
  const fallback = "The Channel could not be created.";
  const reason = channelReasonOf(thrown);

  switch (reason) {
    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
      return problemOf(thrown, fallback);

    case "channel-not-found":
      // A refusal of a change or a deletion, not reachable from a creation.
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
