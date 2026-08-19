import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldXIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { ConfirmDelete } from "@/components/confirm-delete";
import { FormField } from "@/components/form-field";
import { LinkButton } from "@/components/link-button";
import { PermissionsField } from "@/components/permissions-field";
import { Problem } from "@/components/problem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { orThrow, problemOf, roleReasonOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";

/**
 * One Role: what it is called, what it may do, and the way to remove it (#173, ADR-0066).
 *
 * **A change takes effect on the next request every Merchant holding this Role makes**, signed
 * in or not — the gate reads the Role on each one rather than copying it into the session — so
 * narrowing a colleague who is looking at the Admin right now narrows them now. The Admin's own
 * affordances follow within a navigation or a window focus, which is `lib/session.tsx`'s half of
 * ADR-0063.
 *
 * `metadata` is deliberately never sent. `PATCH /admin/roles/{id}` **replaces** it rather than
 * merging (ADR-0062), so a form that submitted an empty object would silently discard whatever
 * a Project stashed there — and leaving the field out is what "leave it alone" means.
 */
const ROLE = "role";

export function RoleScreen() {
  const client = useKobaiClient();
  const id = useRouteId();

  const role = useQuery({
    queryKey: [ROLE, id],
    queryFn: async () =>
      orThrow(await client.GET("/admin/roles/{id}", { params: { path: { id } } })),
  });

  // The breadcrumb otherwise reads as the identifier out of the URL, which is the one thing on
  // this screen a Merchant cannot use to tell one Role from another.
  useCrumbTitle(role.data?.name);

  if (role.isPending) return <RoleLoading />;

  if (role.isError) {
    return roleReasonOf(role.error) === "role-not-found" ? (
      <NoSuchRole />
    ) : (
      <Problem
        title="That Role could not be read."
        problem={problemOf(role.error, "kobai did not answer.")}
      />
    );
  }

  return (
    <div className="grid gap-6">
      {/* An `h2`: the frame renders the page's `h1` from the route, so this is the heading
          under it rather than a second first-level one. */}
      <h2 className="font-medium text-xl">{role.data.name}</h2>

      <RoleIdentity id={id} name={role.data.name} permissions={role.data.permissions} />
    </div>
  );
}

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * Whether the new name is taken, and whether taking a Permission away would lock the
 * deployment out of itself, are rules that live in Core and arrive as refusals. Neither is
 * evaluated here — see {@link LockoutWarning} for the one thing this screen does say in
 * advance, and why saying it is not the same as predicting the answer.
 */
const RoleForm = z.object({
  name: z
    .string()
    .min(1, "A Role is named, and a Merchant is created against that name."),
  permissions: z.array(z.string()),
});

type RoleValues = z.infer<typeof RoleForm>;

/**
 * What the Role is called and what it may do, as one form, and the way to delete it.
 *
 * Both fields are always sent, so the "a body naming nothing this route would change is
 * refused" case cannot arise from here — a Merchant who changes nothing and saves gets the
 * record back unchanged, which is the honest answer to having asked for nothing.
 */
