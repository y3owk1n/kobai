import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * A refusal, shown to a Merchant.
 *
 * Every screen has one of these and they were all the same three lines. Having one means the
 * Admin says "that did not work" in one voice, and that a screen with something better to say
 * has to pass a `title` rather than quietly reword the common case.
 *
 * `problem` is the prose off the refusal (`messageOf`), never its `reason`: a `reason` is for
 * a program to branch on and reads as noise to a person.
 */
export function Problem({
  problem,
  title = "That did not work.",
  className,
}: {
  /** `null` renders nothing, so a caller can pass its state straight in. */
  readonly problem: string | null;
  readonly title?: string;
  readonly className?: string;
}) {
  if (problem === null) return null;

  return (
    <Alert variant="destructive" className={className}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{problem}</AlertDescription>
    </Alert>
  );
}
