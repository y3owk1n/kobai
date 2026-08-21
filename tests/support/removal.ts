import { rm } from "node:fs/promises";

/**
 * Removing the temporary directories a test made, when something else may still be writing
 * into one of them.
 *
 * This is #313's answer, and it is the **only** copy of it: every caller imports `removeAll`
 * rather than spelling the policy again. Three do — `packages/create-kobai/src/scaffold.test.ts`,
 * where the flake was found, and `tests/the-ports-belong-to-the-checkout.test.ts` and
 * `tests/a-worktree-seeds-its-own-env.test.ts`, which had the same bug verbatim. A teardown
 * policy spelled three ways is one the next person gets wrong.
 *
 * **A package's test reaching in here is an ordinary import, not a second `include`.** The
 * root `tsconfig.json` warns against typechecking one file under two configs, and that is
 * about *root* files: two `include` globs claiming the same path, which drift because each
 * config decides its own options. A file pulled in as a **dependency** is the arrangement this
 * repository already runs on — `reference/src` typechecks `packages/core/src` every time,
 * through the `paths` in `tsconfig.base.json` — and every config here extends that same base,
 * so there is one set of options to disagree about. Nothing is added to any `include`, and
 * `packages/create-kobai/tsconfig.build.json` excludes `*.test.ts`, so this module reaches no
 * package's emit.
 */

/**
 * How hard the teardown tries before it calls a directory stuck.
 *
 * Node backs off linearly — 50ms, then 100, then 150 — so a directory that keeps refilling is
 * retried for a little under three seconds before it is given up on: far longer than a
 * background repack of a hundred-odd objects, and well inside the 30-second hook budget
 * `vitest.config.ts` sets, so a directory nothing will ever release still fails inside the run
 * rather than hanging it.
 *
 * **Measured rather than reasoned about**, on the same shape #329 sized these against: a
 * subprocess writing a file a millisecond into an `objects/` directory while `rm` sweeps it
 * fails with `ENOTEMPTY` at Node's default of no retries, three runs out of three, and goes
 * through {@link removeAll} after about 1.5 seconds of retrying.
 */
const REMOVAL_RETRIES = 10;
const REMOVAL_RETRY_DELAY_MS = 50;

/**
 * Removes one directory, or explains which one it could not remove.
 *
 * `force` is not what its name suggests: it suppresses a path that **does not exist** and
 * retries nothing, so the first `ENOTEMPTY` propagates. `maxRetries` is Node's option for the
 * transient family — `ENOTEMPTY`, `EBUSY`, `EPERM`, `EMFILE`, `ENFILE` — and this is the case
 * it exists for, because a directory handed to this module is one something else may still be
 * writing into (#313).
 *
 * **What retrying is for here is a writer no caller holds a handle to.** Every caller makes a
 * git repository and commits into it, and `git commit` ends by
 * spawning `git maintenance run --auto --detach`, which is *detached* by design, and it
 * inspects — and, when it decides the repository wants it, repacks — `.git/objects` after the
 * command that started it has already exited. A directory read as empty a moment ago
 * therefore has an entry in it before the `rmdir` lands, which is the
 * `ENOTEMPTY … rmdir '…/objects'` that failed #312's run in teardown with every one of that
 * file's tests already green. Waiting for that process is not something a caller of `git` is
 * offered, so retrying the removal is the whole of the answer. **A process a caller *can*
 * wait for is a different bug and wants a different fix** — `startLocalRegistry`'s `close` in
 * `./local-registry.ts` is that case, and it waits rather than retrying.
 *
 * A directory that survives every retry is not a flake and is not swallowed: it fails the
 * suite. It throws rather than returning, so {@link removeAll} can report every stuck
 * directory at once, and the message names the directory — `rm` names only the entry it
 * tripped on, a path several levels inside a random temporary directory — while `cause` keeps
 * `rm`'s own error, errno and syscall for whoever has to go and look.
 */
async function removeOne(path: string): Promise<void> {
  try {
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: REMOVAL_RETRIES,
      retryDelay: REMOVAL_RETRY_DELAY_MS,
    });
  } catch (cause) {
    throw new Error(
      `${path} — ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Removes every directory it is given, and fails naming the ones that would not go.
 *
 * `allSettled` rather than `all`: one directory that will not go must not take the removal of
 * the others with it, nor hide which of them were also stuck. `all` rejects on the first
 * failure, which is how one racy directory came to fail a whole file — and a `for` loop, which
 * is what the two callers under `tests/` used to do, abandons every path after the one that
 * threw.
 *
 * **The failure path was watched failing** against two directories made deliberately
 * unremovable: both are named in one `AggregateError`, the removable one beside them is still
 * removed, and each error arrives carrying `rm`'s `code`, `syscall` and `path` as its `cause`.
 */
export async function removeAll(paths: readonly string[]): Promise<void> {
  const outcomes = await Promise.allSettled(paths.map(removeOne));

  const stuck = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as Error] : [],
  );

  if (stuck.length > 0) {
    // An `AggregateError` because that is what it is: every directory that would not go is in
    // it, each still carrying `rm`'s own error — errno, syscall and the entry it tripped on —
    // rather than flattened into a string on the way past. The message says the same thing for
    // a reporter that prints only that.
    throw new AggregateError(
      stuck,
      `${stuck.length} temporary director${stuck.length === 1 ? "y is" : "ies are"} still on disk:\n${stuck.map((error) => error.message).join("\n")}`,
    );
  }
}
