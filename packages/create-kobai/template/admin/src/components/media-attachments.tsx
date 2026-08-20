import { zodResolver } from "@hookform/resolvers/zod";
import type { Media } from "@kobai/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { ListboxField } from "@/components/listbox-field";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { orThrow } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The images a Product or a Variant shows, in the order a Merchant sets (#255).
 *
 * **One form over the whole list, because kobai takes the whole list.** `media` on
 * `PATCH /admin/products/{id}` and on `PATCH /admin/variants/{id}` is what the subject's images
 * should now *be*, in the order they should be shown in — so attaching, reordering and detaching
 * are one request, and this is a list a Merchant edits rather than three controls. That is the
 * Options card's shape one noun along, and it is deliberately the same shape: a Merchant who has
 * learned one has learned the other.
 *
 * **One component because there are two of it on the Product screen**, and there is a Variant
 * card per Variant — so it is already the third and fourth rendering by the time a Product has
 * two sizes. `listbox-field.tsx`'s lesson is why that is a component rather than a copy (#245).
 *
 * **Detaching is not deleting, and the screen says so where the control is.** A Media left out
 * of the list is detached; the asset stays in this Store's Media and may still be showing
 * somewhere else, and nothing in kobai ever deletes one (ADR-0082). A Merchant who thinks Remove
 * means *destroy* will not use it, and one who thinks it means detach and is wrong has lost a
 * photograph — so the sentence is in the card rather than in a release note.
 *
 * **Up, Down and Remove are plain `Button`s rather than `ActionButton`s**, exactly as the
 * Options card's are: they rearrange the form and call kobai nothing, so there is no permission
 * to explain. The one control that writes is the submit, and that is where `unavailable` goes.
 */
export function MediaAttachments({
  idPrefix,
  subject,
  attached,
  unavailable,
  attach,
  onAttached,
  problemOf,
}: {
  /** Unique to the **document**: two of these on one screen would otherwise share label ids. */
  readonly idPrefix: string;
  /** What this list belongs to, in a sentence — `this Product`, `this Variant`. */
  readonly subject: string;
  /** What kobai says is attached now, in kobai's order. */
  readonly attached: readonly Media[];
  /** Why this Merchant may not change the catalog, or `null` when they may. */
  readonly unavailable: string | null;
  /**
   * Sends the whole list. The caller owns which route that is.
   *
   * The array is deliberately not `readonly`: it is handed straight to `@kobai/client` as a
   * request body, and the generated types spell one as mutable.
   */
  readonly attach: (media: { id: string }[]) => Promise<unknown>;
  /** Re-read whatever the caller reads, exactly as every other write here does (ADR-0063). */
  readonly onAttached: () => void;
  /**
   * What to say when kobai refused, in the caller's own words.
   *
   * The caller's rather than this component's, exactly as `ConfirmDelete`'s is: narrowing a
   * closed refusal family is what reddens the Admin when Core adds a reason (ADR-0063), and the
   * screen that owns the family is where that `switch` lives. A copy here would be a second one
   * to keep exhaustive.
   */
  readonly problemOf: (thrown: unknown) => string;
}) {
  const library = useMediaLibrary();

  const form = useForm({
    resolver: zodResolver(AttachmentsForm),
    // Keyed by what kobai holds, so a save that landed leaves the rows showing what the subject
    // now shows rather than what was arranged here.
    values: { media: attached.map((one) => ({ mediaId: one.id })), adding: "" },
  });
  const rows = useFieldArray({ control: form.control, name: "media" });

  const save = useMutation({
    mutationFn: async (values: AttachmentValues) =>
      attach(values.media.map((one) => ({ id: one.mediaId }))),
    onSuccess: onAttached,
  });

  // Every Media this screen knows anything about: what is attached, and what the library
  // answered. A row appended a moment ago is in the second and not the first.
  const known = new Map<string, Media>(
    [...attached, ...(library.data?.media ?? [])].map((one) => [one.id, one]),
  );
  const alreadyOn = new Set(rows.fields.map((row) => row.mediaId));
  const offered = (library.data?.media ?? [])
    .filter((one) => !alreadyOn.has(one.id))
    .map((one) => ({ value: one.id, label: labelFor(one) }));

  const chosen = form.watch("adding");

  return (
    <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
      <div className="grid gap-4">
        <Problem
          problem={save.isError ? problemOf(save.error) : null}
          title="The images were not changed."
        />

        {rows.fields.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing is attached, so a storefront has no picture for {subject}.
          </p>
        ) : null}

        {rows.fields.map((row, index) => {
          const one = known.get(row.mediaId);
          return (
            <div
              key={row.id}
              className="grid items-center gap-2 sm:grid-cols-[auto_1fr_auto]"
            >
              {/* The alt text a Merchant wrote, and the empty string where they have not —
                  which is what a screen reader is told about an image that is decoration.
                  Inventing prose here would announce a filename. The address is rendered
                  exactly as kobai answered it, absolute or root-relative, because building one
                  out of a key here would be a second answer to a question the API answers. */}
              {one === undefined ? null : (
                <img
                  src={one.url}
                  alt={one.alt ?? ""}
                  className="h-12 w-12 rounded border object-cover"
                />
              )}
              <div className="text-sm">
                <div className="font-medium">{one?.filename ?? row.mediaId}</div>
                <div className="text-muted-foreground text-xs">
                  {index === 0 ? "Leads" : `Position ${index + 1}`}
                  {one?.alt === null || one?.alt === undefined
                    ? " — no alt text"
                    : ` — ${one.alt}`}
                </div>
              </div>
              <div className="flex gap-2">
                {/* `disabled` rather than `aria-disabled` for the two that run out of list, on
                    `Pager`'s reason: there is no explanation to host on one. Each says which row
                    it is for in an `sr-only` span rather than in an `aria-label`, because four
                    buttons all announcing "Up" tell a screen reader nothing about which. */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => rows.move(index, index - 1)}
                >
                  Up<span className="sr-only"> — image {index + 1}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index === rows.fields.length - 1}
                  onClick={() => rows.move(index, index + 1)}
                >
                  Down<span className="sr-only"> — image {index + 1}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => rows.remove(index)}
                >
                  Remove<span className="sr-only"> — image {index + 1}</span>
                </Button>
              </div>
            </div>
          );
        })}

        <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
          {/* `ListboxField` rather than a `Select` composed here: it is a picker over a set kobai
              names, and a third hand-composed one gets to reintroduce every defect #239 found
              (#245). The list is read from kobai for the same reason the Fulfilment Strategy
              picker's is — what Media this Store has is not something the Admin can know. */}
          <ListboxField
            id={`${idPrefix}-add`}
            control={form.control}
            name="adding"
            label="An image to attach"
            options={offered}
            placeholder={
              library.isPending
                ? "Reading this Store's Media…"
                : offered.length === 0
                  ? "Nothing left to attach"
                  : "Choose an image"
            }
            disabled={library.isError || offered.length === 0}
            description={
              library.isError
                ? "This Store's Media could not be read, so there is nothing to choose from. Reload the page."
                : "Upload images in the Media section first — this picker offers the most recent hundred."
            }
          />
          <Button
            type="button"
            variant="outline"
            // Dead only while there is nothing chosen, which is `Pager`'s judgement rather than
            // `aria-disabled`'s: the field beside it is the explanation.
            disabled={chosen === ""}
            onClick={() => {
              if (chosen === "") return;
              rows.append({ mediaId: chosen });
              form.setValue("adding", "");
            }}
          >
            Attach
          </Button>
        </div>

        <div>
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save images
          </ActionButton>
        </div>
      </div>
    </form>
  );
}

