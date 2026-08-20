import type { KobaiClient, OpenApiDescription } from "@kobai/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { TerminalIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ActionButton } from "@/components/action-button";
import { LinkButton } from "@/components/link-button";
import { Problem } from "@/components/problem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { arm, isArmed } from "@/lib/arming";
import {
  type DeclaredResponse,
  enumOf,
  flattenSchema,
  groupOperations,
  isRefusal,
  type Operation,
  operationsIn,
  operationsMatching,
  type Parameter,
  parametersOf,
  propertiesOf,
  requestBodyOf,
  responsesOf,
  securitySchemesOf,
  seedBody,
  stringAt,
  typeNameOf,
  typesOf,
} from "@/lib/description";
import {
  type PlaygroundAnswer,
  type PlaygroundCredential,
  type PlaygroundRequest,
  sendPlaygroundRequest,
} from "@/lib/playground-request";
import { clearPreviewKey, heldPreviewKey } from "@/lib/preview-key";
import { isApiKeyRejected, orThrow, problemOf } from "@/lib/refusal";
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
 * The search parameter holding which credential the request carries.
 *
 * **In the address, and the *values* are not.** ADR-0081 asks that the choice survive a reload
 * while the pasted secret does not, and the address is where this Admin already keeps what a
 * refresh has to land back on. A colleague opening the link is therefore told which credential
 * reproduces the problem and is given none of it: the publishable key is this browser's own and
 * the secret one is theirs to paste, which is exactly the distinction the reload teaches.
 */
const CREDENTIAL = "credential";

/**
 * The search parameter holding the request body, exactly as it was typed.
 *
 * A body kobai would refuse goes in the address like any other, because it is the one worth
 * sending a colleague — *this is the call that reproduces it*. A **secret key** never does, and
 * that is not the same judgement: a secret key in an address is a secret key in a browser
 * history, a proxy log, and whatever the colleague it was sent to does next.
 */
const BODY = "body";

/** How the address names one parameter's value — `path.id`, `query.limit`. */
function keyOf(parameter: Parameter): string {
  return `${parameter.in}.${parameter.name}`;
}

/** Which credential a request carries. Three, and the screen is where it is chosen. */
type CredentialChoice = "session" | "publishable" | "secret";

/**
 * The three, in the order they are offered — safest ambient first, and the pasted one last.
 *
 * Each is a **link**, for the reason the chosen operation is in the address at all: the choice
 * is part of the call a colleague is sent, a refresh lands back on it, and the back button walks
 * between them. `components/list-filter.tsx` is the same bargain over a list and is deliberately
 * not reached for here — it prepends an "All" that this has no meaning for, and drops a cursor
 * this screen does not have.
 */
const CREDENTIALS: readonly {
  readonly value: CredentialChoice;
  readonly label: string;
  readonly note: string;
}[] = [
  {
    value: "session",
    label: "The Merchant's Session",
    note: "The cookie this tab already carries, with the Role you signed in on. The only credential the browser attaches by itself — every other choice is sent with it suppressed, so a request behaves exactly as it would from somewhere that never had one.",
  },
  {
    value: "publishable",
    label: "A publishable key",
    note: "The kobai_pk_… this Admin already mints and holds for the storefront price preview. It is what ships in a browser bundle, so this is what your storefront's own requests will get — including the refusals.",
  },
  {
    value: "secret",
    label: "A secret key",
    note: "A kobai_sk_… you paste, for the operations that take money. The Admin never mints one and never stores one: it is held in this screen's memory, is never written to the address or to browser storage, and is gone the moment you reload.",
  },
];

/**
 * The route the two unsendable operations sit on, written once and as a quoted literal.
 *
 * That is what puts them inside `tests/admin-uses-only-the-public-api.test.ts`'s reach: that
 * scan reads quoted kobai paths and holds each against the published description, so a session
 * route Core renamed would redden the build here rather than quietly grow a send control on the
 * one pair of operations that must never have one.
 */
const SESSION = "/admin/session";

