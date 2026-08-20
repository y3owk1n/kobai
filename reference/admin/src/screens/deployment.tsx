import type { DeployedWorkflow, Health, StepOrigin } from "@kobai/client";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useFulfilmentStrategies } from "@/components/fulfilment-strategy-field";
import { Problem } from "@/components/problem";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/** The release, the Workflows and the payment answer, which are one route's answer. */
const DEPLOYMENT = "deployment";

/** The migration sets, which are `GET /health`'s answer and nobody else's. */
const HEALTH = "health";

/**
 * What this running kobai actually is, asked of the deployment rather than of a config file.
 *
 * Everything a Project decides in `kobai.config.ts` disappears into a process, and until
 * ADR-0080 there was no way back: a Developer answered "which Steps has this replaced" by
 * reading the file they hoped had shipped, and "which migration sets applied" by curling
 * `/health`. This screen is the one place those questions are answered about the server that
 * is serving it.
 *
 * **It composes three reads and adds no fourth route.** `GET /admin/deployment` carries the
 * release, the Workflows and the payment answer; `GET /admin/fulfilment-strategies` already
 * answers the Strategies, because a picker needed them first (ADR-0067); and `GET /health`
 * already answers the migration sets, because a container probe needed those. Restating any of
 * them in the deployment route would be two descriptions of one fact that can disagree, so the
 * composition happens here — which is why this file holds three queries rather than one.
 *
 * **Each read renders where it was attempted.** They sit behind three different gates —
 * `deployment:read`, `catalog:read` and nothing at all — so a Role granted exactly what
 * ADR-0080 describes is genuinely refused one of them, and a screen that reported "the
 * deployment could not be read" over the lot would be wrong about two thirds of itself. So a
 * refusal is rendered in the card whose read it answers, and the cards beside it still say what
 * they know.
 */
export function DeploymentScreen() {
  return (
    <div className="grid gap-6">
      <TheDeployment />
      <TheFulfilmentStrategies />
      <TheMigrationSets />
    </div>
  );
}

/**
 * The release, the payment answer and every Workflow — one read, rendered as several cards.
 *
 * The cards are a view of one query, so its refusal and its loading state are rendered **once**
 * between them rather than repeated in each: one read that did not happen is one thing that
 * went wrong, and saying so three times reads as three failures.
 *
 * Nothing here can change while the process runs — the whole answer is decided at boot — so it
 * is read once and never invalidated, which `staleTime` says outright rather than leaving to
 * look like an oversight. A restart is a new page load.
 */
