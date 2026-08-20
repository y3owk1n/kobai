import type { OpenApiDescription } from "@kobai/client";
import { useQuery } from "@tanstack/react-query";
import { TerminalIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Problem } from "@/components/problem";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type DeclaredResponse,
  enumOf,
  flattenSchema,
  groupOperations,
  isRefusal,
  type Operation,
  operationsIn,
  operationsMatching,
  parametersOf,
  propertiesOf,
  requestBodyOf,
  responsesOf,
  securitySchemesOf,
  stringAt,
  typeNameOf,
  typesOf,
} from "@/lib/description";
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/** This deployment's own description, which is one route's answer and nothing else's. */
const DESCRIPTION = "openapi";

/**
 * The search parameter holding the operation a Developer is reading.
 *
 * **The operation lives in the address**, so a refresh, the back button and a re-sign-in all
 * land back on it and it can be sent to a colleague (ADR-0081). It is spelled the way a request
 * line is — `GET /admin/products` — rather than as an opaque token, because an OpenAPI document
 * promises no `operationId` and kobai's carries none, and because a link a colleague receives
 * should say what it opens. #269 puts the parameters and the body in this same search.
 */
const OPERATION = "operation";

/**
 * How deep a schema is drawn before it stops.
 *
 * A backstop rather than a budget: a component already on the path is reported as such and not
 * expanded again, which is what actually terminates kobai's schemas. This catches a document
 * that nests deeply without ever repeating a component — nothing kobai serves does, and a
 * screen that hung on one would be worse than a screen that stopped.
 */
const DEEPEST = 5;

/** Which operation the address is asking for, or `null` where it asks for none. */
function useChosenOperation(): string | null {
  return useSearchParams()[0].get(OPERATION);
}

/** The address one operation is read at, which is what every entry in the list links to. */
function addressOf(operation: Operation): string {
  return `?${new URLSearchParams({ [OPERATION]: operation.key }).toString()}`;
}

/**
 * Every operation this deployment serves, read from the deployment (#268, ADR-0080).
 *
 * **It browses and sends nothing.** Composing a request, choosing a credential and sending it
 * is #269; what this screen is for is the half a Developer has no other way to get at — which
 * routes this build serves, what each takes, and every refusal each can make.
 *
 * **The description is fetched and could not have been bundled.** `@kobai/client` is types and
 * TypeScript erases them, so the Admin's bundle holds no description at all; and
 * `@kobai/core/openapi.json` is a package's build artifact rather than this server's answer,
 * besides being banned in this tree outright. ADR-0080 is the whole argument, and this screen
 * is the reason that route exists.
 *
 * Read once and never invalidated: the surface a process serves is decided by the build it is
 * running, so a restart is a new page load. `staleTime` says so rather than leaving it to look
 * like an oversight, exactly as the Deployment screen does.
 *
 * **One read, and it is the screen rather than a card's content** — which is why the Deployment
 * screen's local `ReadCard` is not reached for here and nothing has been extracted from it.
 * That component is a `Card` whose whole body is one query's three states; what is in flight or
 * refused here is the operation list, the search box and the panel beside them, so the states
 * are rendered once at the root. A second card-shaped read is what would make it two.
 */
