import type { Order, OrderAddress } from "@kobai/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReceiptTextIcon } from "lucide-react";
import { Fragment } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { FulfilmentStateBadge } from "@/components/fulfilment-state-badge";
import { LinkButton } from "@/components/link-button";
import { PaymentBadge } from "@/components/payment-badge";
import { Problem } from "@/components/problem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCrumbTitle } from "@/lib/crumb";
import { formatAmount } from "@/lib/money";
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import {
  fulfilmentReasonOf,
  orderReasonOf,
  orThrow,
  problemOf,
} from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";

/**
 * One Order, opened — its Line Items, its Adjustments, its totals and its Payment (story 57).
 *
 * Every field here is a **snapshot**: the title and the SKU are what they were at Capture, not
 * what the catalog says now, because renaming a Product must not rewrite history and deleting a
 * Variant must not destroy this record (ADR-0009). So nothing on this screen links back into
 * the catalog — what it shows is the Order, whole.
 *
 * An Adjustment is a line rather than a number folded into an amount (ADR-0022), so it is shown
 * as one: the unit amount still says what one of the thing cost, and the line's total is what it
 * came to with the discounts and surcharges accounted for.
 *
 * **An Order never changes, and the query is still an ordinary one** — no `staleTime` of its
 * own. Immutability is Core's promise about the record, not a licence for the Admin to hold a
 * copy of it forever: a Merchant who reloads is asking kobai, and a cache that answered from
 * ADR-0009 would be the Admin re-implementing a rule it does not own (ADR-0063).
 */
const ORDER = "order";

