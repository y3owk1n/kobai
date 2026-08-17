import { describe, expect, it } from "vitest";
import { createTestKobai } from "../testing/index.ts";

/**
 * What the whole surface does with a request no route wanted to see.
 *
 * These are refusals the routes themselves never make — they are made above every one of
 * them — and the thing worth asserting about each is *whose mistake it is reported as*. A
 * client error answered 500 tells a Developer the server is broken and pages an operator
 * about a typo.
 */
describe("a request body that will not parse", () => {
  it("is the client's mistake, and is answered as one", async () => {
    await using kobai = await createTestKobai();

    const response = await kobai.request("/admin/merchants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });

    expect(response.status).toBe(400);
    // Distinct from the `invalid` a schema failure answers with: this body cannot be read
    // at all, that one reads fine and does not fit, and they have different fixes.
    await expect(response.json()).resolves.toMatchObject({ reason: "malformed-body" });
  });

  it("is answered the same way when the body is empty", async () => {
    await using kobai = await createTestKobai();

    const response = await kobai.request("/admin/merchants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "malformed-body" });
  });

  it("is `invalid`, not `malformed-body`, when it parses and does not fit", async () => {
    await using kobai = await createTestKobai();

    const response = await kobai.request("/admin/merchants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });
});
