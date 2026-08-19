import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OPENAPI_SOURCE_PATH } from "../generate.ts";

/** This package's hand-written surface — the file that does the re-exporting. */
const INDEX_PATH = new URL("./index.ts", import.meta.url);

/**
 * The third drift check, and the one about names rather than about shapes.
 *
 * `openapi.test.ts` proves the description matches the routes and `schema.test.ts` proves the
 * generated client matches the description. Neither can see the omission this catches, because
 * `index.ts` is the one file here nothing generates: `components` carries every schema whether
 * or not a name is re-exported off it, so a family the client forgot is present in `schema.ts`,
 * absent from the package's surface, and green everywhere.
 *
 * That is the gap #196 was filed about — five families named of the twelve there were then,
 * and six unnamed of the sixteen there were by the time it was picked up, which is the list
 * going stale twice over while the check that would have said so did not exist. Under
 * ADR-0060 a refusal's `reason` is promised surface and narrowing on it is what this client
 * exists to make possible, so a family reached through `components["schemas"][…]` is a
 * consumer paying for an omission nobody chose — and "add them as you need them" is the
 * process that produces exactly that ratio, at whatever size the surface happens to be.
 *
 * **Watched failing twice**, which is the only thing that makes an equality worth writing.
 * With `export type OrderRefusal` deleted from `index.ts` it reports that one name and no
 * other; with the same line kept but exported as `OrderProblem` it reports it again, which
 * is what holds "by name" to something — an alias is a name a consumer cannot guess from the
 * description, so it is the omission wearing a different hat.
 */
describe("the client names every refusal family the description carries", () => {
  it("re-exports each of them under the description's own name", async () => {
    const [description, index] = await Promise.all([
      readDescription(),
      readFile(INDEX_PATH, "utf8"),
    ]);

    const families = refusalFamiliesIn(description);
    // Two empty lists are equal, so the equality below proves nothing on its own if the
    // description ever stops being read.
    expect(families.length).toBeGreaterThan(0);

    const byName = reExportedByName(index);
    expect(families.filter((family) => byName.get(family) === family)).toEqual(families);
  });
});

/**
 * Every schema that is a refusal, by the only definition derivable from the description: it
 * requires an `error` and a `reason`.
 *
 * `reason` is the discriminator ADR-0060 promises, so a schema carrying one is a family a
 * consumer branches on. That deliberately excludes `ServerError` and `Unavailable`, which say
 * `error` and no `reason` on purpose — there is nothing there to narrow — and it deliberately
 * *includes* the single-reason ones like `OrderRefusal` and `SecretKeyRequired`, which narrow
 * identically and grow a second reason without a client edit.
 *
 * Structural rather than a list of names, because a list is the thing that went stale.
 */
function refusalFamiliesIn(description: Description): string[] {
  const schemas = Object.entries(description.components?.schemas ?? {});
  return schemas
    .filter(([, schema]) => {
      const required = new Set(schema.required ?? []);
      return required.has("error") && required.has("reason");
    })
    .map(([name]) => name)
    .sort();
}

/**
 * What `index.ts` re-exports: each schema name it takes an alias off, mapped to the name it
 * exports that alias under. The two are equal for every line in the file today, and the
 * equality above is what keeps them so.
 *
 * Read as text because the thing under test is erased before anything could import it: these
 * are type aliases, so there is no runtime value to ask. The idiom it matches is the one the
 * whole block is written in, and a rewrite that stopped matching would empty this map and fail
 * the equality above rather than pass it.
 */
function reExportedByName(index: string): Map<string, string> {
  const alias = /export type (\w+) =\s*components\["schemas"\]\["(\w+)"\];/g;
  return new Map(
    [...index.matchAll(alias)].map(([, exportedAs, schema]) => [
      schema ?? "",
      exportedAs ?? "",
    ]),
  );
}

type Description = {
  components?: { schemas?: Record<string, { required?: string[] }> };
};

async function readDescription(): Promise<Description> {
  return JSON.parse(await readFile(OPENAPI_SOURCE_PATH, "utf8")) as Description;
}