export function OrderScreen() {
  const client = useKobaiClient();
  const id = useRouteId();

  const order = useQuery({
    queryKey: [ORDER, id],
    queryFn: async () =>
      orThrow(await client.GET("/admin/orders/{id}", { params: { path: { id } } })),
  });

  // "#1043" rather than the identifier out of the URL, because the number is what a Shopper
  // quotes and the identifier is what nobody reads aloud.
  useCrumbTitle(order.data === undefined ? undefined : `#${order.data.number}`);

  if (order.isPending) return <OrderLoading />;

  if (order.isError) {
    return isNoSuchOrder(order.error) ? (
      <NoSuchOrder />
    ) : (
      <Problem
        title="That Order could not be read."
        problem={problemOf(order.error, "kobai did not answer.")}
      />
    );
  }

  const placed = order.data;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* An `h2`: the frame renders the page's `h1` from the route, so this is the record's
            own heading under the section's rather than a second first-level one. */}
        <h2 className="font-medium text-xl">Order #{placed.number}</h2>
        <PaymentBadge payment={placed.payment} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What was bought</CardTitle>
          <CardDescription>
            As it was described and priced at Capture. The catalog has been free to change
            ever since, and none of it reaches these lines.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {placed.lineItems.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="font-medium">
                    {line.title}
                    {line.adjustments.map((adjustment) => (
                      <div className="text-muted-foreground text-xs" key={adjustment.id}>
                        {adjustment.description}{" "}
                        {formatAmount(adjustment.amount, placed.currency)}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell>
                    <code>{line.sku}</code>
                  </TableCell>
                  <TableCell>{formatAmount(line.unitAmount, placed.currency)}</TableCell>
                  <TableCell>{line.quantity}</TableCell>
                  <TableCell>{formatAmount(line.tax, placed.currency)}</TableCell>
                  <TableCell>{formatAmount(line.total, placed.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What it came to</CardTitle>
          <CardDescription>
            An Adjustment belonging to no single line — a basket-wide voucher, say — is
            listed here rather than folded into the figure.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {placed.adjustments.map((adjustment) => (
            <Fragment key={adjustment.id}>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{adjustment.description}</span>
                <span>{formatAmount(adjustment.amount, placed.currency)}</span>
              </div>
              {/*
               * An Order-level Adjustment carries its own tax, because there is no line whose
               * tax could carry it — a delivery surcharge is taxable and belongs to no line.
               * Shown only when there is some: this deployment's tax Step decides, and Core
               * charges none, so a row of zeroes would be noise on every Order.
               */}
              {adjustment.tax !== 0 && (
                <div className="flex justify-between pl-4">
                  {/* Just "Tax": the description beside it is the Merchant's own text, and
                      composing a sentence out of it would mangle a proper noun. */}
                  <span className="text-muted-foreground">Tax</span>
                  <span>{formatAmount(adjustment.tax, placed.currency)}</span>
                </div>
              )}
            </Fragment>
          ))}
          <div className="flex justify-between font-medium">
            <span>Total</span>
            <span>{formatAmount(placed.total, placed.currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Shopper</span>
            <span>{placed.shopper?.email ?? "guest"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Placed</span>
            <span>{new Date(placed.createdAt).toLocaleString()}</span>
          </div>
        </CardContent>
      </Card>

      <Fulfilments
        orderId={placed.id}
        fulfilments={placed.fulfilments}
        lineItems={placed.lineItems}
      />

      <Card>
        <CardHeader>
          <CardTitle>Where it goes</CardTitle>
          <CardDescription>
            The delivery address as it was given at Capture. Correcting it since has not
            reached this, and neither has deleting the Region it named.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {placed.address === null ? (
            <p className="text-muted-foreground">
              No address was given for this Order, so kobai holds no destination for it at
              all.
            </p>
          ) : (
            <>
              {/* An address, laid out as an address rather than as a table of fields: the
                  lines are in the order the Shopper wrote them, because no two countries
                  agree on what the parts are (ADR-0072). One text node with the breaks in
                  it rather than an element per line — the same address twice over is a
                  thing a Shopper may genuinely write, and there is no identifier here to
                  key the second copy by. */}
              <address className="whitespace-pre-line not-italic">
                {addressLines(placed.address)}
              </address>
              {placed.address.region === null ? null : (
                <div className="flex justify-between">
                  {/* The name taken at Capture. It is deliberately not a link: the Region
                      may have been deleted since, and this record says where the parcel
                      went rather than what the Store's geographies are now. */}
                  <span className="text-muted-foreground">Region</span>
                  <span>{placed.address.region.name}</span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
          <CardDescription>
            What kobai was told about the money. The reference is the provider's own
            handle on it — quote it there, not here.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {placed.payment === null ? (
            <p className="text-muted-foreground">
              No Payment is recorded against this Order, so kobai holds no account of the
              money for it at all.
            </p>
          ) : (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Provider</span>
                <span>{placed.payment.provider}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Reference</span>
                <code className="break-all">{placed.payment.reference}</code>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span>
                  {formatAmount(placed.payment.amount, placed.payment.currency)}
                </span>
              </div>
              {placed.payment.received ? null : (
                // The whole point of the distinction, said in words as well as in a badge:
                // this provider arranged the money and did not take it.
                <p className="text-muted-foreground">
                  This payment was arranged rather than taken — the money has not arrived,
                  and collecting it happens outside kobai.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * **How this Order gets to the Shopper, and the controls that move it** (#320, ADR-0014).
 *
 * One card per Fulfilment rather than one row per Order, because an Order has as many as it has
 * ways of being delivered and they are on independent timelines: a mixed Order ships a poster and
 * emails a PDF, and dispatching the first leaves the second exactly where it was. There is no
 * status on the Order itself and there must never be one — that is the argument this whole
 * feature exists to keep true, and a card that summarised the parts into one word would be it
 * arriving in the client instead.
 *
 * Three things about the controls are decisions rather than implementation.
 *
 * **All three are offered on every Fulfilment**, whatever state it is in, and the refusal is
 * rendered where it was attempted. That is `ConfirmDelete`'s bargain (#179) reached by a second
 * road: which transitions are legal is Core's table and is **not published on the wire**, so a
 * copy here would be a second answer to a question this Admin cannot see change — and it would
 * go stale in silence rather than reddening the build the way a closed `reason` set does. So the
 * Admin attempts and shows what kobai said.
 *
 * **Each is an `ActionButton`**, so a Merchant whose Role holds `order:read` and not
 * `fulfilment:write` sees the controls, cannot use them, and is told which word to ask a
 * colleague for (ADR-0063). That Role is exactly the one the Permission was split out for.
 *
 * **The tracking reference is a field on the dispatch and on nothing else.** It is optional,
 * because a download has nothing to track, and kobai parses nothing out of it — so the schema
 * below checks its shape and no more, which here means checking nothing at all.
 */
function Fulfilments({
  orderId,
  fulfilments,
  lineItems,
}: {
  readonly orderId: string;
  readonly fulfilments: Order["fulfilments"];
  readonly lineItems: Order["lineItems"];
}) {
  return (
    <Card>
      <CardHeader>
        {/* A plain `CardTitle`, like the four cards beside it on this screen. The Product
            screen's cards carry an `h3` and these do not, and putting one on only this card
            would produce an outline with a single navigable section in it — which is worse
            than none. Whether this screen should have the outline at all is a question about
            the screen rather than about this card. */}
        <CardTitle>How it gets there</CardTitle>
        <CardDescription>
          One entry per way this Order is delivered, each on its own timeline. There is no
          status on the Order itself: a parcel and an emailed file do not share a lifecycle,
          so dispatching one leaves the other exactly where it was.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {fulfilments.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            This Order records no Fulfilments at all, which is what an Order placed before
            kobai modelled them reads as. Nothing here can be moved.
          </p>
        ) : (
          fulfilments.map((fulfilment) => (
            <FulfilmentControls
              key={fulfilment.id}
              orderId={orderId}
              fulfilment={fulfilment}
              lineItems={lineItems}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The shape of the dispatch form, and only the shape (ADR-0063).
 *
 * There is nothing to check. A tracking reference is an **opaque** string kobai stores and reads
 * nothing out of, and it is optional — so a schema that demanded a format would be this Admin
 * inventing a rule kobai does not have, and would refuse a Merchant whose carrier numbers it had
 * not heard of.
 */
const DispatchForm = z.object({ trackingReference: z.string() });

type DispatchValues = z.infer<typeof DispatchForm>;

/** One Fulfilment: what it is, where it has got to, and the three things a Merchant can do. */
function FulfilmentControls({
  orderId,
  fulfilment,
  lineItems,
}: {
  readonly orderId: string;
  readonly fulfilment: Order["fulfilments"][number];
  readonly lineItems: Order["lineItems"];
}) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.fulfilmentWrite, "move a Fulfilment");

  const form = useForm<DispatchValues>({
    resolver: zodResolver(DispatchForm),
    defaultValues: { trackingReference: fulfilment.trackingReference ?? "" },
  });

  const move = useMutation({
    /**
     * One call per action, with the path written out.
     *
     * A single call with the verb interpolated would typecheck and is exactly what
     * `tests/admin-uses-only-the-public-api.test.ts` forbids: that sweep reads **quoted path
     * literals**, so a composed path would make it silently blind to this screen.
     */
    mutationFn: async (asked: {
      readonly to: FulfilmentAction;
      readonly reference: string;
    }) => {
      const params = { path: { id: orderId, fulfilmentId: fulfilment.id } };

      switch (asked.to) {
        case "dispatch":
          return orThrow(
            await client.POST("/admin/orders/{id}/fulfilments/{fulfilmentId}/dispatch", {
              params,
              // Blank means the Merchant recorded none, which is a real answer rather than an
              // empty string: kobai's field is optional and `null` is what it stores.
              body: asked.reference === "" ? {} : { trackingReference: asked.reference },
            }),
          );

        case "deliver":
          return orThrow(
            await client.POST("/admin/orders/{id}/fulfilments/{fulfilmentId}/deliver", {
              params,
            }),
          );

        case "cancel":
          return orThrow(
            await client.POST("/admin/orders/{id}/fulfilments/{fulfilmentId}/cancel", {
              params,
            }),
          );

        default: {
          // Unreachable, and it is the compiler that says so.
          const unreached: never = asked.to;
          return unreached;
        }
      }
    },
    // Read back rather than patched in: there is no optimistic update anywhere in this Admin
    // (ADR-0063), and where a Fulfilment has got to is kobai's answer.
    onSettled: () => queries.invalidateQueries({ queryKey: [ORDER, orderId] }),
  });

  const covered = lineItems.filter((line) => fulfilment.lineItemIds.includes(line.id));

  return (
    // No guard of its own: Enter in the field is implicit submission, which a browser performs
    // by clicking this form's default button — the Dispatch `ActionButton`, whose handler is the
    // no-op for a Merchant who may not move anything.
    <form
      className="grid gap-4 rounded-lg border p-4"
      onSubmit={form.handleSubmit((values) =>
        move.mutate({ to: "dispatch", reference: values.trackingReference }),
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          {/* The Strategy's name as kobai holds it — a snapshot of what this was fulfilled by,
              which is deliberately an open set and so is rendered rather than translated. */}
          <code className="text-sm">{fulfilment.strategy}</code>
          <span className="text-muted-foreground text-xs">
            {covered.length === 0
              ? "No line of this Order is recorded against it."
              : covered.map((line) => line.sku).join(", ")}
          </span>
        </div>
        <FulfilmentStateBadge state={fulfilment.state} />
      </div>

      <Problem
        problem={move.isError ? whyItDidNotMove(move.error) : null}
        title="That Fulfilment did not move."
      />

      <FormField
        id={`fulfilment-${fulfilment.id}-tracking`}
        label="Tracking reference"
        placeholder="RR123456789MY"
        description="Optional, and recorded when you dispatch. kobai stores it and reads nothing out of it, so anything your carrier gave you will do."
        error={form.formState.errors.trackingReference}
        {...form.register("trackingReference")}
      />

      <div className="flex flex-wrap gap-2">
        <ActionButton type="submit" unavailable={unavailable} disabled={move.isPending}>
          {move.isPending ? <Spinner /> : null}
          Dispatch
        </ActionButton>
        <ActionButton
          type="button"
          variant="outline"
          unavailable={unavailable}
          disabled={move.isPending}
          onClick={() => move.mutate({ to: "deliver", reference: "" })}
        >
          Mark delivered
        </ActionButton>
        <ActionButton
          type="button"
          variant="outline"
          unavailable={unavailable}
          disabled={move.isPending}
          onClick={() => move.mutate({ to: "cancel", reference: "" })}
        >
          Cancel
        </ActionButton>
      </div>
    </form>
  );
}

/** The three things a Merchant can ask for, named as the routes are. */
type FulfilmentAction = "dispatch" | "deliver" | "cancel";

/**
 * Why kobai would not move it, in words a Merchant can act on.
 *
 * Exhaustive over `FulfilmentRefusal`, so a reason added to that family in Core has no arm here
 * and reddens this build in the same commit (ADR-0063). **Four of the arms are the four states**,
 * and each says the repair rather than only what happened — which is the whole value of the
 * Admin offering all three controls and letting kobai decide.
 */
function whyItDidNotMove(thrown: unknown): string {
  const reason = fulfilmentReasonOf(thrown);

  switch (reason) {
    case "fulfilment-pending":
      return "This part has not been dispatched yet, so it cannot be marked delivered. Dispatch it first — something handed over the counter was still dispatched.";

    case "fulfilment-dispatched":
      return "This part has already been dispatched. Mark it delivered when it arrives, or cancel it if it cannot be.";

    case "fulfilment-delivered":
      return "This part has already been delivered, and that is where its record ends. Sending something else is a new Order; giving money back is a Return.";

    case "fulfilment-cancelled":
      return "This part has been cancelled and cannot be moved again. Sending a replacement is a new Order.";

    case "fulfilment-not-found":
      return "This Order no longer has that Fulfilment. Reload the Order to see what it does have.";

    case "order-not-found":
      return "This Store has taken no Order at that address, so there is nothing here to move.";

    case "invalid":
    case "malformed-body":
      // Reachable only from a build sending something kobai will not read: the form checks the
      // shape and there is nothing about a tracking reference to get wrong.
      return "kobai could not read that request. Reload the Order and try again.";

    case undefined:
      return problemOf(thrown, "kobai did not answer.");

    default: {
      // Unreachable, and it is the compiler that says so.
      const unreached: never = reason;
      return unreached;
    }
  }
}

/**
 * The destination as one block of text, in the order it should be read.
 *
 * The postal code and the country go last because that is where kobai puts them and not because
 * it is where any particular country does — the lines above are the Shopper's own and are never
 * rearranged. `country` is the code as kobai holds it (ADR-0072): naming it would mean a table of
 * countries in this tree, which is the closed set kobai deliberately does not hold either.
 */
function addressLines(address: OrderAddress): string {
  return [...address.lines, address.postalCode, address.country]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * The Order, before it is there.
 *
 * Four blocks, because four cards are coming. Announced as a status so that a Merchant
 * whose screen is being read to them is told the page is working rather than left in silence.
 */
function OrderLoading() {
  return (
    <div className="grid gap-6" role="status" aria-label="Reading the Order">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/**
 * An address naming an Order this Store never took.
 *
 * Its own screen rather than a red box, because the action is "go back to the list" and a
 * Merchant following somebody's link has nothing else to do. An Order is never deleted
 * (ADR-0009), so this is a mistyped or stale address rather than something that used to work.
 */
function NoSuchOrder() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ReceiptTextIcon />
        </EmptyMedia>
        <EmptyTitle>No such Order</EmptyTitle>
        <EmptyDescription>
          This Store has taken no Order at that address. An Order is never deleted, so
          this address has always been wrong rather than having stopped working.
        </EmptyDescription>
      </EmptyHeader>
      <LinkButton to="/orders">Go to Orders</LinkButton>
    </Empty>
  );
}

/**
 * Whether kobai said there is no such Order, as against anything else going wrong.
 *
 * Narrowed rather than read out of the prose, and exhaustive over `OrderRefusal` — a second
 * reason added to that family in Core has no arm here and reddens this build in the same
 * commit, rather than quietly showing "No such Order" for something else (ADR-0063).
 */
function isNoSuchOrder(thrown: unknown): boolean {
  const reason = orderReasonOf(thrown);

  switch (reason) {
    case "order-not-found":
      return true;

    case undefined:
      // A 500, which carries no `reason` on purpose, a refusal from one of the gates above
      // this route, or the network being gone.
      return false;

    default: {
      // Unreachable, and it is the compiler that says so.
      const unreached: never = reason;
      return unreached;
    }
  }
}
