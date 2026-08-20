import { zodResolver } from "@hookform/resolvers/zod";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { LayersIcon } from "lucide-react";
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
import { collectionReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The Collections this Store groups its catalog into, and the way to make another (#256).
 *
 * **A Collection carries no Products here, and that is the shape rather than a simplification.**
 * `GET /admin/collections` answers a title and nothing else — what is *in* one is
 * `GET /admin/products?collection=`, which pages, so a count beside each title would be a query
 * over the catalog for every row of every page. The link on each row is what asks that question,
 * and it lands on the Products screen with its own filter in force.
 *
 * It pages through the cursor like every other list here (ADR-0064), for ADR-0067's reason
 * rather than because a Store will have hundreds: a Merchant can create one over HTTP while a
 * colleague is reading the list.
 *
 * Renaming and deleting live on the Collection's own screen rather than in a row here, the way a
 * Role's and a Product's do.
 */
const COLLECTIONS = "collections";

export function Collections() {
  const client = useKobaiClient();
  const after = usePageCursor();

  const page = useQuery({
    queryKey: [COLLECTIONS, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/collections", {
          params: { query: after === undefined ? {} : { after } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const collections = page.data?.collections;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Collections
            {page.isFetching && !page.isPending ? <Spinner /> : null}
          </CardTitle>
          <CardDescription>
            How this catalog is grouped, so a storefront has navigation. A Product can be
            in as many as you like — which ones it is in is set on the Product itself.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Problem
            problem={
              page.isError
                ? problemOf(page.error, "The Collections could not be read.")
                : null
            }
          />

          {page.isPending ? <CollectionsLoading /> : null}

          {collections !== undefined && collections.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LayersIcon />
                </EmptyMedia>
                <EmptyTitle>No Collections yet</EmptyTitle>
                <EmptyDescription>
                  A catalog with no Collections is a flat list. Create one below, then
                  open a Product to put it in.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {collections !== undefined && collections.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  {/* Named rather than empty: a column header with no text is a column a
                      screen reader announces as nothing at all. */}
                  <TableHead className="w-0">
                    <span className="sr-only">Its Products</span>
                  </TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {collections.map((collection) => (
                  <TableRow key={collection.id}>
                    <TableCell className="font-medium">{collection.title}</TableCell>
                    <TableCell>
                      {/* Straight to the Products list with this Collection in force, rather
                          than a second paged list inside this screen: one list, one cursor,
                          one address a Merchant can send to a colleague. */}
                      <LinkButton
                        to={`/products?collection=${collection.id}`}
                        size="sm"
                        variant="ghost"
                      >
                        Its Products
                      </LinkButton>
                    </TableCell>
                    <TableCell>
                      <LinkButton
                        to={`/collections/${collection.id}`}
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

          <Pager nextCursor={page.data?.nextCursor} label="Collections" />
        </CardContent>
      </Card>

      <NewCollection />
    </div>
  );
}

/** A page of Collections, before there is one. */
function CollectionsLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the Collections">
      {["first", "second", "third"].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * `min(1)` on the title is the field being required. There is nothing else to check: a title is
 * deliberately **not** unique — a Collection is addressed by its identifier everywhere — so
 * there is no taken-name rule to mirror here and no refusal to predict.
 */
const NewCollectionForm = z.object({
  title: z
    .string()
    .min(1, "A Collection is named, and the name is what a storefront shows."),
});

type NewCollectionValues = z.infer<typeof NewCollectionForm>;

/**
 * A Collection, which starts empty and is filled from the Products in it.
 *
 * Gated on `catalog:write` as an affordance — the enforcement is Core's `requirePermission`, and
 * `lib/permissions.ts` says so at length. It is the catalog's own write and not a `collection:`
 * word of its own: a Merchant who may write the catalog may group it (ADR-0066).
 */
function NewCollection() {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.catalogWrite, "create a Collection");

  const form = useForm<NewCollectionValues>({
    resolver: zodResolver(NewCollectionForm),
    defaultValues: { title: "" },
  });

  const create = useMutation({
    mutationFn: async (values: NewCollectionValues) =>
      orThrow(await client.POST("/admin/collections", { body: { title: values.title } })),
    onSuccess: () => form.reset(),
    // Read back rather than patched in: there is no optimistic update anywhere in this Admin
    // (ADR-0063), and what a Collection looks like once kobai holds it is kobai's answer.
    onSettled: () => queries.invalidateQueries({ queryKey: [COLLECTIONS] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Collection</CardTitle>
        <CardDescription>
          A name, and nothing else. Two Collections may share one — kobai addresses them
          by identifier, so nothing is refused for being called what something else is
          called.
        </CardDescription>
      </CardHeader>
      {/* No guard of its own: Enter in a field is implicit submission, which a browser
          performs by clicking this form's default button — the `ActionButton` below, whose
          handler is the no-op for a Merchant who may not create one. */}
      <form onSubmit={form.handleSubmit((values) => create.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={create.isError ? whyNotCreated(create.error) : null}
            title="The Collection was not created."
          />
          <FormField
            id="new-collection-title"
            label="Title"
            placeholder="Summer"
            error={form.formState.errors.title}
            {...form.register("title")}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton
            type="submit"
            unavailable={unavailable}
            disabled={create.isPending}
          >
            {create.isPending ? <Spinner /> : null}
            Create Collection
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Why kobai turned the creation back, in words a Merchant can act on.
 *
 * Exhaustive over `CollectionRefusal`, and the `never` at the bottom is what keeps it so: a
 * reason added to that family in Core has no arm here and reddens this build in the same commit
 * (ADR-0063). The family is the smallest on the surface, and every arm below is honest about
 * that — a creation cannot be not-found, so it reports kobai's own prose rather than a sentence
 * written here for a case nobody has seen.
 */
function whyNotCreated(thrown: unknown): string {
  const fallback = "The Collection could not be created.";
  const reason = collectionReasonOf(thrown);

  switch (reason) {
    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
      return problemOf(thrown, fallback);

    case "collection-not-found":
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