/**
 * The two operations that are listed and cannot be sent, and what to say instead (ADR-0081).
 *
 * **The one exception to offering everything, and the difference is exact**: Core would not
 * refuse these, it would *obey* them, correctly. Every other operation on this surface has a
 * blast radius of one record; these two have a blast radius of the session doing the asking,
 * and no boundary inside a browser can fix that.
 *
 * They are still **listed** — that is #268's ruling, and this record was amended for it — and
 * they are still read here in full, because what `POST /admin/session` takes is one of the
 * things a Developer opens this screen for and reading it costs nobody their tab. What they get
 * is no send control **and a sentence saying why**, which follows the rule that a section is
 * hidden and an action is shown (ADR-0063): an operation that silently lacked a button would
 * teach a Developer nothing at all, and one that says this teaches the whole decision.
 */
const NOT_SENDABLE: Readonly<Record<string, string>> = {
  [`POST ${SESSION}`]:
    "Sending this would replace the session in the one cookie jar this origin has, so the Admin behind this screen would become whoever the body named.",
  [`DELETE ${SESSION}`]:
    "Sending this would sign you out of the tab you are standing in.",
};

/** What every operation in {@link NOT_SENDABLE} has in common, said once. */
const WHY_NOT_SENDABLE =
  "Every other operation this deployment serves is offered, including the ones your credential cannot perform — these two are the only ones kobai would obey rather than refuse.";

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

/**
 * Which credential the address is asking for, defaulting to the Merchant's own Session.
 *
 * An address naming a credential this Admin has never heard of falls back to the Session rather
 * than to nothing, which is the one fallback that cannot surprise: it is the credential the tab
 * already carries, and the arming rule below still stands over it.
 */
function useChosenCredential(): CredentialChoice {
  const asked = useSearchParams()[0].get(CREDENTIAL);
  return CREDENTIALS.find((one) => one.value === asked)?.value ?? "session";
}

/** The same search with some of it changed, which is what every edit on this screen is. */
function searchWith(
  params: URLSearchParams,
  values: Readonly<Record<string, string>>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(values)) next.set(key, value);
  return next;
}

/**
 * Reading and writing the composed request, which lives in the address (ADR-0081).
 *
 * **Written by replacing rather than by pushing**, which is the search box's argument one noun
 * along: a history entry per keystroke would put a hundred of them between a Developer and the
 * back button they leave an operation with. What the address is for here is a refresh, a
 * re-sign-in and a colleague — three readers, none of which walks it.
 *
 * **The writer takes every field rather than the one that changed**, and that is not tidiness.
 * `useSearchParams` hands its setter the params of the render it was created in — its
 * functional form included, which was tried — so a write built by *changing* the current
 * address is stale the moment a second edit lands before React has re-rendered. Filling a body
 * straight after typing a path parameter therefore wrote an address holding the body and no
 * parameter, and the browser case that keeps the composed request watched it happen. Writing
 * the fields the screen owns, all of them, every time, is what makes the address a mirror of
 * what is on screen rather than a running total of edits that may have been dropped.
 */
function useComposed(): [
  URLSearchParams,
  (values: Readonly<Record<string, string>>) => void,
] {
  const [params, setParams] = useSearchParams();

  return [
    params,
    (values) => {
      setParams(searchWith(params, values), { replace: true });
    },
  ];
}

/**
 * The address one operation is read at — that operation, and the credential carried over.
 *
 * Everything else is deliberately dropped. Parameters and a body belong to the operation they
 * were composed for, so carrying them across would put a Cart's identifier in a Product's
 * `{id}`; the credential is the one thing that is not the operation's at all — it is who the
 * Developer has decided to be, and it survives moving between them.
 */
function addressOf(operation: Operation, credential: CredentialChoice): string {
  return `?${new URLSearchParams({
    [OPERATION]: operation.key,
    [CREDENTIAL]: credential,
  }).toString()}`;
}

