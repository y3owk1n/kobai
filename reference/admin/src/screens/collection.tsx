import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayersIcon } from "lucide-react";
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
import { collectionReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";

/**
 * One Collection: what it is called, what is in it, and the way to remove it (#256).
 *
 * **Which Products are in it is a link rather than a list on this screen**, and that is a
 * decision rather than a gap. The Products screen already pages, already narrows by
 * `?collection=`, and already puts its cursor in the address; a second paged list here would be
 * a second cursor in an address that already locates a Collection, and the two would fight over
 * it. So this screen owns the record and the Products screen owns the Products.
 *
 * `metadata` is deliberately never sent. `PATCH /admin/collections/{id}` **replaces** it rather
 * than merging (ADR-0062), so a form submitting an empty object would silently discard whatever
 * a Project stashed there — and leaving the field out is what "leave it alone" means.
 */
const COLLECTION = "collection";

export function CollectionScreen() {
  const client = useKobaiClient();
  const id = useRouteId();

  const collection = useQuery({
    queryKey: [COLLECTION, id],
    queryFn: async () =>
      orThrow(await client.GET("/admin/collections/{id}", { params: { path: { id } } })),
  });

  // The breadcrumb otherwise reads as the identifier out of the URL, which is the one thing on
  // this screen a Merchant cannot use to tell one Collection from another.
  useCrumbTitle(collection.data?.title);

  if (collection.isPending) return <CollectionLoading />;

  if (collection.isError) {
    return collectionReasonOf(collection.error) === "collection-not-found" ? (
      <NoSuchCollection />
    ) : (
      <Problem
        title="That Collection could not be read."
        problem={problemOf(collection.error, "kobai did not answer.")}
      />
    );
  }

  return (
    <div className="grid gap-6">
      {/* An `h2`: the frame renders the page's `h1` from the route, so this is the heading
          under it rather than a second first-level one. */}
      <h2 className="font-medium text-xl">{collection.data.title}</h2>

      <CollectionIdentity id={id} title={collection.data.title} />
    </div>
  );
}

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * There is no uniqueness rule to mirror: a Collection's title is deliberately not unique, so
 * `min(1)` is the whole of what this field can be wrong about.
 */
const CollectionForm = z.object({
  title: z
    .string()
    .min(1, "A Collection is named, and the name is what a storefront shows."),
});

type CollectionValues = z.infer<typeof CollectionForm>;

/** What the Collection is called, the way to its Products, and the way to delete it. */
function CollectionIdentity({
  id,
  title,
}: {
  readonly id: string;
  readonly title: string;
}) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const navigate = useNavigate();
  const unavailable = useUnavailable(PERMISSIONS.catalogWrite, "change the catalog");

  const form = useForm<CollectionValues>({
    resolver: zodResolver(CollectionForm),
    // `values` rather than `defaultValues`, so a change that landed leaves the form showing
    // what kobai now holds rather than what was typed at it.
    values: { title },
  });

  const save = useMutation({
    mutationFn: async (values: CollectionValues) =>
      orThrow(
        await client.PATCH("/admin/collections/{id}", {
          params: { path: { id } },
          body: { title: values.title },
        }),
      ),
    // Re-read rather than patched in place, like every write in this Admin (ADR-0063). Only
    // this Collection's key: nothing here caches fresh, so the list behind this screen re-reads
    // when it is next mounted.
    onSuccess: () => void queries.invalidateQueries({ queryKey: [COLLECTION, id] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Collection</CardTitle>
        <CardDescription>
          A name, and the Products that carry it. Which Products those are is set on each
          Product — open one and it has a Collections field.
        </CardDescription>
        <CardAction>
          <ConfirmDelete
            trigger="Delete Collection"
            title="Delete this Collection?"
            // The sentence a Merchant most needs before pressing this, and it is the one thing
            // about a Collection that is genuinely surprising next to the rest of the catalog:
            // every other delete here refuses rather than cascading (ADR-0059), and this one
            // neither refuses nor cascades because what it removes is a label (story 17).
            description="The Products in it are left exactly where they are — still in the catalog, still on sale, and merely no longer in this Collection. Nothing is deleted but the grouping itself."
            unavailable={unavailable}
            onDelete={async () =>
              orThrow(
                await client.DELETE("/admin/collections/{id}", {
                  params: { path: { id } },
                }),
              )
            }
            // Away from an address that no longer resolves. The list behind it re-reads on
            // arrival — nothing in this cache is ever fresh — so there is no key to invalidate
            // and no chance of invalidating the wrong one from here.
            onDeleted={() => void navigate("/collections", { replace: true })}
            problemOf={whyNotDeleted}
          />
        </CardAction>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The Collection was not changed."
          />
          <FormField
            id="collection-title"
            label="Title"
            error={form.formState.errors.title}
            {...form.register("title")}
          />
          <div>
            {/* The one navigation this screen owes: what is in a Collection is the Products
                list narrowed to it, which pages and puts its cursor in the address. */}
            <LinkButton to={`/products?collection=${id}`} variant="outline" size="sm">
              See its Products
            </LinkButton>
          </div>
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save Collection
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/** The Collection, before it is there. */
function CollectionLoading() {
  return (
    <div className="grid gap-6" role="status" aria-label="Reading the Collection">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * An address naming a Collection this Store does not have.
 *
 * Its own screen rather than a red box, because it is the one refusal here a Merchant can act on
 * and the action is "go back to the list" — a Collection somebody deleted, or a link kept too
 * long.
 */
function NoSuchCollection() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LayersIcon />
        </EmptyMedia>
        <EmptyTitle>No such Collection</EmptyTitle>
        <EmptyDescription>
          This Store has no Collection at that address. It may have been deleted since the
          link was made — which leaves the Products that were in it exactly where they
          were.
        </EmptyDescription>
      </EmptyHeader>
      <LinkButton to="/collections">Go to Collections</LinkButton>
    </Empty>
  );
}

/** Why kobai refused a **change** to this Collection. */
function whyNotChanged(thrown: unknown): string {
  const fallback = "kobai would not make that change.";
  const reason = collectionReasonOf(thrown);

  switch (reason) {
    case "collection-not-found":
      return "It is no longer there — somebody else deleted this Collection, or this page has been open a while. The Products that were in it are unaffected.";

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
 * There is one reason it can be, and no rule anywhere that would add a second: a Collection full
 * of Products deletes as cleanly as an empty one. The delete control is still offered and the
 * attempt is still made — nothing here predicts an answer, which is `ConfirmDelete`'s whole
 * bargain.
 */
function whyNotDeleted(thrown: unknown): string {
  const fallback = "The Collection was not deleted.";
  const reason = collectionReasonOf(thrown);

  switch (reason) {
    case "collection-not-found":
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
