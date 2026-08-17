/**
 * `@kobai/core` — the package a Project depends on.
 *
 * A Developer never edits Core; upgrading it is a version bump, not a merge (ADR-0001).
 * What that costs is that everything reachable from here is a promise, so the surface is
 * kept small on purpose.
 */
export {
  consoleLogger,
  defineKobaiConfig,
  type KobaiProjectConfig,
  type Logger,
} from "./config.ts";
export type { MerchantIdentity, RoleSummary } from "./auth/identity.ts";
export type { Permission } from "./auth/permissions.ts";
export { ALL_PERMISSIONS, OWNER_ROLE, PERMISSIONS } from "./auth/permissions.ts";
export type { Price, Product, ProductDetail, Variant } from "./catalog/read.ts";
export type { Database } from "./db/client.ts";
export type { HealthBody } from "./http/health.ts";
export { createKobai, type Kobai, type KobaiOptions } from "./kobai.ts";
export type {
  AppliedMigrationSet,
  MigrationOutcome,
  MigrationSet,
  MigrationState,
} from "./migrations/index.ts";
export type { Store } from "./store/read.ts";
