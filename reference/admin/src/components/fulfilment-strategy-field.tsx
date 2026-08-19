import { useQuery } from "@tanstack/react-query";
import type { Control, FieldValues, Path } from "react-hook-form";
import { ListboxField } from "@/components/listbox-field";
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The Strategies this deployment has wired, read once and shared by every field below.
 *
 * `GET /admin/fulfilment-strategies` is ADR-0067's route, and it exists because of this screen:
 * a Variant points at a Strategy *by name*, the set is open by design (ADR-0014), and until
 * #179 nothing on the surface could say what the names were. The Admin was left with a text
 * box and a refusal, or with `physical` and `digital` hard-coded — which is the closed set
 * ADR-0014 exists to prevent, written into the client instead of into the schema, and wrong on
 * the first deployment that wires a Plugin's Strategy.
 *
 * The set cannot change while the Project is running, so this is read once and never
 * invalidated by anything. `staleTime: Infinity` says that rather than leaving it to look like
 * an oversight: a restart is a new page load.
 */
const FULFILMENT_STRATEGIES = "fulfilment-strategies";

export function useFulfilmentStrategies() {
  const client = useKobaiClient();

  return useQuery({
    queryKey: [FULFILMENT_STRATEGIES],
    queryFn: async () => orThrow(await client.GET("/admin/fulfilment-strategies")),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Which Strategy a Variant is delivered by — a choice among the ones this deployment has.
 *
 * **A picker rather than a text field, and only because the API can answer.** ADR-0063's rule
 * against predicting refusals is about *rules*, not about vocabularies: whether a name is one
 * of the wired ones is not a judgement the Admin is making, it is a list kobai handed over. A
 * name unwired between this read and the submit is still attempted and still refused with
 * `unknown-fulfilment-strategy`, which is what keeps this an affordance.
 *
 * **The listbox itself is `components/listbox-field.tsx`** (#245), which is where the Base UI
 * composition this used to spell out lives — `items`, the `SelectGroup`, `null` for nothing
 * selected, and `useController`, because a listbox is not an `<input>` and cannot be
 * `register`ed. What is left here is the part that is genuinely this field's: which list it is,
 * and what to say under it. Getting to a `Select` at all took a fix in the frame rather than a
 * different control — Base UI portals the list out of the card it was opened from, which by
 * default means `<body>`, outside every landmark and a `region` violation the moment a browser
 * case audits a screen with it open, so `lib/portal.tsx` offers a container inside `main`. A
 * native `<select>` was the other way out and was rejected: it would have been the one control
 * in this Admin that shadcn did not draw, and the landmark problem would still have been
 * waiting for the next menu or popover.
 *
 * **A failed read blocks nothing.** The field goes unavailable and says so, and the form around
 * it still submits — `fulfilment` is optional on both routes that take it, so correcting a SKU
 * does not stop because a second request did.
 */
export function FulfilmentStrategyField<T extends FieldValues>({
  id,
  control,
  name,
  description,
}: {
  readonly id: string;
  readonly control: Control<T>;
  readonly name: Path<T>;
  readonly description?: string;
}) {
  const strategies = useFulfilmentStrategies();
  const wired = strategies.data?.strategies ?? [];

  /**
   * Whether "this deployment does not have that Strategy" is a thing we actually know.
   *
   * **Only once the read succeeded.** While it is in flight `wired` is empty, so every Variant
   * looks unwired — and labelling an ordinary `physical` one "not wired here" for the length of
   * a round trip announces exactly the broken state this screen exists to *repair*, about a
   * Variant that is fine. A failed read is the same mistake made permanently.
   */
  const known = strategies.isSuccess;

  return (
    <ListboxField
      id={id}
      control={control}
      name={name}
      label="Fulfilment Strategy"
      options={wired.map((strategy) => ({
        value: strategy.name,
        label: strategy.name,
      }))}
      // The Strategy the Variant points at is offered whether or not the list carries it, so the
      // picker can show and stay on it — named "not wired here" only once {@link known}, because
      // until then every Variant looks unwired.
      unlisted={(strategy) => (known ? `${strategy} — not wired here` : strategy)}
      description={
        strategies.isError
          ? problemOf(strategies.error, "kobai did not say which Strategies it has.")
          : (description ??
            "What a Variant is delivered by. This deployment wired these; a Plugin's is added in the Project's kobai.config.ts.")
      }
      disabled={strategies.isError}
    />
  );
}
