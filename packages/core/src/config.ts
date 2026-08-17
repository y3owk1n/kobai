import type { MigrationSet } from "./migrations/set.ts";
import type { priceResolutionWorkflow } from "./pricing/resolve-price.ts";
import type { WorkflowOverrides } from "./workflow/workflow.ts";

/**
 * The single place a Project declares what it has customised — `kobai.config.ts` in the
 * Project's repository (ADR-0025). Everything a Developer has changed is visible here, in
 * one file, rather than spread across the Project.
 *
 * Nothing takes effect by being installed. A Plugin *offers* capabilities; the Project
 * wires them here, deliberately, so load order never silently decides behaviour (ADR-0017).
 */
export type KobaiProjectConfig = {
  /**
   * Migration sets contributed by the Plugins this Project has wired. Core's own set always
   * runs and is not listed here — it is not the Project's to opt out of.
   */
  readonly migrationSets?: readonly MigrationSet[];
  /**
   * What this Project has changed about Core's Workflows — ADR-0003's flagship, and the
   * reason this file exists at all.
   *
   * ```ts
   * workflows: { "resolve-price": { steps: { "select-price": myStep } } }
   * ```
   *
   * Keyed by Workflow and then by slot, so a Developer reading it sees which Workflow they
   * altered and where, and two Workflows are free to name a slot the same thing. A Step
   * supplied here must satisfy the types of the slot it fills; one that does not is a compile
   * error, which is what makes swapping a Step safe rather than merely possible (ADR-0017).
   *
   * Note what is *not* here: nothing a Plugin can reach. A Plugin offers Steps and a Project
   * wires them, in this file, deliberately — so load order never silently decides behaviour.
   */
  readonly workflows?: CoreWorkflowOverrides;
};

/**
 * The Workflows Core declares, and what a Project may override in each.
 *
 * Written out by name rather than derived from a registry: this is the list a Developer is
 * promised stability on, so it should be readable as a list. A new Workflow adds a line here,
 * and that line is the decision to expose it.
 */
export type CoreWorkflowOverrides = {
  readonly "resolve-price"?: WorkflowOverrides<typeof priceResolutionWorkflow>;
};

/** Identity, for the types. A Project's `kobai.config.ts` calls this. */
export function defineKobaiConfig(config: KobaiProjectConfig): KobaiProjectConfig {
  return config;
}

/** The minimum a logger must do for Core. A Project may pass anything that does it. */
export type Logger = {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export const consoleLogger: Logger = {
  info: (message, fields) => console.log(format("info", message, fields)),
  error: (message, fields) => console.error(format("error", message, fields)),
};

function format(
  level: string,
  message: string,
  fields: Record<string, unknown> | undefined,
): string {
  return JSON.stringify({ level, message, ...fields, time: new Date().toISOString() });
}