/**
 * Every operation this deployment serves, and a way to send one (#268, #269, ADR-0080).
 *
 * **It browses, and then it sends for real.** The list, what each operation takes and every
 * refusal it can make are the half a Developer has no other way to get at without leaving the
 * browser; the panel beside it composes a request out of that same document and sends it, on a
 * credential chosen on the screen. **There is no sandbox** — see {@link NotASandbox}, which
 * says so before anything can be sent, and `lib/playground-request.ts`, which is where the
 * sending and its one load-bearing line live.
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
  /**
   * The secret key a Developer pasted, held **in memory and nowhere else** (ADR-0081).
   *
   * Not `sessionStorage`, where the publishable key lives; not the address, where the rest of
   * the composed request lives; and gone the moment this screen unmounts or the tab reloads.
   * The rule ADR-0055 and #214 protect is that the Admin never *mints* and never *stores* a
   * secret key — not that no such value may exist in a tab a Developer typed one into. It is
   * held here rather than in the panel below so that reading a second operation does not throw
   * it away between two requests that both need it.
   */
  const [secret, setSecret] = useState("");

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
    <div className="grid gap-6">
      <NotASandbox />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <TheOperations operations={operations} />
        {chosen === undefined ? (
          <NothingChosen asked={asked} />
        ) : (
          <TheOperation
            key={chosen.key}
            document={description.data}
            operation={chosen}
            secret={secret}
            onSecret={setSecret}
          />
        )}
      </div>
    </div>
  );
}

/**
 * What this screen is, said before anything is sent rather than discovered by deleting a Product.
 *
 * **There is no sandbox and there will not be one** (ADR-0081): kobai is one Store per
 * deployment (ADR-0005), so a sandbox would be a second one, which is multi-tenancy smuggled in
 * through a developer tool. What stands between a Developer and a real deletion is not a test
 * mode but three narrower things — the credential is always explicit, a non-`GET` on the Session
 * must be armed, and the two session operations get no send control — and none of them is worth
 * anything to somebody who does not know the first sentence.
 *
 * It is above both panels rather than inside the one that sends, so it is on screen before an
 * operation has been chosen: the moment to learn this is not the moment the button appears.
 */
