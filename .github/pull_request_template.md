<!--
Keep this short. The diff says what changed; this says why, and what a reviewer should
be suspicious of.
-->

## What and why

<!-- One or two sentences. What problem does this solve? -->

Closes #

## How it was verified

<!--
What did you actually run? Name the tests, the command, the manual check. "Tests pass"
without saying which ones is not verification.
-->

## Notes for the reviewer

<!--
Anything you're unsure about, a tradeoff you made deliberately, or a decision that
contradicts an existing ADR under docs/adr/ — flag it here rather than leaving it to be
discovered.
-->

## Checklist

- [ ] Behavior is covered by a test that failed before this change.
- [ ] Domain terms match `CONTEXT.md` (if it exists yet).
- [ ] Any hard-to-reverse decision here is recorded as an ADR under `docs/adr/`.
- [ ] No secrets, tokens, or customer data in the diff.
