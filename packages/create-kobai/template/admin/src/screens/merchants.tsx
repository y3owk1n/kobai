import { zodResolver } from "@hookform/resolvers/zod";
import type { Merchant, Role } from "@kobai/client";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { UsersIcon } from "lucide-react";
import { type Control, type FieldValues, type Path, useForm } from "react-hook-form";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { ListboxField } from "@/components/listbox-field";
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
import { merchantReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * Who has access to this deployment, and the way to add a colleague (#173, ADR-0066).
 *
 * **Merchants were write-only until the route this list reads.** One could be created and never
 * seen again, so "who has access" was a question this API could not answer about itself — and
 * the Admin never called the one route there was, which left onboarding a colleague to raw SQL
 * or to the boot-time seed.
 *
 * The two halves sit behind **different Permissions and that is deliberate**: reading the roster
 * is `merchant:read` and everything that changes it is `merchant:write`, because adding a
 * colleague confers everything — they can be added against `owner` — while seeing who has
 * access confers nothing. Gating the list on the write would have meant granting the power to
 * change who has access in order to let somebody look.
 *
 * **Which Role a colleague holds is correctable from the roster** (#202). It is the remedy
 * `role-in-use` never had: `DELETE /admin/roles/{id}` refuses while anybody holds the Role and
 * points here, and until `PATCH /admin/merchants/{id}` existed there was nothing on this screen
 * or in the API that could move any of them off it. A Role somebody held was permanent, and this
 * screen had to say so.
 *
 * There is still no way to *remove* a Merchant here, because there is no route that does. That
 * is the API's gap rather than this screen's omission, and the honest thing is to offer nothing
 * for it (ADR-0010): what an Admin needs and the API cannot do is a finding about the API — and
 * #202 is what that finding looks like once it has been answered.
 */
const MERCHANTS = "merchants";

export function Merchants() {
  const client = useKobaiClient();
  const after = usePageCursor();

  const page = useQuery({
    queryKey: [MERCHANTS, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/merchants", {
          params: { query: after === undefined ? {} : { after } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const merchants = page.data?.merchants;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Merchants
            {page.isFetching && !page.isPending ? <Spinner /> : null}
          </CardTitle>
          <CardDescription>
            Everybody who can sign in to this Admin, newest first, and the Role each of
            them holds. A Role is read on every request they make, so moving somebody onto
            another one reaches them without their signing out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Problem
            problem={
              page.isError
                ? problemOf(page.error, "The Merchants could not be read.")
                : null
            }
          />

          {page.isPending ? <MerchantsLoading /> : null}

          {merchants !== undefined && merchants.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>No Merchants on this page</EmptyTitle>
                <EmptyDescription>
                  A deployment seeds its first Merchant at boot, so an empty list here
                  means this page of it is past the end.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {merchants !== undefined && merchants.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>What they may do now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {merchants.map((merchant) => (
                  <TableRow key={merchant.id}>
                    <TableCell className="font-medium">
                      {merchant.email}
                      <div className="text-muted-foreground text-xs">
                        <code>{merchant.id}</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <MerchantRole merchant={merchant} />
                    </TableCell>
                    {/* `whitespace-normal` overrides the cell's own `nowrap`, and it is an
                        accessibility fix rather than a layout preference: a Role holding every
                        Permission Core defines is one long unbreakable line, which makes the
                        table's container scroll sideways — and a scrollable region that cannot
                        be reached by keyboard is what axe reports as
                        `scrollable-region-focusable`. Watched failing exactly that way in
                        `tests/the-admin-in-a-browser.test.ts`, which is the only seam here that
                        could see it. */}
                    <TableCell className="whitespace-normal text-muted-foreground text-xs">
                      {/* Spelled out rather than counted, because the question this column
                          answers is "can this colleague do the thing I am about to ask them
                          to" — and because it is where a Merchant sees who else holds
                          `merchant:write` before taking it off a Role. */}
                      {merchant.role.permissions.length === 0
                        ? "nothing — this Role holds no Permissions"
                        : merchant.role.permissions.join(", ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <Pager nextCursor={page.data?.nextCursor} label="Merchants" />
        </CardContent>
      </Card>

      <NewMerchant />
    </div>
  );
}

/**
 * The shape of the one field a move carries, and only the shape (ADR-0063).
 *
 * Whether the Role still exists, and whether moving *this* Merchant would leave the deployment
 * with nobody able to administer Merchants, are both rules in Core — the second is about rows
 * this browser has not read and could not read honestly — so each arrives as a refusal rather
 * than as a second copy of the rule here.
 */
const MoveMerchantForm = z.object({
  role: z.string().min(1, "Choose the Role this Merchant is to hold."),
});

type MoveMerchantValues = z.infer<typeof MoveMerchantForm>;

/**
 * Which Role one Merchant holds, and the way to move them onto another (#202, ADR-0062).
 *
 * **This is the remedy `role-in-use` never had.** Deleting a Role Merchants hold is refused and
 * always will be — Core will not cascade onto people or pick a Role on their behalf (ADR-0059) —
 * and until `PATCH /admin/merchants/{id}` there was nothing that could clear the way, so the
 * refusal was permanent. It is a step now, and this control is the step.
 *
 * Three things about it are decisions rather than layout:
 *
 * - **In the row, and the refusal with it.** `last-administrator` is the answer to a question
 *   about the whole deployment, and the only place it means anything is beside the Merchant it
 *   was refused for. Rendering it above the table would leave a Merchant reading a sentence
 *   about a row they can no longer see which one it was.
 * - **Nothing is predicted.** There is no check here for "is this the last administrator" and
 *   there must not be one, for `ConfirmDelete`'s reason: the rule lives in Core, it is about
 *   rows this list does not carry, and a screen that guessed would be wrong on every page but
 *   the first. The Admin attempts and renders the answer.
 * - **Move is dead while the picker still shows the Role they hold**, with real `disabled`
 *   rather than `aria-disabled`, because there is nothing to explain — the same judgement
 *   `Pager`'s dead Next and Previous make. What `aria-disabled` is for is the Role that may not
 *   do this at all, which is {@link ActionButton}'s `unavailable`, and the two compose: that
 *   branch forces `disabled` off so the sentence stays reachable.
 */
function MerchantRole({ merchant }: { readonly merchant: Merchant }) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(
    PERMISSIONS.merchantWrite,
    "move a Merchant onto another Role",
  );

  // `values` rather than `defaultValues`: the picker follows the roster, so a successful move —
  // or somebody else's, arriving on the next refetch — leaves the field showing what this
  // Merchant actually holds rather than what this browser last chose.
  const form = useForm<MoveMerchantValues>({
    resolver: zodResolver(MoveMerchantForm),
    values: { role: merchant.role.name },
  });
  const chosen = form.watch("role");

  const move = useMutation({
    mutationFn: async (values: MoveMerchantValues) =>
      orThrow(
        await client.PATCH("/admin/merchants/{id}", {
          params: { path: { id: merchant.id } },
          body: values,
        }),
      ),
    onSettled: () => queries.invalidateQueries({ queryKey: [MERCHANTS] }),
  });

  return (
    <form
      className="grid gap-2"
      onSubmit={form.handleSubmit((values) => move.mutate(values))}
    >
      <div className="flex items-end gap-2">
        <RoleField
          id={`merchant-role-${merchant.id}`}
          control={form.control}
          name="role"
          label={`Role for ${merchant.email}`}
          quiet
        />
        <ActionButton
          type="submit"
          variant="outline"
          size="sm"
          unavailable={unavailable}
          disabled={move.isPending || chosen === merchant.role.name}
        >
          {move.isPending ? <Spinner /> : null}
          Move
        </ActionButton>
      </div>
      <Problem
        problem={move.isError ? whyNotMoved(move.error) : null}
        title="The Merchant was not moved."
      />
    </form>
  );
}

/**
 * Why kobai turned the move back, in words a Merchant can act on.
 *
 * Exhaustive over `MerchantRefusal`, and the `never` is what keeps it so — the same family
 * {@link whyNotCreated} narrows, because creating a colleague and moving one are refused by one
 * closed set (ADR-0063).
 */
function whyNotMoved(thrown: unknown): string {
  const fallback = "The Merchant was not moved.";
  const reason = merchantReasonOf(thrown);

  switch (reason) {
    case "last-administrator":
      // The one refusal here that is about the deployment rather than about this row, and the
      // sentence has to say what to do: somebody else has to be able to administer Merchants
      // before this one may stop. Both halves of that are reachable — a Role is given the
      // Permission on Roles, and a holder is either added below or moved here.
      return `This is the only Merchant who can administer Merchants, so moving them onto a Role without "${PERMISSIONS.merchantWrite}" would leave nobody who could move them back — and no way in short of the database. Give another Role that Permission on Roles, put somebody on it, and then come back.`;

    case "unknown-role":
      return "This deployment has no Role by that name any more — it was renamed or deleted since this list was read. Reload, and choose again.";

    case "merchant-not-found":
      return "kobai has no Merchant at that address any more. Reload the list.";

    case "email-taken":
      // A creation's refusal: this route sends no address and could not earn it.
      return problemOf(thrown, fallback);

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

/** A page of Merchants, before there is one. */
function MerchantsLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the Merchants">
      {["first", "second"].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * Whether the address is already a Merchant's, whether the password is long enough, whether the
 * Role still exists: each of those is a rule in Core that may change there, and each arrives as
 * a refusal rather than as a second copy of the rule in a browser.
 *
 * **The Role is required here although the API defaults it**, and that is the one departure
 * worth arguing. `CreateMerchantRequest` says "Defaults to `owner`" — the same kind of
 * documented default the Fulfilment Strategy picker deliberately agrees with — but `owner` is
 * every Permission Core defines, so a form that quietly submitted it would make the most
 * powerful Role in the deployment the one a Merchant gets by not choosing. A default that hands
 * out everything is one to make somebody type.
 */
const NewMerchantForm = z.object({
  email: z.string().min(1, "A Merchant signs in with an email address, so it needs one."),
  password: z.string().min(1, "A Merchant signs in with a password, so it needs one."),
  role: z.string().min(1, "Choose the Role this colleague is created against."),
});

type NewMerchantValues = z.infer<typeof NewMerchantForm>;

/**
 * A colleague, created against a Role.
 *
 * There is no way to set a Merchant's password from here afterwards and no route that would
 * let one — so what this creates is an account somebody is handed, which is worth saying on the
 * screen rather than leaving to be discovered.
 */
function NewMerchant() {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.merchantWrite, "add a Merchant");

  const form = useForm<NewMerchantValues>({
    resolver: zodResolver(NewMerchantForm),
    defaultValues: { email: "", password: "", role: "" },
  });

  const create = useMutation({
    mutationFn: async (values: NewMerchantValues) =>
      orThrow(await client.POST("/admin/merchants", { body: values })),
    onSuccess: () => form.reset(),
    onSettled: () => queries.invalidateQueries({ queryKey: [MERCHANTS] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a Merchant</CardTitle>
        <CardDescription>
          A colleague signs in with what is entered here — nothing sends it to them, and
          no route changes it afterwards, so this is a password to hand over rather than
          one they choose.
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => create.mutate(values))}>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Problem
            className="sm:col-span-3"
            problem={create.isError ? whyNotCreated(create.error) : null}
            title="The Merchant was not created."
          />
          <FormField
            id="new-merchant-email"
            label="Email"
            type="email"
            // Not `username`: the browser would otherwise offer the Merchant filling this in
            // their *own* address, which is the one colleague they cannot be adding.
            autoComplete="off"
            error={form.formState.errors.email}
            {...form.register("email")}
          />
          <FormField
            id="new-merchant-password"
            label="Password"
            type="password"
            autoComplete="new-password"
            error={form.formState.errors.password}
            {...form.register("password")}
          />
          <RoleField id="new-merchant-role" control={form.control} name="role" />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton
            type="submit"
            unavailable={unavailable}
            disabled={create.isPending}
          >
            {create.isPending ? <Spinner /> : null}
            Add Merchant
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * How many pages of Roles the picker below will read before it stops.
 *
 * A cursor-paged list has no "give me all of it", so a picker over one either walks it or lies
 * about the set — and a walk with no bound is a screen that hangs on a deployment somebody has
 * scripted ten thousand Roles into. This is the bound, and **the field says so when it is
 * reached**: a truncated list that looked complete would be a Merchant unable to find a Role
 * that exists, with nothing on screen to explain it.
 */
const MOST_ROLE_PAGES = 10;

/** Every Role this deployment has, and whether that is really all of them. */
const EVERY_ROLE = "every-role";

function useEveryRole() {
  const client = useKobaiClient();

  return useQuery({
    queryKey: [EVERY_ROLE],
    queryFn: async (): Promise<{ roles: Role[]; complete: boolean }> => {
      const roles: Role[] = [];
      let after: string | undefined;

      for (let page = 0; page < MOST_ROLE_PAGES; page += 1) {
        const answered = orThrow(
          await client.GET("/admin/roles", {
            params: { query: after === undefined ? {} : { after } },
          }),
        );
        roles.push(...answered.roles);
        // Absent is the only end-of-list signal there is — a short page is not one (ADR-0064).
        if (answered.nextCursor === undefined) return { roles, complete: true };
        after = answered.nextCursor;
      }

      return { roles, complete: false };
    },
  });
}

/**
 * Which Role a colleague is created against, or moved onto — a choice among the ones this
 * deployment has.
 *
 * **A picker rather than a text field, and only because the API can answer.** It is the same
 * judgement `FulfilmentStrategyField` makes: whether a name is one of the Roles is not a rule
 * the Admin is deciding, it is a list kobai handed over, and a Role deleted or renamed between
 * this read and the submit is still attempted and still refused with `unknown-role`. That is
 * what keeps it an affordance.
 *
 * **The listbox is `components/listbox-field.tsx`** (#245), which is where `useController` and
 * the rest of the Base UI composition live — this field is the second one over a set kobai
 * names, and the two spelled it out identically until there was somewhere to spell it once.
 * Two of the things that component decides on this field's behalf matter here in particular.
 * A Role the list does not carry is still **offered**, because an option is what a Merchant
 * sees selected and can come back to — harmless for a create, where there is no value until
 * somebody chooses, and the whole point on a row of the roster, where the value is a Role the
 * Merchant *does* hold; it is reachable two ways and both are ordinary, the list still being in
 * flight or the Role sitting past the {@link MOST_ROLE_PAGES} this picker reads. And the form
 * holds `""` for the untouched field, which the schema refuses and the picker shows its
 * placeholder for — asserted in the browser, because "no Role is chosen yet" reading as an
 * empty box would be a control a Merchant cannot name.
 *
 * **A failed read blocks nothing that is not already blocked**: the field goes unavailable and
 * says what kobai said, and there is nothing useful to submit without it, because the Role is
 * required.
 *
 * **`label` and `quiet` are what let one field serve a card and a table cell** (#202). A row of
 * the roster has a column heading already and one repeated label per row would be noise — but a
 * column heading is not programmatically the label of a control inside a cell, so the label is
 * still rendered and still associated, `sr-only`. `quiet` drops the standing description for the
 * same reason and **keeps the exceptional ones**: a failed read and a truncated list are things
 * a Merchant has to be told wherever the field is, and hiding those would make the picker lie
 * about the set in the one place it was hidden.
 */
function RoleField<T extends FieldValues>({
  id,
  control,
  name,
  label = "Role",
  quiet = false,
}: {
  readonly id: string;
  readonly control: Control<T>;
  readonly name: Path<T>;
  /** What the field is called. Rendered `sr-only` whenever {@link quiet} is set. */
  readonly label?: string;
  /** Say nothing under the field unless there is something exceptional to say. */
  readonly quiet?: boolean;
}) {
  const roles = useEveryRole();
  const note = roleFieldNote(roles);

  return (
    <ListboxField
      id={id}
      control={control}
      name={name}
      label={label}
      quiet={quiet}
      options={(roles.data?.roles ?? []).map((role) => ({
        value: role.name,
        label: role.name,
      }))}
      placeholder="Choose a Role"
      description={quiet && !note.exceptional ? undefined : note.said}
      disabled={roles.isError}
    />
  );
}

/**
 * What to say under the picker: what went wrong, what was left out, or what it is for.
 *
 * `exceptional` marks the first two — the ones a `quiet` field still has to render, because each
 * says the list on screen is not the set kobai has.
 */
function roleFieldNote(roles: ReturnType<typeof useEveryRole>): {
  readonly said: string;
  readonly exceptional: boolean;
} {
  if (roles.isError) {
    return {
      said: problemOf(roles.error, "kobai did not say which Roles it has."),
      exceptional: true,
    };
  }
  if (roles.data?.complete === false) {
    return {
      said: `This deployment has more Roles than the first ${MOST_ROLE_PAGES} pages of them, so this list is not all of them. Roles is where the rest are.`,
      exceptional: true,
    };
  }
  return {
    said: "What this colleague may do. Roles is where one is made or changed.",
    exceptional: false,
  };
}

/**
 * Why kobai turned the creation back, in words a Merchant can act on.
 *
 * Exhaustive over `MerchantRefusal`, and the `never` is what keeps it so: a reason added to
 * that family in Core has no arm here and reddens this build in the same commit (ADR-0063).
 */
function whyNotCreated(thrown: unknown): string {
  const fallback = "The Merchant could not be created.";
  const reason = merchantReasonOf(thrown);

  switch (reason) {
    case "email-taken":
      return "A Merchant already signs in with that address. An address identifies a Merchant, so this colleague needs their own.";

    case "unknown-role":
      return "This deployment has no Role by that name any more — it was renamed or deleted since this list was read. Reload, and choose again.";

    case "merchant-not-found":
    case "last-administrator":
      // A move's refusals, and neither is reachable from a creation: this route addresses no
      // Merchant and takes nobody's Permission away. Reported as kobai said it rather than as a
      // sentence written here for a case nobody has seen.
      return problemOf(thrown, fallback);

    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows — the
      // password's minimum length in particular, which is Core's rule and not this form's.
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
