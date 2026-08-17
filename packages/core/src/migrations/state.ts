import type { AppliedMigrationSet } from "./run.ts";

/**
 * Where the application is in its migration lifecycle.
 *
 * This exists so a booting instance is distinguishable from a broken one. Without it, both
 * look identical from outside: a request that does not succeed.
 */
export type MigrationState =
  | { readonly status: "pending" }
  | { readonly status: "running" }
  | { readonly status: "applied"; readonly sets: readonly AppliedMigrationSet[] }
  | { readonly status: "failed"; readonly set: string | null; readonly message: string };

export type MigrationStateHolder = {
  get(): MigrationState;
  set(state: MigrationState): void;
};

export function createMigrationStateHolder(): MigrationStateHolder {
  let state: MigrationState = { status: "pending" };
  return {
    get: () => state,
    set: (next) => {
      state = next;
    },
  };
}
