import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestKobai, inspectSchema } from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import config from "../kobai.config.ts";

/**
 * The reference Project's side of ADR-0017: a Plugin offers, and the Project wires.
 *
 * `packages/plugin-price-log` proves that a Plugin *can* own a table. This proves that a
 * Project is what decides whether it does — and it does so through the same
 * `kobai.config.ts` a Developer would edit, booted through the same `createKobai` the
 * entrypoint calls.
 */
describe("installing the Plugin", () => {
  it("is an ordinary npm dependency and nothing more", async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };

    // No installer, no registry of its own, no postinstall step: a Plugin arrives the way
    // every other package does, and the only other thing kobai asks of a Developer is the
    // one line in `kobai.config.ts` below.
    expect(manifest.dependencies?.["@kobai/plugin-price-log"]).toBeDefined();
  });
});

describe("the reference Project's configuration", () => {
  it("wires the Plugin's migration set, and that is the whole of the wiring", () => {
    expect(config.migrationSets?.map((set) => set.name)).toEqual(["plugin-price-log"]);
  });

  it("brings the Plugin's table into being when Core boots with it", async () => {
    await using kobai = await createTestKobai(config);

    await expect(
      inspectSchema(kobai.database).tablesOwnedBy("price_log"),
    ).resolves.toEqual(["price_log_entry"]);
  });

  it("leaves it absent when the same Project boots without it", async () => {
    // The same Project, the same installed dependency, one line of config removed. This is
    // the difference wiring makes, and it is the only difference.
    await using kobai = await createTestKobai({ ...config, migrationSets: [] });

    await expect(
      inspectSchema(kobai.database).tablesOwnedBy("price_log"),
    ).resolves.toEqual([]);
  });

  it("still serves the Store, because a wired Plugin changes no Core behaviour", async () => {
    await using kobai = await createTestKobai(config);

    const response = await kobai.request("/admin/store");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "kobai",
      defaultCurrency: "USD",
      metadata: {},
    });
  });
});
