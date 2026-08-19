import { zodResolver } from "@hookform/resolvers/zod";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ShieldCheckIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { LinkButton } from "@/components/link-button";
import { Pager, usePageCursor } from "@/components/pager";
import { PermissionsField } from "@/components/permissions-field";
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
import { orThrow, problemOf, roleReasonOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The Roles this deployment has, and the way to make another (#173, ADR-0027).
 *
 * Exactly one Role existed before the routes behind this screen: `owner`, seeded by a
 * migration and holding everything, so every deployment had one kind of Merchant and
 * permission-gating was a mechanism nobody could reach. This is where that stops being true —
 * a Role is a row, and a Merchant with `merchant:write` can make one.
 *
 * **It pages through the cursor like every other list here** (ADR-0064), and the reason is not
 * that a deployment will have hundreds: `GET /admin/roles` pages because a Merchant can create
 * one over HTTP while somebody else is reading the list, which is the test ADR-0067 sets for
 * whether a route pages at all.
 *
 * Editing and deleting live on the Role's own screen rather than in a row here, the way a
 * Product's do: the interesting half of a Role is its Permissions, and a set of checkboxes is
 * not a table cell.
 */
const ROLES = "roles";

export function Roles() {
  const client = useKobaiClient();
  const after = usePageCursor();

  const page = useQuery({
    queryKey: [ROLES, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/roles", {
          params: { query: after === undefined ? {} : { after } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const roles = page.data?.roles;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Roles
            {page.isFetching && !page.isPending ? <Spinner /> : null}
          </CardTitle>
          <CardDescription>
            What a colleague can be given. A Role is a name and a set of Permissions, and
            a Merchant holds exactly one — open it to change what it may do.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Problem
            problem={
              page.isError ? problemOf(page.error, "The Roles could not be read.") : null
            }
          />

          {page.isPending ? <RolesLoading /> : null}

          {roles !== undefined && roles.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ShieldCheckIcon />
                </EmptyMedia>
                <EmptyTitle>No Roles on this page</EmptyTitle>
                <EmptyDescription>
                  A deployment is seeded with <code>owner</code>, so an empty list here
                  means this page of it is past the end. Create one below to give a
                  colleague something narrower.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {roles !== undefined && roles.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.map((role) => (
                  <TableRow key={role.id}>
                    <TableCell className="font-medium">{role.name}</TableCell>
                    {/* `whitespace-normal` for the reason `screens/merchants.tsx` gives at the
                        same column: a Role holding every Permission is one unbreakable line,
                        and a table that scrolls sideways is a scrollable region axe wants
                        reachable by keyboard. */}
                    <TableCell className="whitespace-normal text-muted-foreground text-xs">
                      {/* The words rather than a count, because which Permissions a Role
                          holds is the whole of what tells two of them apart — and a Role
                          holding none is a real state that a "0" would report as a number
                          rather than as the thing it is. */}
                      {role.permissions.length === 0
                        ? "none — can sign in and reach nothing"
                        : role.permissions.join(", ")}
                    </TableCell>
                    <TableCell>
                      <LinkButton to={`/roles/${role.id}`} size="sm" variant="outline">
                        Open
                      </LinkButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <Pager nextCursor={page.data?.nextCursor} label="Roles" />
        </CardContent>
      </Card>

      <NewRole />
    </div>
  );
}

/** A page of Roles, before there is one. */
function RolesLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the Roles">
      {["first", "second", "third"].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * `min(1)` on the name is the field being required. Whether the name is *taken* is Core's
 * answer and arrives as `role-name-taken`; which Permission strings are acceptable is
 * deliberately not checked anywhere, because the set is open — see
 * `components/permissions-field.tsx`.
 */
const NewRoleForm = z.object({
  name: z
    .string()
    .min(1, "A Role is named, and a Merchant is created against that name."),
  permissions: z.array(z.string()),
});

type NewRoleValues = z.infer<typeof NewRoleForm>;

/**
 * A Role with a named set of Permissions.
 *
 * **A Role holding none is valid and is what an empty form creates**, which is worth knowing
 * before it looks like a bug: `POST /admin/roles` defaults `permissions` to none, and a
 * colleague added against such a Role can sign in and reach nothing until somebody says what
 * they may do. `app.tsx` has a screen for exactly that state.
 *
 * Gated on `merchant:write` as an affordance — the enforcement is Core's `requirePermission`,
 * and `lib/permissions.ts` says so at length. There is deliberately no `role:write` beside it:
 * a Merchant who may add a colleague may add one against `owner`, so administering access is
 * one power and one word (ADR-0066).
 */
function NewRole() {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.merchantWrite, "create a Role");

  const form = useForm<NewRoleValues>({
    resolver: zodResolver(NewRoleForm),
    defaultValues: { name: "", permissions: [] },
  });

  const create = useMutation({
    mutationFn: async (values: NewRoleValues) =>
      orThrow(
        await client.POST("/admin/roles", {
          body: { name: values.name, permissions: values.permissions },
        }),
      ),
    onSuccess: () => form.reset(),
    // Read back rather than patched in: there is no optimistic update anywhere in this Admin
    // (ADR-0063), and what a Role looks like once kobai holds it is kobai's answer.
    onSettled: () => queries.invalidateQueries({ queryKey: [ROLES] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Role</CardTitle>
        <CardDescription>
          A name and a set of Permissions. Nothing is stopping a Role from holding none —
          that is what a colleague has until somebody says otherwise.
        </CardDescription>
      </CardHeader>
      {/* No guard of its own: Enter in a field is implicit submission, which a browser
          performs by clicking this form's default button — the `ActionButton` below, whose
          handler is the no-op for a Role that may not create one. */}
      <form onSubmit={form.handleSubmit((values) => create.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={create.isError ? whyNotCreated(create.error) : null}
            title="The Role was not created."
          />
          <FormField
            id="new-role-name"
            label="Name"
            placeholder="fulfilment"
            error={form.formState.errors.name}
            {...form.register("name")}
          />
          <PermissionsField
            id="new-role-permissions"
            control={form.control}
            name="permissions"
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton
            type="submit"
            unavailable={unavailable}
            disabled={create.isPending}
          >
            {create.isPending ? <Spinner /> : null}
            Create Role
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Why kobai turned the creation back, in words a Merchant can act on.
 *
 * Exhaustive over `RoleRefusal`, and the `never` at the bottom is what keeps it so: a reason
 * added to that family in Core has no arm here and reddens this build in the same commit
 * (ADR-0063). Most of them cannot reach a creation at all — there is no Role to be not found,
 * none in use, and nothing to strip — so they report kobai's own prose rather than a sentence
 * written here for a case nobody has seen.
 */
function whyNotCreated(thrown: unknown): string {
  const fallback = "The Role could not be created.";
  const reason = roleReasonOf(thrown);

  switch (reason) {
    case "role-name-taken":
      return "A Role already carries that name. A Merchant is created against a Role by name, so no two may share one.";

    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
      return problemOf(thrown, fallback);

    case "role-not-found":
    case "role-in-use":
    case "last-administrator":
      // Refusals of a change or a deletion, not reachable from a creation.
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