function TheDeployment() {
  const client = useKobaiClient();

  const deployment = useQuery({
    queryKey: [DEPLOYMENT],
    queryFn: async () => orThrow(await client.GET("/admin/deployment")),
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (deployment.isPending) {
    return (
      <div className="grid gap-6" role="status" aria-label="Reading the deployment">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (deployment.isError) {
    return (
      <Problem
        title="This deployment could not be read."
        problem={problemOf(deployment.error, "kobai did not answer.")}
      />
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>This deployment</CardTitle>
          <CardDescription>
            Read from the running server rather than from the checkout you hope is
            deployed — so it is the answer for the process actually serving this page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-6 sm:grid-cols-2">
            <Fact
              label="Core"
              note="The release of @kobai/core this server is built from — the same value its OpenAPI description carries."
            >
              <code>{deployment.data.version}</code>
            </Fact>
            <Fact
              label="Payment Provider"
              note="A deployment with none serves everything else and refuses to place an Order, with no-payment-provider (ADR-0053)."
            >
              {deployment.data.payments.configured ? (
                <Badge variant="secondary">Configured</Badge>
              ) : (
                <Badge variant="outline">None wired</Badge>
              )}
            </Fact>
          </dl>
        </CardContent>
      </Card>

      {deployment.data.workflows.map((workflow) => (
        <WorkflowCard key={workflow.name} workflow={workflow} />
      ))}
    </>
  );
}

/**
 * One Workflow, and where each Step in it came from.
 *
 * **The reason this screen is worth having on its own.** A Workflow is ADR-0003's flagship
 * Extension Point, and a surprising price is either Core's decision or the Project's — which
 * is a question nobody could answer from outside the process. `origin` is recorded where the
 * rewiring happens and never inferred here: an inserted Step occupies a position under its own
 * name, so `slot === step` is true of a stock position *and* of an inserted one, and a screen
 * that compared them would call two customised deployments stock (ADR-0080).
 *
 * A card per Workflow, and its name in the `CardTitle` rather than in a heading: these cards
 * are a list of records rather than sections of one, which is where this Admin puts headings
 * and where it does not.
 */
function WorkflowCard({ workflow }: { readonly workflow: DeployedWorkflow }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{workflow.name}</CardTitle>
        <CardDescription>
          Every position in this Workflow, in the order it runs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Position</TableHead>
              <TableHead>Step</TableHead>
              <TableHead>Origin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workflow.steps.map((step) => (
              <TableRow key={`${step.slot} ${step.step}`}>
                <TableCell className="font-medium">
                  <code>{step.slot}</code>
                </TableCell>
                <TableCell>
                  <code>{step.step}</code>
                </TableCell>
                <TableCell>
                  <StepOriginBadge origin={step.origin} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * Whether this position is Core's own, and the one thing a Developer scans this table for.
 *
 * **The word is on the row and the colour is only beside it.** A Developer ruling
 * customisation out needs `Stock` to be an answer rather than the absence of another one, and a
 * distinction carried by a palette alone is one a screen reader reports as nothing whatever.
 *
 * One `switch` decides both the word and the recipe, and the `never` at the bottom is what
 * holds the arms complete: the set is **closed** in kobai's types, so a fourth origin added in
 * Core has no arm here, does not compile, and reddens this build in the same commit (ADR-0063).
 * `ProductStatusBadge` keeps its words in a `Record` beside the same `switch` because three
 * places read them; nothing but this table reads these.
 *
 * `stock` is the quiet one, for the Products list's reason in reverse: a deployment is mostly
 * Core, and what a reader came for is the position that is not.
 */
function StepOriginBadge({ origin }: { readonly origin: StepOrigin }) {
  switch (origin) {
    case "stock":
      return <Badge variant="outline">Stock</Badge>;

    case "replaced":
      return <Badge>Replaced</Badge>;

    case "inserted":
      // Distinct from `replaced` rather than a shade of it: an inserted Step watches a position
      // without owning it and cannot change what the slot answers, which is a different thing
      // to know about a deployment.
      return <Badge variant="secondary">Inserted</Badge>;

    default: {
      // Unreachable, and it is the compiler that says so.
      const unreached: never = origin;
      return unreached;
    }
  }
}

/**
 * The Strategies a Variant here may name — the second of the three reads.
 *
 * Through `useFulfilmentStrategies`, which is the same query the Variant picker reads: one read
 * of one set, cached under one key, rather than a second call that could disagree with the
 * field a Merchant fills in.
 */
function TheFulfilmentStrategies() {
  const strategies = useFulfilmentStrategies();

  return (
    <ReadCard
      title="Fulfilment Strategies"
      subject="Fulfilment Strategies"
      skeleton="h-6 w-64"
      read={strategies}
      description={
        <>
          Every Strategy wired here, which is the complete set a Variant's{" "}
          <code>fulfilment.strategy</code> may name (ADR-0067) — read from kobai rather
          than written down, because which names a deployment has is the deployment's
          answer. A Plugin's is wired in the Project's <code>kobai.config.ts</code>, and
          installing the Plugin does not wire it.
        </>
      }
    >
      {strategies.data ? (
        <ul aria-label="Strategies wired here" className="flex flex-wrap gap-2">
          {strategies.data.strategies.map((strategy) => (
            <li key={strategy.name}>
              <Badge variant="secondary">{strategy.name}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </ReadCard>
  );
}

/**
 * Which migration sets applied, and how many migrations each carries — the third read.
 *
 * `GET /health` is the one route that answers before migrations have run and after they have
 * failed, which is why it carries this at all; ADR-0080 refuses to restate it on the deployment
 * route for exactly that reason. It needs no credential, so this is the one card on this screen
 * a Role holding nothing at all still gets an answer in.
 *
 * Read once and never invalidated, like the two above it: which sets applied is decided by a
 * boot, and a restart is a new page load.
 */
function TheMigrationSets() {
  const client = useKobaiClient();

  const health = useQuery({
    queryKey: [HEALTH],
    queryFn: async () => orThrow(await client.GET("/health")),
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <ReadCard
      title="Migration sets"
      subject="migration sets"
      skeleton="h-24 w-full"
      read={health}
      description="What this deployment's database has had applied to it. Each package owns its own set and its own tracking table (ADR-0004), so a Plugin's tables being present is this list having a line for it."
    >
      {health.data ? <MigrationState state={health.data.migrations} /> : null}
    </ReadCard>
  );
}

/**
 * A card whose whole content is one read: what it says in flight, what it says when it was
 * refused, and the answer.
 *
 * **Extracted on the second rather than the third**, which is `listbox-field.tsx`'s lesson: the
 * Strategies card and the migration sets card had the same scaffold to the character, and a
 * third read would have got to reintroduce whatever either had fixed by hand. What a caller
 * keeps is what is genuinely its own — which read this is, what to call it, and how to draw the
 * answer.
 *
 * **Each card announces its own read.** Three live regions on one page load is a real cost, and
 * it is the cost of the thing this screen is for: the reads sit behind three different gates and
 * finish at three different times, so one status over the lot would be announcing the slowest of
 * them and saying nothing about the two that had already answered or been refused.
 */
function ReadCard({
  title,
  subject,
  description,
  skeleton,
  read,
  children,
}: {
  readonly title: string;
  /** Completes "Reading the …" and "The … could not be read.", so it is a plural noun phrase. */
  readonly subject: string;
  readonly description: ReactNode;
  /** The shape the skeleton holds, which is roughly the shape of the answer replacing it. */
  readonly skeleton: string;
  readonly read: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: unknown;
  };
  readonly children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {read.isPending ? (
          <div role="status" aria-label={`Reading the ${subject}`}>
            <Skeleton className={skeleton} />
          </div>
        ) : null}

        <Problem
          title={`The ${subject} could not be read.`}
          problem={read.isError ? problemOf(read.error, "kobai did not answer.") : null}
        />

        {children}
      </CardContent>
    </Card>
  );
}

/**
 * The migration run, whichever of its four states it is in.
 *
 * **`applied` is the one this screen exists for and the only one it can be asked about**: a
 * browser that has rendered this far has been served `/admin/session`, which is refused until
 * migrations apply. The other three are handled because the union has them, in as few words as
 * says the true thing — not because a ticket asked for prose about a deployment nobody can be
 * looking at this card from.
 *
 * Exhaustive, and the `never` keeps it so: a fifth state added in Core has no arm here and
 * reddens this build in the same commit (ADR-0063), exactly as a refusal family does.
 */
function MigrationState({ state }: { readonly state: Health["migrations"] }) {
  switch (state.status) {
    case "applied":
      return (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Set</TableHead>
              <TableHead>Migrations applied</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.sets.map((set) => (
              <TableRow key={set.name}>
                <TableCell className="font-medium">
                  <code>{set.name}</code>
                </TableCell>
                <TableCell>{set.applied}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );

    // One arm for both, because they are one thing to a reader: there is no list yet. Which of
    // the two it is changes nothing a Merchant looking at this card would do.
    case "pending":
    case "running":
      return (
        <p className="text-muted-foreground text-sm">
          There is nothing to report yet — this deployment is still starting.
        </p>
      );

    case "failed":
      return (
        <Problem
          title="A migration set did not apply."
          problem={`${state.set ?? "A set"} stopped: ${state.message}`}
        />
      );

    default: {
      const unreached: never = state;
      return unreached;
    }
  }
}

/**
 * One fact about this deployment, and what it means to a Developer reading it.
 *
 * A `<div>` around each `<dt>`/`<dd>` pair, which is what a description list allows and what
 * lets a pair be laid out as one.
 */
function Fact({
  label,
  note,
  children,
}: {
  readonly label: string;
  readonly note: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <dt className="font-medium text-sm">{label}</dt>
      <dd className="grid gap-1">
        <div className="text-base">{children}</div>
        <div className="text-muted-foreground text-sm">{note}</div>
      </dd>
    </div>
  );
}
