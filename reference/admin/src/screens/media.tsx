import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ImageIcon } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";
import { ActionButton } from "@/components/action-button";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The images this Store has, and the way to add one.
 *
 * **A section of its own rather than a card on the Product screen**, because that is what this
 * slice's Media *is*: a record that exists, is addressable, and came back from wherever the
 * Project put it. Attaching one to a Product or a Variant is the next slice, and until it
 * arrives a Media belongs to the Store rather than to anything on it.
 *
 * **Where the bytes come from is kobai's answer and never this screen's.** Each row renders
 * `media.url` exactly as it was handed back — absolute for a Store on a CDN, root-relative for
 * the storage kobai ships — so this screen works unchanged on a deployment that has substituted
 * its `MediaStorage`, which is the whole point of that interface. Building an address out of a
 * key here would be the second answer to a question the API already answers, and it would be
 * wrong on the first deployment that moved its bucket.
 *
 * It pages through the cursor with the cursor in the URL, like every other list here
 * (ADR-0064): images accumulate, and a screen showing the first page and no more is one on
 * which the older half of a catalog's imagery cannot be found.
 */
const MEDIA = "media";

export function MediaScreen() {
  const client = useKobaiClient();
  const after = usePageCursor();

  const page = useQuery({
    queryKey: [MEDIA, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/media", {
          params: { query: after === undefined ? {} : { after } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const media = page.data?.media;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Media
            {page.isFetching && !page.isPending ? <Spinner /> : null}
          </CardTitle>
          <CardDescription>
            Everything this Store has uploaded. Where the bytes live is this deployment's
            own — the storage kobai ships writes them to disk and serves them itself, and
            a Store on a bucket or a CDN answers its own addresses here instead.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Problem
            problem={
              page.isError ? problemOf(page.error, "The Media could not be read.") : null
            }
          />

          {page.isPending ? <MediaLoading /> : null}

          {media !== undefined && media.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ImageIcon />
                </EmptyMedia>
                <EmptyTitle>No Media yet</EmptyTitle>
                <EmptyDescription>
                  A storefront has nothing to show until this Store has some. Add the
                  first below.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {media !== undefined && media.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-0">
                    <span className="sr-only">Preview</span>
                  </TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Alt text</TableHead>
                  <TableHead>Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {media.map((one) => (
                  <TableRow key={one.id}>
                    <TableCell>
                      {/* The alt text a Merchant wrote, and the empty string where they have
                          not — which is what a screen reader is told about an image that is
                          decoration. Inventing prose here would announce a filename. */}
                      <img
                        src={one.url}
                        alt={one.alt ?? ""}
                        className="h-10 w-10 rounded border object-cover"
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {one.filename}
                      <div className="text-muted-foreground text-xs">
                        {one.contentType}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-64">
                      {one.alt ?? (
                        <span className="text-muted-foreground">
                          none — a Shopper who cannot see it is told nothing
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {/* `null` where kobai could not read the format's header, which is a
                          different thing from an image with no size. */}
                      {one.width === null || one.height === null
                        ? "unknown"
                        : `${one.width}×${one.height}`}
                      <div>{Math.ceil(one.byteSize / 1024)} kB</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <Pager nextCursor={page.data?.nextCursor} label="Media" />
        </CardContent>
      </Card>

      <UploadMedia />
    </div>
  );
}

/** A page of Media, before there is one. */
function MediaLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the Media">
      {["first", "second"].map((row) => (
        <Skeleton key={row} className="h-12 w-full" />
      ))}
    </div>
  );
}

/**
 * The upload form — **the one place in this Admin that is not a JSON request**.
 *
 * It is `react-hook-form`'s one absentee, and deliberately: a file input's value is a
 * `FileList` the browser owns and will not let anything set, so `reset()` cannot clear one and
 * the "controlled value" the rest of these forms rely on does not exist. So the file is held in
 * state beside a `ref` used only to clear the input after a successful upload, and the schema
 * that would have checked "a file was chosen" is the submit button being unavailable until one
 * is — which is the same fact, expressed where a Merchant can see it.
 *
 * **Alt text is asked for at the moment the image arrives**, rather than left to a later edit,
 * because that is the moment somebody knows what the picture shows. It is optional all the same:
 * kobai records `null` for an image nobody has described, which is a different thing from an
 * image deliberately described as nothing.
 */
function UploadMedia() {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.catalogWrite, "upload Media");

  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async ({ chosen, describedAs }: { chosen: File; describedAs: string }) =>
      orThrow(
        await client.POST("/admin/media", {
          // The generated types spell a binary part as a `string`, which is what OpenAPI's
          // `format: binary` becomes — so the file goes through as the field it is and the
          // serializer below is what actually builds the request. `openapi-fetch` hands a
          // `FormData` on untouched and leaves the boundary to the browser, which is the only
          // party that can generate one.
          body: { file: chosen as unknown as string, alt: describedAs },
          bodySerializer: (body) => {
            const form = new FormData();
            form.set("file", body.file as unknown as File);
            if (body.alt !== undefined && body.alt !== "") form.set("alt", body.alt);
            return form;
          },
        }),
      ),
    onSuccess: () => {
      setFile(null);
      setAlt("");
      // The one thing a `ref` is for here: a file input's value is the browser's, and clearing
      // it is the only way the field stops naming a file that has already been uploaded.
      if (input.current) input.current.value = "";
    },
    onSettled: () => queries.invalidateQueries({ queryKey: [MEDIA] }),
  });

  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Media</CardTitle>
        <CardDescription>
          kobai stores exactly what it is given — it does not resize, convert or make
          thumbnails, so upload the size a storefront should serve.
        </CardDescription>
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (file) upload.mutate({ chosen: file, describedAs: alt });
        }}
      >
        <CardContent className="grid gap-4">
          <Problem
            title="The image was not uploaded."
            problem={
              upload.isError
                ? problemOf(upload.error, "kobai turned the request back.")
                : null
            }
          />
          <Field>
            <FieldLabel htmlFor="upload-media-file">File</FieldLabel>
            <Input
              id="upload-media-file"
              type="file"
              accept="image/*"
              ref={input}
              onChange={chosen}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="upload-media-alt">Alt text</FieldLabel>
            <Input
              id="upload-media-alt"
              placeholder="A blue A2 poster on a white wall"
              value={alt}
              onChange={(event) => setAlt(event.target.value)}
            />
            <FieldDescription>
              What the image shows, for a Shopper who cannot see it. Optional — left
              blank, kobai records that nobody has described it yet.
            </FieldDescription>
          </Field>
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton
            type="submit"
            unavailable={unavailable}
            // Dead only while there is nothing to send or a send is in flight, which is
            // `Pager`'s judgement rather than `aria-disabled`'s: there is no explanation to
            // host on it, because the field above it is the explanation.
            disabled={file === null || upload.isPending}
          >
            {upload.isPending ? <Spinner /> : null}
            Upload
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}