/**
 * The shape of a list of attachments, and only the shape (ADR-0063).
 *
 * `mediaId` rather than `id`, deliberately: `useFieldArray` writes a key of its own onto each
 * field object and that key is called `id`, so an image's real identifier under that name would
 * be the one thing this list cannot afford to lose. That is the Options card's trap, and it is
 * the same trap here.
 *
 * `adding` is the picker's own value and is submitted with the rest and ignored — a field of the
 * form rather than a `useState` beside it, because a listbox cannot be `register`ed and the form
 * is what owns a value in this Admin.
 */
const AttachmentsForm = z.object({
  media: z.array(z.object({ mediaId: z.string().min(1) })),
  adding: z.string(),
});

type AttachmentValues = z.output<typeof AttachmentsForm>;

/** How a Merchant recognises one of their own images in a list of them. */
function labelFor(one: Media): string {
  return one.alt === null ? one.filename : `${one.filename} — ${one.alt}`;
}

/**
 * This Store's Media, for the picker to offer.
 *
 * **The most recent hundred**, which is `MAX_PAGE_LIMIT` and the most one request may ask for
 * (ADR-0064). It is deliberately not paged here: a pager inside a card would put a second cursor
 * in an address that already locates a Product, and every one of the several of these on a
 * Product screen would fight over it. A Store with more than a hundred images and an old one to
 * attach is a gap this screen has, and it is written down rather than papered over.
 *
 * One query key for every copy of this component on the screen, so the several of them are one
 * request and one cache entry.
 */
function useMediaLibrary() {
  const client = useKobaiClient();

  return useQuery({
    queryKey: [MEDIA_LIBRARY],
    queryFn: async () =>
      orThrow(await client.GET("/admin/media", { params: { query: { limit: 100 } } })),
  });
}

const MEDIA_LIBRARY = "media-library";