function RoleIdentity({
  id,
  name,
  permissions,
}: {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly string[];
}) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const navigate = useNavigate();
  const unavailable = useUnavailable(PERMISSIONS.merchantWrite, "administer access");

  const form = useForm<RoleValues>({
    resolver: zodResolver(RoleForm),
    // `values` rather than `defaultValues`, so a change that landed leaves the form showing
    // what kobai now holds rather than what was typed at it.
    values: { name, permissions: [...permissions] },
  });

  const save = useMutation({
    mutationFn: async (values: RoleValues) =>
      orThrow(
        await client.PATCH("/admin/roles/{id}", {
          params: { path: { id } },
          body: { name: values.name, permissions: values.permissions },
        }),
      ),
    // Re-read rather than patched in place, like every write in this Admin (ADR-0063). Only
    // this Role's key: nothing here caches fresh, so the list behind this screen re-reads when
    // it is next mounted, and the session — which may be this Merchant's own Role — is re-read
    // on the next navigation or window focus, which is `lib/session.tsx`'s half of ADR-0063.
    onSuccess: () => void queries.invalidateQueries({ queryKey: [ROLE, id] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Role</CardTitle>
        <CardDescription>
          A Merchant holds one Role, and a Role is read on every request they make — so a
          change here reaches them without anybody signing out.
        </CardDescription>
        <CardAction>
          <ConfirmDelete
            trigger="Delete Role"
            title="Delete this Role?"
            description="kobai refuses this while any Merchant holds it, rather than cascading onto them or moving them somewhere it chose — you will be told here if so, and Merchants is where to see who has it."
            unavailable={unavailable}
            onDelete={async () =>
              orThrow(
                await client.DELETE("/admin/roles/{id}", { params: { path: { id } } }),
              )
            }
            // Away from an address that no longer resolves. The list behind it re-reads on
            // arrival — nothing in this cache is ever fresh — so there is no key to invalidate
            // and no chance of invalidating the wrong one from here.
            onDeleted={() => void navigate("/roles", { replace: true })}
            problemOf={whyNotDeleted}
          />
        </CardAction>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The Role was not changed."
          />
          <FormField
            id="role-name"
            label="Name"
            error={form.formState.errors.name}
            {...form.register("name")}
          />
          <PermissionsField
            id="role-permissions"
            control={form.control}
            name="permissions"
          />
          <LockoutWarning held={permissions} staged={form.watch("permissions")} />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save Role
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * The rule about locking a deployment out of itself, said before the change is attempted.
 *
 * **This is the one place in the Admin that says anything about a refusal in advance, and it is
 * deliberately not a prediction.** ADR-0063's rule stands — a rule that lives in Core is not
 * re-implemented in a browser — and the whole of what makes that rule right applies here: the
 * condition is *"would any Merchant anywhere still hold `merchant:write`"*, which is a question
 * about rows this browser has not read and, `GET /admin/merchants` being paged, cannot read in
 * one request. An Admin that answered it would be answering it wrongly the first time a Store
 * had more Merchants than a page.
 *
 * So what is shown is the **rule**, exactly when it becomes relevant, and never a verdict. The
 * control stays available, the change is still attempted, and kobai's `last-administrator` is
 * still what settles it — rendered where it was attempted, like every other refusal here.
 *
 * It earns its exception to "attempt and explain" because the action is one a Merchant cannot
 * undo for themselves: the first Merchant is seeded only while a deployment holds none
 * (ADR-0041), so a Store that stripped its last administrator has no way back through this
 * Admin, through the API, or through anything short of raw SQL. Being told *afterwards* that
 * kobai stopped you is fine; being told *afterwards* that it did not would not have been.
 */
function LockoutWarning({
  held,
  staged,
}: {
  /** What kobai says the Role holds now. */
  readonly held: readonly string[];
  /** What the form would send. */
  readonly staged: readonly string[];
}) {
  const losing =
    held.includes(PERMISSIONS.merchantWrite) &&
    !staged.includes(PERMISSIONS.merchantWrite);

  if (!losing) return null;

  return (
    <Alert>
      <AlertTitle>This Role is losing the power to administer access.</AlertTitle>
      <AlertDescription>
        Every Merchant holding it loses <code>{PERMISSIONS.merchantWrite}</code> on their
        next request, so none of them can add a colleague or change a Role afterwards.
        kobai refuses the change outright if it would leave no Merchant anywhere holding
        that Permission — there would be nobody left who could put it back, and no way in
        short of the database. Check Merchants for who else has it.
      </AlertDescription>
    </Alert>
  );
}

/** The Role, before it is there. */
function RoleLoading() {
  return (
    <div className="grid gap-6" role="status" aria-label="Reading the Role">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * An address naming a Role this deployment does not have.
 *
 * Its own screen rather than a red box, because it is the one refusal here a Merchant can act
 * on and the action is "go back to the list" — a Role somebody deleted, or a link kept too
 * long.
 */
function NoSuchRole() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldXIcon />
        </EmptyMedia>
        <EmptyTitle>No such Role</EmptyTitle>
        <EmptyDescription>
          This deployment has no Role at that address. It may have been deleted since the
          link was made.
        </EmptyDescription>
      </EmptyHeader>
      <LinkButton to="/roles">Go to Roles</LinkButton>
    </Empty>
  );
}

/**
 * Why kobai refused a **change** to this Role.
 *
 * `last-administrator` is the sentence this whole screen is arranged around, and it says what
 * to do rather than only what happened: the way out is to give the Permission to somebody else
 * first, which is a Role away.
 */
function whyNotChanged(thrown: unknown): string {
  const fallback = "kobai would not make that change.";
  const reason = roleReasonOf(thrown);

  switch (reason) {
    case "last-administrator":
      // What it tells a Merchant to do has to be a thing kobai can actually do: there is no
      // route that moves a Merchant onto another Role, so "give somebody else the Permission"
      // means adding a colleague against a Role that holds it, which `POST /admin/merchants`
      // can. Advising the move would have been advice nobody could take.
      return `Every Merchant who can administer Merchants holds this Role, so taking "${PERMISSIONS.merchantWrite}" away would leave nobody who could put it back — and no way in short of the database. Add a colleague against a Role that holds it — Merchants is where — and then come back.`;

    case "role-name-taken":
      return "Another Role already carries that name. A Merchant is created against a Role by name, so no two may share one.";

    case "role-not-found":
      return "It is no longer there — somebody else deleted this Role, or this page has been open a while.";

    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
      return problemOf(thrown, fallback);

    case "role-in-use":
      // A deletion's refusal, not reachable from a change.
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
 * Nothing is predicted: the delete control is offered to anybody who may administer access,
 * whether or not Merchants hold this Role, because who holds it is a fact in Core rather than
 * one this browser has read.
 */
function whyNotDeleted(thrown: unknown): string {
  const fallback = "The Role was not deleted.";
  const reason = roleReasonOf(thrown);

  switch (reason) {
    case "role-in-use":
      // And this one is a dead end rather than a step, which is the honest thing to say:
      // kobai has no route that moves a Merchant onto another Role or removes one, so a Role
      // somebody holds cannot be deleted at all today. Telling a Merchant to move them first
      // would send them looking for a control that does not exist.
      return "Merchants hold this Role, and deleting it would leave them signed in holding nothing at all. kobai has no way to move a Merchant onto another Role, so this one stays for as long as anybody holds it — narrow its Permissions instead. Merchants says who has it.";

    case "role-not-found":
      return "It is already gone — somebody else deleted it, or this page has been open a while.";

    case "invalid":
    case "malformed-body":
    case "role-name-taken":
    case "last-administrator":
      // Not reachable from a delete, which sends no body and names no name. Reported as kobai
      // said it rather than as a sentence written here for a case nobody has seen.
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