export function Playground() {
  const client = useKobaiClient();
  const asked = useChosenOperation();

  const description = useQuery({
    queryKey: [DESCRIPTION],
    queryFn: async () => orThrow(await client.GET("/admin/openapi.json")),
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (description.isPending) {
    return (
      <div className="grid gap-6" role="status" aria-label="Reading the description">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (description.isError) {
    return (
      <Problem
        title="This deployment's description could not be read."
        problem={problemOf(description.error, "kobai did not answer.")}
      />
    );
  }

  const operations = operationsIn(description.data);
  const chosen = operations.find((operation) => operation.key === asked);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <TheOperations operations={operations} />
      {chosen === undefined ? (
        <NothingChosen asked={asked} />
      ) : (
        <TheOperation document={description.data} operation={chosen} />
      )}
    </div>
  );
}

/**
 * The operations, grouped by the resource they act on and headed by the path they share.
 *
 * Every entry is a **link**, for the reason the list cursor and every filter in this Admin are
 * in the address (ADR-0064): an operation a Developer is reading is something to send a
 * colleague, and a refresh has to land back on it.
 *
 * **What is typed into the search box is not in the address, and that is the one deliberate
 * departure from the rule above.** A filter on a list here is a *link*, because each value is a
 * page of a list kobai issued and a Merchant may want to send one. This box narrows a document
 * already in the browser's memory, on every keystroke — nothing round-trips, nothing is a page
 * of anything, and putting it in the address would put a history entry per character between a
 * Developer and the back button they use to leave the operation they just read. What survives a
 * reload is the operation, which is what a colleague is sent.
 */
function TheOperations({ operations }: { readonly operations: readonly Operation[] }) {
  const search = useId();
  const asked = useChosenOperation();
  const [typed, setTyped] = useState("");
  const matching = operationsMatching(operations, typed);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {/* A heading, on a card that is a list rather than a section of one record — which
              is where this Admin usually has none. This screen is two panels standing beside
              each other, and the groups inside this one are `h3`s: with no `h2` over them the
              outline would jump from the frame's `h1`, and somebody navigating by heading
              would have no way to get back to the list from an operation. */}
          <h2>Operations</h2>
        </CardTitle>
        <CardDescription>
          Every operation this deployment serves, read from the running server rather than
          from a package — so it is this build's surface and not the one some checkout was
          built with.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={search}>Search the operations</Label>
          <Input
            id={search}
            type="search"
            value={typed}
            placeholder="A path, a method or what an operation does"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        <nav aria-label="Every operation this deployment serves" className="grid gap-4">
          {groupOperations(matching).map((group) => (
            <div key={group.prefix} className="grid gap-1">
              <h3 className="font-medium text-muted-foreground text-xs">
                <code>{group.prefix}</code>
              </h3>
              <ul className="grid gap-1">
                {group.operations.map((operation) => (
                  <li key={operation.key}>
                    <Link
                      to={{ search: addressOf(operation) }}
                      aria-current={operation.key === asked ? "page" : undefined}
                      className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium"
                    >
                      <span className="font-medium text-xs">{operation.method}</span>{" "}
                      <code>{operation.path}</code>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* A narrowing that matched nothing is a different thing from a document that has not
            arrived, and a screen that showed an empty panel for both would say neither. */}
        {matching.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No operation matches what you typed.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * One operation, whole: what it takes, what it answers, and every refusal it can make.
 *
 * **Nothing here is written down in this Admin.** Every word on this panel is the deployment's
 * own description of itself, which is the point of ADR-0080 — a screen holding its own copy of
 * what a route takes would be wrong the first time Core changed one, and permanently wrong in a
 * Project, whose Admin is vendored source `kobai-upgrade` never reaches.
 *
 * **It offers nothing to send**, and #269 is what changes that. What this panel is for is the
 * half of the API a Developer cannot read anywhere else without leaving the browser.
 *
 * **Every operation is offered, the two session ones included**, and that is a judgement worth
 * knowing about. ADR-0081 says those two are "not offered", and its whole argument is about
 * *sending* — Core would obey them, signing the Merchant out of the tab they are standing in.
 * Nothing here sends, so reading what they take costs nothing and is useful; #269 is where the
 * exclusion bites, and it is the ticket that has to decide whether an operation with no send
 * control is still worth listing. ADR-0081 is amended in the same commit rather than left
 * saying something this tree does not do, which is the rule ADR-0080 made about exactly this.
 */
function TheOperation({
  document,
  operation,
}: {
  readonly document: OpenApiDescription;
  readonly operation: Operation;
}) {
  const parameters = parametersOf(operation);
  const body = requestBodyOf(operation);
  const responses = responsesOf(operation);
  const answers = responses.filter((response) => !isRefusal(response.status));
  const refusals = responses.filter((response) => isRefusal(response.status));
  const credentials = securitySchemesOf(document, operation);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            {/* The frame's `h1` names the section, so the record this screen is showing is an
                `h2` and the cards under it are `h3`s — the Product screen's outline one noun
                along, because these cards are sections of one operation rather than a list of
                records. */}
            <h2 className="flex flex-wrap items-baseline gap-2">
              <Badge variant="secondary">{operation.method}</Badge>{" "}
              <code className="text-base">{operation.path}</code>
            </h2>
          </CardTitle>
          {operation.summary === undefined ? null : (
            <CardDescription>{operation.summary}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="grid gap-4">
          {operation.description === undefined ? null : (
            <p className="text-sm">{operation.description}</p>
          )}

          <div className="grid gap-1">
            <h3 className="font-medium text-sm">Sent with</h3>
            {credentials.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No credential — this operation is open.
              </p>
            ) : (
              <ul className="grid gap-2">
                {credentials.map((credential) => (
                  <li key={credential.name} className="grid gap-1">
                    <code className="text-sm">{credential.name}</code>
                    {credential.description === undefined ? null : (
                      <p className="text-muted-foreground text-sm">
                        {credential.description}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Detail
        title="Parameters"
        description="What goes in the path and in the query string, exactly as this deployment declares them."
      >
        {parameters.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            This operation takes no parameters.
          </p>
        ) : (
          <ul className="grid gap-4">
            {parameters.map((parameter) => (
              <li key={`${parameter.in} ${parameter.name}`} className="grid gap-1">
                <p className="flex flex-wrap items-baseline gap-2">
                  <code className="font-medium text-sm">{parameter.name}</code>{" "}
                  <span className="text-muted-foreground text-xs">
                    in the {parameter.in}
                  </span>
                  {parameter.required ? (
                    <span className="text-muted-foreground text-xs">required</span>
                  ) : null}
                </p>
                {parameter.description === undefined ? null : (
                  <p className="text-sm">{parameter.description}</p>
                )}
                <SchemaBlock document={document} schema={parameter.schema} />
              </li>
            ))}
          </ul>
        )}
      </Detail>

      <Detail
        title="Request body"
        description="What to send, field by field — which is what a Developer needs before they send anything at all."
      >
        {body === undefined ? (
          <p className="text-muted-foreground text-sm">This operation takes no body.</p>
        ) : (
          <div className="grid gap-2">
            <code className="text-muted-foreground text-xs">{body.mediaType}</code>
            <SchemaBlock document={document} schema={body.schema} />
          </div>
        )}
      </Detail>

      <Detail
        title="Answers"
        description="What comes back when the request is not refused, and the shape of each."
      >
        <Responses document={document} responses={answers} />
      </Detail>

      <Detail
        title="Refusals"
        description="Every way this operation can turn a request back, and what each of them means. A refusal's reason is the word to branch on — kobai's prose is for a person, and the reason is for the storefront."
      >
        <Responses document={document} responses={refusals} />
      </Detail>
    </div>
  );
}

/**
 * The responses of one kind, each with its status, what it means and the body it carries.
 *
 * One component for the answers and the refusals, because a refusal *is* a response and the
 * only difference is the status: telling them apart on the screen is what makes the refusals
 * findable, and rendering them two different ways would be this Admin claiming to know
 * something about them the description does not say. The `reason` words a refusal family
 * declares come out of that family's own schema, through {@link SchemaBlock}, so a reason added
 * in Core arrives here without an edit.
 */
function Responses({
  document,
  responses,
}: {
  readonly document: OpenApiDescription;
  readonly responses: readonly DeclaredResponse[];
}) {
  if (responses.length === 0) {
    return <p className="text-muted-foreground text-sm">This operation declares none.</p>;
  }

  return (
    <ul className="grid gap-4">
      {responses.map((response) => (
        <li key={response.status} className="grid gap-1">
          <p>
            <code className="font-medium text-sm">{response.status}</code>
          </p>
          {response.description === undefined ? null : (
            <p className="text-sm">{response.description}</p>
          )}
          {response.body === undefined ? (
            <p className="text-muted-foreground text-xs">No body.</p>
          ) : (
            <SchemaBlock document={document} schema={response.body.schema} />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * One schema, drawn as far as it goes: what it is, what it says about itself, and its fields.
 *
 * **A tree rather than a rendered example**, because what a Developer is reading here is which
 * fields exist, which are required and what each is for — and an example would be this Admin
 * inventing values kobai never promised.
 *
 * Two things stop it. A component already expanded on the way down is named and not expanded
 * again, which is what terminates a recursive document rather than a depth limit guessing at
 * one; {@link DEEPEST} is the backstop behind that.
 */
function SchemaBlock({
  document,
  schema,
  seen = [],
  depth = 0,
}: {
  readonly document: OpenApiDescription;
  readonly schema: unknown;
  readonly seen?: readonly string[];
  readonly depth?: number;
}) {
  const flat = flattenSchema(document, schema);
  // An array says what it is on its own line — `array of Media` — and what hangs off it is what
  // it holds, so the fields below come from the item rather than from the array.
  const held = typesOf(flat.schema).includes("array")
    ? flattenSchema(document, flat.schema.items)
    : flat;

  const repeated = held.name !== undefined && seen.includes(held.name);
  const described =
    stringAt(flat.schema, "description") ?? stringAt(held.schema, "description");
  const values = enumOf(held.schema);
  const fields = propertiesOf(held.schema);
  const deeper = held.name === undefined ? seen : [...seen, held.name];

  return (
    <div className="grid gap-1">
      <p className="text-muted-foreground text-xs">
        <code>{typeNameOf(document, schema)}</code>
        {repeated ? " — described above" : null}
      </p>

      {described === undefined ? null : <p className="text-sm">{described}</p>}

      {values.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1">
          {values.map((value) => (
            <li key={value}>
              <Badge variant="outline">
                <code>{value}</code>
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {repeated || depth >= DEEPEST ? null : (
        <>
          {held.alternatives.length === 0 ? null : (
            <ul className="grid gap-2 border-border border-l pl-3">
              {held.alternatives.map((alternative) => (
                // Keyed on the alternative itself, because there is nothing else to key on: an
                // alternative is an anonymous shape, so two of them can share a type name, and
                // an index is a key that moves. Nothing changes this document under the screen.
                <li key={JSON.stringify(alternative)}>
                  <SchemaBlock
                    document={document}
                    schema={alternative}
                    seen={deeper}
                    depth={depth + 1}
                  />
                </li>
              ))}
            </ul>
          )}

          {fields.length === 0 ? null : (
            <ul className="grid gap-2 border-border border-l pl-3">
              {fields.map((field) => (
                <li key={field.name} className="grid gap-1">
                  <p className="flex flex-wrap items-baseline gap-2">
                    <code className="font-medium text-sm">{field.name}</code>
                    {field.required ? (
                      <span className="text-muted-foreground text-xs">required</span>
                    ) : null}
                  </p>
                  <SchemaBlock
                    document={document}
                    schema={field.schema}
                    seen={deeper}
                    depth={depth + 1}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One card of the operation panel, named by its own heading.
 *
 * A region rather than a plain card, and named by the heading rather than by a label of its
 * own: this screen is four cards deep on one operation, and a landmark per card is how somebody
 * navigating by region reaches the refusals without reading the request body first. The heading
 * names it, because a name that can disagree with the words on screen eventually does.
 */
function Detail({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  const heading = useId();

  return (
    <Card role="region" aria-labelledby={heading}>
      <CardHeader>
        <CardTitle>
          <h3 id={heading}>{title}</h3>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * The panel before an operation has been chosen — and after an address named one that is gone.
 *
 * **An address can name an operation this deployment does not serve**, which is not a contrived
 * state: a link a colleague sent was composed against the surface *they* are running, and a
 * Project upgrading Core is exactly when the two differ. Both obvious answers are worse than
 * saying so — a blank panel reads as a screen still loading, and quietly falling back to the
 * first operation would answer a question nobody asked. It is the rule `useListFilter` follows
 * for a filter naming a value kobai has never heard of, one noun along.
 */
function NothingChosen({ asked }: { readonly asked: string | null }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TerminalIcon />
        </EmptyMedia>
        <EmptyTitle>
          {asked === null ? "Choose an operation" : "No such operation"}
        </EmptyTitle>
        <EmptyDescription>
          {asked === null
            ? "Every route this deployment serves is on the left, with what it takes, what it answers and every refusal it can make."
            : `This deployment serves no operation called “${asked}”. It may have come from a link composed against another release of Core.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
