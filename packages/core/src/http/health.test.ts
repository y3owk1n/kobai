import { afterEach, describe, expect, it } from "vitest";
import { defineMigrationSet } from "../migrations/set.ts";
import { createTestKobai, signInTestMerchant, type TestKobai } from "../testing/index.ts";

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

describe("GET /health", () => {
  it("reports ok once migrations have applied, naming where each set tracks", async () => {
    kobai = await createTestKobai();

    const response = await kobai.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      migrations: {
        status: "applied",
        sets: [
          {
            name: "core",
            migrationsSchema: "drizzle",
            migrationsTable: "__drizzle_migrations_core",
            applied: 9,
          },
        ],
      },
    });
  });

  it("reports booting before migrations have run", async () => {
    kobai = await createTestKobai({ migrate: false });

    const response = await kobai.request("/health");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "booting",
      migrations: { status: "pending" },
    });
  });

  it("reports error, not booting, when a migration fails", async () => {
    // The distinction is the whole point: a broken instance must not look like a slow one.
    const broken = defineMigrationSet({
      name: "plugin-broken",
      migrationsFolder: "/nonexistent/kobai/migrations",
    });
    kobai = await createTestKobai({ migrationSets: [broken] });

    const response = await kobai.request("/health");

    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; migrations: unknown };
    expect(body.status).toBe("error");
    expect(body.migrations).toMatchObject({ status: "failed", set: "plugin-broken" });
  });

  it("reports migration state rather than connectivity, and needs no database to do it", async () => {
    kobai = await createTestKobai();
    // Signed in while the database still exists, so the request below fails on the database
    // rather than at the gate.
    const merchant = await signInTestMerchant(kobai);
    await kobai.database.drop();

    // Health answers from what the migration run recorded, so it keeps working when the
    // database does not. That is deliberate — it is the endpoint that tells you a boot
    // succeeded — and it means /health is not a database liveness check. A route that does
    // touch the database fails, as it should.
    const health = await kobai.request("/health");
    const store = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });
    expect(store.status).toBe(500);
  });
});
