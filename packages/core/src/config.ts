import type { MigrationSet } from "./migrations/set.ts";

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