function NotASandbox() {
  return (
    <Alert>
      <AlertTitle>There is no sandbox. Every request here is real.</AlertTitle>
      <AlertDescription>
        This is the deployment you are signed in to, not a copy of it. A request sent from
        this screen is the same request a storefront would make: a deletion deletes, an
        Order is placed, and money moves.
      </AlertDescription>
    </Alert>
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
  const credential = useChosenCredential();
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
                      to={{ search: addressOf(operation, credential) }}
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
 * **Every operation can be sent, with two named exceptions** — see {@link NOT_SENDABLE}, which
 * is the whole of the list and carries its own argument. That includes operations the chosen
 * credential cannot perform: nothing here predicts a refusal, because hiding them would mean
 * this Admin holding a second copy of which routes need which key, which is the closed set
 * ADR-0067 exists to rule out. The refusal *is* the answer a Developer came for.
 *
 * **The parameters and the body are real form fields and nothing checks them.** A schema-driven
 * validator here would be a second implementation of a rule that lives in Core, in the tree
 * `kobai-upgrade` can never reach — and `InvalidRequest` is modelled and promised (ADR-0060),
 * so a refused body renders the real rule from the authority that owns it.
 */
function TheOperation({
  document,
  operation,
  secret,
  onSecret,
}: {
  readonly document: OpenApiDescription;
  readonly operation: Operation;
  /** The pasted secret key, which lives in the screen's memory and nowhere else. */
  readonly secret: string;
  readonly onSecret: (secret: string) => void;
}) {
  const parameters = parametersOf(operation);
  const body = requestBodyOf(operation);
  const responses = responsesOf(operation);
  const answers = responses.filter((response) => !isRefusal(response.status));
  const refusals = responses.filter((response) => isRefusal(response.status));
  const credentials = securitySchemesOf(document, operation);
  const [composed, write] = useComposed();

  // Seeded from the schema and **not written to the address**, so a link carrying no body of
  // its own seeds identically wherever it is opened. What goes in the address is what somebody
  // typed, which is the only part a colleague could not have derived from the operation.
  const seeded = body === undefined ? undefined : seedBody(document, body.schema);

  /**
   * What is in the fields — read from the address once, and held here while it is typed.
   *
   * **Two places rather than one, and the second is not an oversight.** The address is where
   * the composed request lives (ADR-0081): a refresh, a re-sign-in and a colleague all read it,
   * and every edit below writes to it. But an `<input>` whose value comes back through a
   * *navigation* is a keystroke behind itself — type faster than React can re-render and it
   * puts the previous value back under the caret, and characters are genuinely lost. That was
   * watched happening rather than guessed at: a browser case typing thirty-three characters
   * into a path parameter kept six of them, which is why it types rather than fills.
   *
   * So the address is written on every change and read on **mount**, and `TheOperation` is
   * keyed on the operation — a different operation is a different form, and a reload, the back
   * button and a colleague's link all arrive as a mount. Nothing else can change these two
   * values under the screen, because an edit here is the only thing that writes them.
   */
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries([
      ...parameters.map((parameter) => [
        keyOf(parameter),
        composed.get(keyOf(parameter)) ?? "",
      ]),
      ...(seeded === undefined ? [] : [[BODY, composed.get(BODY) ?? seeded]]),
    ]),
  );

  const edit = (key: string, value: string) => {
    const next = { ...typed, [key]: value };
    setTyped(next);
    write(next);
  };

  const valuesIn = (where: string): Record<string, string> =>
    Object.fromEntries(
      parameters
        .filter((parameter) => parameter.in === where)
        .map((parameter) => [parameter.name, typed[keyOf(parameter)] ?? ""]),
    );

  const request: Omit<PlaygroundRequest, "credential"> = {
    method: operation.method,
    path: operation.path,
    pathParameters: valuesIn("path"),
    queryParameters: valuesIn("query"),
    headerParameters: valuesIn("header"),
    body: seeded === undefined ? undefined : (typed[BODY] ?? seeded),
    mediaType: body?.mediaType,
  };

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
        description="What goes in the path and in the query string, exactly as this deployment declares them — as fields, because building a URL by hand is what this screen is for not doing."
      >
        {parameters.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            This operation takes no parameters.
          </p>
        ) : (
          <ul className="grid gap-6">
            {parameters.map((parameter) => (
              <li key={keyOf(parameter)}>
                <ParameterField
                  document={document}
                  parameter={parameter}
                  value={typed[keyOf(parameter)] ?? ""}
                  onChange={(value) => edit(keyOf(parameter), value)}
                />
              </li>
            ))}
          </ul>
        )}
      </Detail>

      <Detail
        title="Request body"
        description="What to send, field by field — and a box holding a body seeded from that schema, which nothing in this browser checks."
      >
        {body === undefined || seeded === undefined ? (
          <p className="text-muted-foreground text-sm">This operation takes no body.</p>
        ) : (
          <div className="grid gap-4">
            <TheBody
              mediaType={body.mediaType}
              value={typed[BODY] ?? seeded}
              onChange={(value) => edit(BODY, value)}
            />
            <SchemaBlock document={document} schema={body.schema} />
          </div>
        )}
      </Detail>

      <TheSend
        operation={operation}
        request={request}
        secret={secret}
        onSecret={onSecret}
      />

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

/**
 * One parameter, as a field: what it is called, what goes in it, and what it is for.
 *
 * The label is the parameter's own name and **nothing else**, so what a screen reader announces
 * for the control is the word the description uses and the word a Developer is looking for.
 * Where it goes, whether the operation insists on it and what it means are said underneath,
 * with the schema below that — none of which is this Admin's opinion about the route.
 *
 * Nothing validates it. A `{id}` left blank sends an empty path segment and kobai answers what
 * it answers, which is the whole arrangement this screen is built on.
 */
function ParameterField({
  document,
  parameter,
  value,
  onChange,
}: {
  readonly document: OpenApiDescription;
  readonly parameter: Parameter;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();

  return (
    <Field>
      <FieldLabel htmlFor={id}>
        <code className="font-medium text-sm">{parameter.name}</code>
      </FieldLabel>
      <Input
        id={id}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>
        in the {parameter.in}
        {parameter.required ? " · required" : null}
      </FieldDescription>
      {parameter.description === undefined ? null : (
        <FieldDescription>{parameter.description}</FieldDescription>
      )}
      <SchemaBlock document={document} schema={parameter.schema} />
    </Field>
  );
}

/**
 * The request body, as text — seeded from the schema and checked by nobody in this browser.
 *
 * **A box rather than a generated form** (ADR-0081). A JSON-Schema form renderer would be the
 * most bespoke thing in an Admin whose frame is deliberately conventional, and a second
 * implementation of a rule that lives in Core — which a Project could already have changed
 * through a replaced Step. What arrives instead is the real refusal from the authority that
 * owns the rule, and that refusal is the documentation.
 *
 * It is sent as whatever media type the description declares, rather than as JSON by
 * assumption: `POST /admin/media` takes `multipart/form-data`, and saying so is more honest
 * than sending something else under a content type it never claimed.
 */
function TheBody({
  mediaType,
  value,
  onChange,
}: {
  readonly mediaType: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();

  return (
    <Field>
      <FieldLabel htmlFor={id}>Request body</FieldLabel>
      <Textarea
        id={id}
        rows={12}
        value={value}
        spellCheck={false}
        className="font-mono text-xs"
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>
        Seeded from the schema below and sent as <code>{mediaType}</code>, byte for byte.
        Nothing here checks it: a body kobai would refuse is one of the things worth
        sending, and the refusal you meet is the rule that will actually apply.
      </FieldDescription>
    </Field>
  );
}

/**
 * Choosing a credential, arming where that is asked for, and sending it (ADR-0081).
 *
 * **The credential is chosen on the screen and never guessed**, which is the difference between
 * this and a tab with a cookie in it: a Developer is never wondering which credential the
 * browser attached, because anything but the Session is sent with the ambient one suppressed.
 * `lib/playground-request.ts` is where that happens and carries the argument in full.
 *
 * **Arming is an affordance and never a boundary.** It stands in front of a non-`GET` on the
 * *Session* — the credential nobody had to type, carrying the Role a Merchant actually works
 * with — and in front of nothing else, because reaching for a key is a deliberate act every
 * time and ceremony on the safe case is how a guard gets taken off the dangerous one. Core is
 * what enforces, and the sentence at the control says so.
 */
function TheSend({
  operation,
  request,
  secret,
  onSecret,
}: {
  readonly operation: Operation;
  readonly request: Omit<PlaygroundRequest, "credential">;
  readonly secret: string;
  readonly onSecret: (secret: string) => void;
}) {
  const client = useKobaiClient();
  const chosen = useChosenCredential();
  const [composed] = useComposed();
  const key = useId();
  // Mirrored into state rather than read on every render: `sessionStorage` is not something
  // React re-renders for, so arming would otherwise take effect on the next render that
  // happened for some other reason — the flicker `screens/api-keys.tsx` avoids the same way.
  const [armed, setArmed] = useState(isArmed);

  const send = useMutation({
    mutationFn: async (): Promise<PlaygroundAnswer> => {
      const credential = await credentialFor(chosen, secret, client);
      const answer = await sendPlaygroundRequest({ ...request, credential });
      // The key this browser holds has been revoked, or was minted against a database that has
      // since gone. Forgetting it is what makes the next send mint a fresh one rather than
      // presenting a dead credential for ever — the recovery the price preview already has,
      // which ADR-0081 says the Playground inherits because the two share one key. The
      // narrowing takes a refusal body, and `reason` is the only field of one it reads.
      if (chosen === "publishable" && isApiKeyRejected({ reason: answer.reason })) {
        clearPreviewKey();
      }
      return answer;
    },
  });

  const notSendable = NOT_SENDABLE[operation.key];
  const unarmed = needsArming(chosen, operation, armed);
  const unavailable = whyNotYet(chosen, operation, secret, armed);

  // The credential changes and everything else is carried over untouched, which is
  // `components/list-filter.tsx`'s rule one noun along: two things in one address that each
  // clear the other look exactly like two things that work, one click at a time.
  const searchFor = (credential: CredentialChoice): string =>
    `?${searchWith(composed, { [CREDENTIAL]: credential }).toString()}`;

  return (
    <Detail
      title="Send"
      description="A real request, on the credential you choose, against this deployment."
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <nav aria-label="Choose a credential" className="flex flex-wrap gap-2">
            {CREDENTIALS.map((one) => (
              <LinkButton
                key={one.value}
                to={{ search: searchFor(one.value) }}
                size="sm"
                variant={one.value === chosen ? "default" : "outline"}
                aria-current={one.value === chosen ? "page" : undefined}
              >
                {one.label}
              </LinkButton>
            ))}
          </nav>
          <p className="text-muted-foreground text-sm">{noteOn(chosen)}</p>
        </div>

        {chosen === "secret" ? (
          <Field>
            <FieldLabel htmlFor={key}>Secret key</FieldLabel>
            <Input
              id={key}
              value={secret}
              placeholder="kobai_sk_…"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onSecret(event.target.value)}
            />
            <FieldDescription>
              Held in this screen's memory and nowhere else — never in browser storage,
              never in the address, and gone when you reload. Revoke it from the API keys
              screen if it ever leaves this tab.
            </FieldDescription>
          </Field>
        ) : null}

        {notSendable === undefined ? (
          <>
            {unarmed ? (
              <div className="grid justify-items-start gap-2">
                <Alert>
                  <AlertTitle>
                    Arm the Playground before sending anything but a read on your Session.
                  </AlertTitle>
                  <AlertDescription>
                    Your Session is the credential you did not have to type, and it
                    carries the Role you actually work with. Arming lasts until you sign
                    out, and it is a courtesy rather than a lock — kobai is what decides
                    whether you may.
                  </AlertDescription>
                </Alert>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    arm();
                    setArmed(true);
                  }}
                >
                  Arm the Playground
                </Button>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <ActionButton
                unavailable={unavailable}
                disabled={send.isPending}
                onClick={() => send.mutate()}
              >
                {send.isPending ? <Spinner /> : null}
                Send the request
              </ActionButton>
              <span className="text-muted-foreground text-xs">
                <code>
                  {operation.method} {operation.path}
                </code>
                , for real.
              </span>
            </div>
          </>
        ) : (
          <Alert>
            <AlertTitle>This one is not offered to send.</AlertTitle>
            <AlertDescription>
              {notSendable} {WHY_NOT_SENDABLE}
            </AlertDescription>
          </Alert>
        )}

        {/* **The request never left**, which is a different thing from kobai refusing it — a
            refusal is rendered below as the answer it is. Two ways to get here: the network is
            gone, or the publishable key could not be minted, which is a Role without
            `api-key:write` and comes with kobai's own prose about it. So the title says what
            did not happen rather than why, and `problemOf` supplies the why when there is one. */}
        <Problem
          title="The request was not sent."
          problem={
            send.isError
              ? problemOf(send.error, "kobai could not be reached at all.")
              : null
          }
        />

        {send.data === undefined ? null : <TheAnswer answer={send.data} />}
      </div>
    </Detail>
  );
}

/**
 * What kobai answered: the status, the body, and how long it took.
 *
 * **A refusal is an answer here rather than an error state**, and it renders exactly like one —
 * the status, the `reason` a storefront branches on, the prose a person reads, and the body
 * whole. The screens elsewhere in this Admin turn a refusal into a sentence because a Merchant
 * cannot act on the rest of it; a Developer standing here can act on all of it, and came for it.
 *
 * **The body wraps rather than scrolling, and that is an accessibility decision rather than a
 * layout one.** A block with its own scrollbar and nothing focusable inside it cannot be
 * scrolled with a keyboard at all — `axe` calls that `scrollable-region-focusable` — and the
 * obvious repair, a `tabIndex` on the `<pre>`, is a finding of its own under
 * `noNoninteractiveTabindex`. A response that is simply *long* needs neither: the page scrolls,
 * which every browser already makes reachable, and `GET /admin/openapi.json` sent from here is
 * genuinely half a megabyte of answer rather than something to hide in a box.
 */
function TheAnswer({ answer }: { readonly answer: PlaygroundAnswer }) {
  const heading = useId();

  return (
    // A `section` rather than a `div` carrying the role: with an accessible name it *is* a
    // region, and somebody navigating by landmark reaches the answer without walking the form.
    <section aria-labelledby={heading} className="grid gap-2">
      <h4 id={heading} className="font-medium text-sm">
        The response
      </h4>
      <p className="flex flex-wrap items-baseline gap-2">
        <Badge variant={answer.refused ? "destructive" : "secondary"}>
          <code>{answer.status}</code>
        </Badge>
        <span className="text-muted-foreground text-sm">
          {answer.refused ? "Refused" : "Answered"} in {answer.milliseconds} ms
        </span>
      </p>
      {answer.reason === undefined ? null : (
        <p className="text-sm">
          <code className="font-medium">{answer.reason}</code>
          {answer.message === undefined ? null : <> — {answer.message}</>}
        </p>
      )}
      <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
        <code>{answer.body === "" ? "No body." : answer.body}</code>
      </pre>
    </section>
  );
}

/** What to say under the picker about the credential in force. */
function noteOn(chosen: CredentialChoice): string {
  return CREDENTIALS.find((one) => one.value === chosen)?.note ?? "";
}

/**
 * Why the send control is not usable yet, or `null` where it is.
 *
 * Two answers, and neither of them predicts a refusal: one is that the chosen credential has
 * not been given, and the other is that a non-`GET` on the Session has not been armed. What a
 * Role may actually do is Core's answer and is never guessed at here.
 */
function whyNotYet(
  chosen: CredentialChoice,
  operation: Operation,
  secret: string,
  armed: boolean,
): string | null {
  if (chosen === "secret" && pasted(secret) === "") {
    return "Paste a secret key first: this request carries the credential chosen above, and there is none to carry.";
  }
  if (needsArming(chosen, operation, armed)) {
    return `Arm the Playground first: this would send a real ${operation.method} against this deployment, on the Session this tab is signed in with. Arming is a courtesy rather than a lock — kobai is what enforces.`;
  }
  return null;
}

/**
 * Whether this send is the one arming stands in front of, asked in one place.
 *
 * The guard is on the **ambient** credential and on nothing else: the Session is the one the
 * Developer did not have to type, carrying the Role they actually work with, against the real
 * Store. Written once because the screen asks it twice — to draw the arming control, and to say
 * why the send control is not usable yet — and two copies of a safety rule is how one of them
 * ends up narrower than the other.
 */
function needsArming(
  chosen: CredentialChoice,
  operation: Operation,
  armed: boolean,
): boolean {
  return chosen === "session" && operation.method !== "GET" && !armed;
}

/**
 * A pasted key, as it is actually sent.
 *
 * Trimmed in **one** place, because the two that read it have to agree: a key copied out of a
 * terminal arrives with a newline on it, and a screen that unlocked the send control on the
 * trimmed value while sending the untrimmed one would answer with a refusal about a credential
 * the Developer never typed.
 */
function pasted(secret: string): string {
  return secret.trim();
}

/**
 * The credential a send carries, come by the way each of the three deserves.
 *
 * The publishable one is **the key this Admin already mints and holds** for the storefront
 * price preview (`lib/preview-key.ts`), minted on the spot where this browser session has none.
 * Two self-minting mechanisms would double an accumulation that module already apologises for,
 * and a Merchant reading the API keys list wants one line meaning "the Admin itself".
 */
async function credentialFor(
  chosen: CredentialChoice,
  secret: string,
  client: KobaiClient,
): Promise<PlaygroundCredential> {
  if (chosen === "session") return { kind: "session" };
  if (chosen === "secret") return { kind: "key", apiKey: pasted(secret) };
  return { kind: "key", apiKey: await heldPreviewKey(client) };
}
