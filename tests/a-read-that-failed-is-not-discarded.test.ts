import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * **A picker over a set kobai names has three states, and an empty list is two of them** —
 * `docs/agents/the-admin.md`'s rule, held by the build rather than by whoever last read it
 * (#311).
 *
 * *Nobody has asked yet*, *kobai answered and the Store has none*, and *the read failed* all
 * draw the same control with nothing in it. A hook that reports only the first two leaves its
 * callers no way to say which — and the sentence a screen then falls through to is wrong in the
 * worst direction, because *enable a currency on the Store screen* is advice to a Merchant whose
 * Store very likely has one and whose read has just failed.
 *
 * It went wrong twice in two different places, which is why this exists rather than a third
 * paragraph of prose. `useEnabledCurrencies` shipped without an `error` at all, so three currency
 * pickers could not have reported one; and `screens/api-keys.tsx` had the field but dropped it,
 * so a failed `GET /admin/channels` left a picker holding nothing but `In no particular Channel`.
 * The second is the shape a seventh picker would arrive in, and nothing in the gate could see it.
 *
 * `tests/an-unavailable-control-can-still-be-reached.test.ts` is the house pattern this copies:
 * a rule everybody agrees on, held by something that reads the repository rather than by a
 * convention.
 *
 * ## What it claims, and what it does not
 *
 * **It claims that a failure is taken, never that it is rendered well.** Whether a sentence is
 * the right sentence is not a thing a scan can know, and a sweep that pretended otherwise would
 * be the guardrail that overclaims. What went wrong both times was cruder than bad prose: the
 * failure was not in the caller's hands at all. That is exactly what this reads.
 *
 * **It reaches a read that lives in a `lib/` module, and no other.** A screen with its own
 * `useQuery` is outside it — `components/fulfilment-strategy-field.tsx` is the one, and it gates
 * its "not wired here" option on the query having *succeeded*, which
 * `docs/agents/the-admin.md` records as deliberate. Widening to every `useQuery` in the Admin
 * would sweep the list reads too, whose failures are rendered as a whole screen rather than as a
 * field, and it would be a different rule wearing this one's name. **A set two controls both ask
 * for is a module** is already the convention (`lib/collections.ts`, `lib/markets.ts`), so the
 * second caller of a new set arrives here on its own.
 *
 * **Nothing here is a list of pickers.** The reads are discovered from the modules, the readers
 * from beside them, and the call sites from the source that binds them — so a `lib/warehouses.ts`
 * written tomorrow is swept the day it exists, which a list is precisely what fails to do.
 */
const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

/**
 * The trees swept: the Admin a maintainer boots, and the copy a Developer is actually handed.
 *
 * The second is generated from the first and
 * `tests/create-kobai-matches-the-reference-project.test.ts` byte-compares them, so a finding
 * here names both and one edit fixes both. Each tree is **discovered and swept on its own**
 * rather than the template being taken on trust — a sweep that leaned on another test's
 * guarantee would be leaning on it in the one direction that matters least.
 */
const ADMIN_TREES = [
  { src: "reference/admin/src/", lib: "reference/admin/src/lib/" },
  {
    src: "packages/create-kobai/template/admin/src/",
    lib: "packages/create-kobai/template/admin/src/lib/",
  },
] as const;

/**
 * A read of a set kobai names, as this file recognises one.
 *
 * The discriminator is deliberately structural rather than a vocabulary: an **exported** `use…`
 * function in `lib/`, whose declared return type is an **exported type alias in the same
 * module**. That is what `lib/store.ts`, `lib/markets.ts` and `lib/collections.ts` all are, and
 * it is what `lib/session.tsx`'s `useKobai` is not — its `Kobai` is declared unexported, so the
 * one hook here that wraps `useQuery` and answers something other than a set stays out without
 * being named. `usePermissions` and `useSections` stay out for the same reason one step along:
 * they answer an array rather than an alias.
 *
 * Matching on `answered` or `read` — the two names these types actually use for *kobai has
 * replied* — was the alternative, and it is the one that rots: the third spelling of that field
 * would leave its module silently unswept.
 */
type ReportingRead = {
  /** The module it lives in, for a message a reader can act on. */
  readonly module: string;
  /** `useOfferedChannels`, and the name a call site binds. */
  readonly hook: string;
  /** `OfferedMarkets` — the alias head, generics stripped. */
  readonly answer: string;
  /**
   * The functions beside it that turn its failure into prose, by name.
   *
   * Discovered rather than assumed, so calling one counts as reading the failure without this
   * file knowing that `why…NotRead` is what they are called. A module with none — today
   * `lib/collections.ts` — simply has fewer ways for its callers to satisfy the rule.
   */
  readonly readers: readonly string[];
};

/** Every exported type alias in a module, as name to body. */
function exportedAliases(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const declarations = /^export type (\w+)(?:<[^>]*>)? = \{\n([\s\S]*?)^\};$/gm;

  for (const [, name, body] of source.matchAll(declarations)) {
    if (name !== undefined && body !== undefined) found.set(name, body);
  }

  return found;
}

/** The head of a type expression: `OfferedMarkets<Region>` is `OfferedMarkets`. */
const headOf = (type: string) => type.replace(/<[\s\S]*$/, "").trim();

/**
 * The reads a module declares, and the failure readers standing beside them.
 *
 * A reader is an exported function taking one of those same answers and giving back
 * `string | null` — which is what `whyCurrenciesNotRead` and its two siblings are, and is a
 * shape rather than a name.
 */
function reportingReadsIn(module: string, source: string): ReportingRead[] {
  const aliases = exportedAliases(source);

  const readers = new Map<string, string[]>();
  const readerDeclarations =
    /^export function (\w+)\(\s*\w+: ([\w$]+)(?:<[^>]*>)?,?\s*\): string \| null/gm;
  for (const [, name, over] of source.matchAll(readerDeclarations)) {
    if (name === undefined || over === undefined || !aliases.has(over)) continue;
    readers.set(over, [...(readers.get(over) ?? []), name]);
  }

  const hooks = /^export function (use\w+)\([^)]*\):\s*([\w$]+(?:<[^>]*>)?)\s*\{/gm;
  const reads: ReportingRead[] = [];

  for (const [, hook, returned] of source.matchAll(hooks)) {
    if (hook === undefined || returned === undefined) continue;
    const answer = headOf(returned);
    if (!aliases.has(answer)) continue;
    reads.push({ module, hook, answer, readers: readers.get(answer) ?? [] });
  }

  return reads;
}

/** One offence: where the failure was dropped, and by which read. */
type Offence = {
  readonly path: string;
  readonly hook: string;
  readonly binding: string;
};

/** The failure a reader can act on: which file, which read, and what to do about it. */
const readable = (offence: Offence) =>
  `${offence.path} binds ${offence.hook}() as \`${offence.binding}\` and never reads its \`error\`, so a read that failed draws the same empty control as a Store that has none (#311, docs/agents/the-admin.md) — render the failure in the field's own description and disable the control`;

/**
 * Whether a file that binds one of these reads does anything with the failure.
 *
 * Three spellings count, and all three are what the Admin actually writes: `x.error` on the
 * binding, the binding handed to one of the module's own readers, and a destructure that names
 * `error` at all. The third is why `screens/products.tsx` is not swept twice — it takes the
 * failure apart at the binding rather than reaching for it later.
 *
 * **A destructure that does not name `error` is the offence**, and it is worth saying why that
 * is not harsh: `const { collections, read } = useOfferedCollections()` is the failure being
 * dropped in the one place a reader would never think to look for it, which is exactly how the
 * Products screen lost its Collection filter to a failed read in silence.
 */
function offencesIn(path: string, source: string, reads: readonly ReportingRead[]) {
  const found: Offence[] = [];

  for (const read of reads) {
    const call = String.raw`${read.hook}\(\s*\)`;

    for (const [, binding] of source.matchAll(
      new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*${call}`, "g"),
    )) {
      if (binding === undefined) continue;
      const reads_it =
        new RegExp(String.raw`\b${binding}\.error\b`).test(source) ||
        read.readers.some((reader) =>
          new RegExp(String.raw`\b${reader}\(\s*${binding}\b`).test(source),
        );
      if (!reads_it) found.push({ path, hook: read.hook, binding });
    }

    for (const [, taken] of source.matchAll(
      new RegExp(String.raw`(?:const|let)\s*\{([^}]*)\}\s*=\s*${call}`, "g"),
    )) {
      if (taken === undefined) continue;
      if (!/\berror\b/.test(taken)) {
        found.push({ path, hook: read.hook, binding: `{ ${taken.trim()} }` });
      }
    }
  }

  return found;
}

/**
 * The files to read, asked of git rather than walked.
 *
 * `--cached --others --exclude-standard` is tracked files **plus** untracked ones git would not
 * ignore, so a screen written right now is swept before it is ever staged and CI answers the
 * same. Asking git is also what keeps `reference/admin/dist/` out of it, along with
 * `node_modules` and above all `.claude/worktrees/`, where a harness puts a whole second
 * checkout (ADR-0068).
 */
async function adminSourcePaths(): Promise<string[]> {
  const { stdout } = await run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: fileURLToPath(repoRoot), maxBuffer: 32 * 1024 * 1024 },
  );

  const paths = stdout
    .split("\0")
    .filter((path) => path.length > 0 && /\.tsx?$/.test(path))
    .filter((path) => ADMIN_TREES.some((tree) => path.startsWith(tree.src)));

  if (paths.length === 0) {
    // Failing open would be worse than failing: an empty list makes this whole file pass by
    // reading nothing, which is indistinguishable from reading everything.
    throw new Error(
      "git listed no Admin source file, so nothing was checked for a discarded read failure.",
    );
  }

  return paths;
}

const readText = (path: string) =>
  readFile(fileURLToPath(new URL(path, repoRoot)), "utf8");

/**
 * One tree's reads and the files that may bind them, discovered from that tree alone.
 *
 * **Each tree is swept against its own modules**, never against the pair of them. The two carry
 * the same hook under the same name, so one flat list would ask every consumer about both copies
 * and report each finding twice — a message a reader has to work out is one problem rather than
 * two, which is the failure `readable` exists to avoid.
 */
type Tree = {
  readonly reads: readonly ReportingRead[];
  readonly consumers: readonly string[];
};

async function sweptTrees(): Promise<Tree[]> {
  const paths = await adminSourcePaths();

  const trees = await Promise.all(
    ADMIN_TREES.map(async (tree) => {
      const here = paths.filter((path) => path.startsWith(tree.src));
      const reads = (
        await Promise.all(
          here
            .filter((path) => path.startsWith(tree.lib))
            .map(async (path) => reportingReadsIn(path, await readText(path))),
        )
      ).flat();

      return {
        reads,
        // A module does not sweep itself: `lib/markets.ts` names `useOfferedRegions` in its own
        // declaration, and the readers beside it take the answer rather than binding it.
        consumers: here.filter((path) => !path.startsWith(tree.lib)),
      };
    }),
  );

  if (trees.some((tree) => tree.reads.length === 0)) {
    throw new Error(
      "a tree yielded no reporting read at all, so this sweep is vacuous over it.",
    );
  }

  return trees;
}

/** Every reporting read in every tree, for the assertions whose subject is the modules. */
async function everyReportingRead(): Promise<ReportingRead[]> {
  return (await sweptTrees()).flatMap((tree) => tree.reads);
}

describe("a read that failed is not discarded", () => {
  it("gives every read of a kobai-named set an error to report", async () => {
    // The half `useEnabledCurrencies` got wrong: it answered `answered` and `isPending` and
    // nothing else, so no caller *could* have reported a failure. Named rather than counted,
    // because the fix is in the module the name points at.
    const reads = await everyReportingRead();

    const silent = await Promise.all(
      reads.map(async (read) => {
        const body = exportedAliases(await readText(read.module)).get(read.answer) ?? "";
        return /^\s*readonly error[?]?:/m.test(body)
          ? null
          : `${read.module} answers ${read.hook}() as ${read.answer}, which declares no \`error\` — so no caller can tell a read that failed from a Store that has none (#311)`;
      }),
    );

    expect(silent.filter((one) => one !== null)).toEqual([]);
  });

  it("finds no call site that drops the failure it was handed", async () => {
    const trees = await sweptTrees();

    const offences = (
      await Promise.all(
        trees.flatMap((tree) =>
          tree.consumers.map(async (path) =>
            offencesIn(path, await readText(path), tree.reads),
          ),
        ),
      )
    ).flat();

    expect(offences.map(readable)).toEqual([]);
  });

  it("reads the modules and the screens the rule is about", async () => {
    // Discovery is what makes this cover the next picker without an edit, and the way discovery
    // fails is by quietly reaching less than it did — a signature wrapped onto two lines by the
    // formatter would do it. These are the ones whose absence would matter most: every module
    // that reads a set today, in both trees.
    const reads = await everyReportingRead();
    const named = reads.map((read) => `${read.module} ${read.hook}`);

    for (const tree of ADMIN_TREES) {
      expect(named).toContain(`${tree.lib}store.ts useEnabledCurrencies`);
      expect(named).toContain(`${tree.lib}markets.ts useOfferedRegions`);
      expect(named).toContain(`${tree.lib}markets.ts useOfferedChannels`);
      expect(named).toContain(`${tree.lib}collections.ts useOfferedCollections`);
    }

    // And the readers beside them, which are the other half of what a call site may satisfy the
    // rule with. `lib/collections.ts` deliberately has none — one caller is not a module — so
    // its consumers reach for `.error` directly, and that is asserted by its absence here rather
    // than by a line claiming it.
    const readers = reads.flatMap((read) => read.readers);
    expect(readers).toContain("whyCurrenciesNotRead");
    expect(readers).toContain("whyRegionsNotRead");
    expect(readers).toContain("whyChannelsNotRead");
  });

  it("names a call site that binds the read and never reads its error", () => {
    // The red case. `toEqual([])` above is an emptiness assertion, and one nobody has watched
    // fail is not yet known to be able to — `store.test.ts`'s rule, and the reason the sweep is
    // a function rather than an expression inside its own `expect`.
    //
    // This is the shape `screens/api-keys.tsx` really shipped: the hook bound, the list drawn,
    // the failure nowhere in the file.
    const reads = [
      {
        module: "lib/markets.ts",
        hook: "useOfferedChannels",
        answer: "OfferedMarkets",
        readers: ["whyChannelsNotRead"],
      },
    ] as const;

    const offences = offencesIn(
      "api-keys.tsx",
      [
        "const channels = useOfferedChannels();",
        "options={[{ value: NO_CHANNEL, label: 'In no particular Channel' },",
        "  ...channels.offered.map((one) => ({ value: one.id, label: one.name }))]}",
      ].join("\n"),
      reads,
    );

    expect(offences.map((offence) => offence.binding)).toEqual(["channels"]);
    expect(readable(offences[0] as Offence)).toContain("never reads its `error`");
  });

  it("takes the failure read either way a caller may reach for it", () => {
    // Both spellings the Admin actually writes, and neither is preferred here: the Price editor
    // asks `regions.error !== null` to decide whether to disable, and hands the same binding to
    // `whyRegionsNotRead` for the sentence. A sweep that insisted on one would be holding a
    // style rather than the rule.
    const reads = [
      {
        module: "lib/markets.ts",
        hook: "useOfferedRegions",
        answer: "OfferedMarkets",
        readers: ["whyRegionsNotRead"],
      },
    ] as const;

    expect(
      offencesIn(
        "direct.tsx",
        "const regions = useOfferedRegions();\nregions.error",
        reads,
      ),
    ).toEqual([]);
    expect(
      offencesIn(
        "reader.tsx",
        "const regions = useOfferedRegions();\nwhyRegionsNotRead(regions)",
        reads,
      ),
    ).toEqual([]);
  });

  it("names a destructure that leaves the failure behind", () => {
    // How the Products screen lost its Collection filter to a failed read: `error` was dropped
    // where nobody would think to look for it, and the nav simply stopped being drawn — which
    // is what a Store with no Collections looks like.
    const reads = [
      {
        module: "lib/collections.ts",
        hook: "useOfferedCollections",
        answer: "OfferedCollections",
        readers: [],
      },
    ] as const;

    expect(
      offencesIn(
        "products.tsx",
        "const { collections: offered, read } = useOfferedCollections();",
        reads,
      ).map((offence) => offence.hook),
    ).toEqual(["useOfferedCollections"]);

    expect(
      offencesIn(
        "products.tsx",
        "const { collections: offered, read, error: why } = useOfferedCollections();",
        reads,
      ),
    ).toEqual([]);
  });

  it("does not read one binding's failure as another's", () => {
    // Two reads in one component is the ordinary case — the Price editor has three — so the
    // check is per binding rather than per file. A sweep that asked whether the *file* mentions
    // any `.error` would have passed `screens/api-keys.tsx` on the Products query beside it.
    const reads = [
      {
        module: "lib/markets.ts",
        hook: "useOfferedRegions",
        answer: "OfferedMarkets",
        readers: ["whyRegionsNotRead"],
      },
      {
        module: "lib/markets.ts",
        hook: "useOfferedChannels",
        answer: "OfferedMarkets",
        readers: ["whyChannelsNotRead"],
      },
    ] as const;

    const offences = offencesIn(
      "prices.tsx",
      [
        "const regions = useOfferedRegions();",
        "const channels = useOfferedChannels();",
        "whyRegionsNotRead(regions)",
      ].join("\n"),
      reads,
    );

    expect(offences.map((offence) => offence.binding)).toEqual(["channels"]);
  });

  it("discovers a read written in a module this file has never heard of", () => {
    // The claim that this is not a list. A module added tomorrow is swept for both halves of
    // the rule the day it exists — the type it answers and the readers beside it — with no edit
    // here and no name of it anywhere in this file.
    const invented = [
      "export type OfferedWarehouses = {",
      "  readonly warehouses: readonly Warehouse[];",
      "  readonly answered: boolean;",
      "  readonly error: unknown;",
      "};",
      "",
      "export function useOfferedWarehouses(): OfferedWarehouses {",
      "  return here;",
      "}",
      "",
      "export function whyWarehousesNotRead(w: OfferedWarehouses): string | null {",
      "  return null;",
      "}",
    ].join("\n");

    expect(reportingReadsIn("lib/warehouses.ts", invented)).toEqual([
      {
        module: "lib/warehouses.ts",
        hook: "useOfferedWarehouses",
        answer: "OfferedWarehouses",
        readers: ["whyWarehousesNotRead"],
      },
    ]);
  });

  it("leaves a hook that answers something other than a set alone", () => {
    // `lib/session.tsx` wraps `useQuery` too, and `useKobai` answers a `Kobai` — declared
    // unexported, which is what keeps it out. Widening to every hook in `lib/` would sweep the
    // session, whose failure is the sign-in screen rather than a field, and would be a different
    // rule wearing this one's name.
    const session = [
      "type Kobai = {",
      "  readonly client: KobaiClient;",
      "};",
      "",
      "export function useKobai(): Kobai {",
      "  return here;",
      "}",
    ].join("\n");

    expect(reportingReadsIn("lib/session.tsx", session)).toEqual([]);
  });

  /**
   * The one screen whose failure is **composed** rather than fallen through, recorded here so
   * that flattening it has to be an argument rather than a tidy-up.
   *
   * It is a record and not an exemption, and the difference matters: `screens/api-keys.tsx`
   * satisfies the sweep above on its own merits — it reads its failure like every other caller.
   * What is different is what it *says*, and the reason is a property no scan can see. Every
   * other picker over one of these sets is unusable when the read fails, so its description is
   * `whyXNotRead(x) ?? "the ordinary sentence"` and the control is dead with nothing to choose.
   * The mint form is still completable: `In no particular Channel` is a real answer rather than
   * an empty-set placeholder — the one most keys want, and every key that exists today — so a
   * failed read costs a Merchant the *other* rows and nothing else, and a sentence naming only
   * the failure would read as though minting were off.
   *
   * **This is the honest limit of the sweep, said out loud.** "Still completable without the
   * set" is semantics: it depends on whether the option list carries a value the form will
   * accept, and `screens/product.tsx`'s `Every Region` and `Every Channel` are sentinels of the
   * same shape on pickers that *are* disabled — so a scan that tried to derive the distinction
   * would draw it in the wrong place and call one of the two a defect. What can be held is that
   * this screen still says both things, which is what the two assertions below are.
   */
  it("records the one picker that says what a Merchant can still do", async () => {
    for (const tree of ADMIN_TREES) {
      const source = await readText(`${tree.src}screens/api-keys.tsx`);

      // The failure, taken the way every other caller takes it.
      expect(source).toContain("whyChannelsNotRead(channels)");
      // And the half that is this screen's own. Flattening this to `?? "…"` would drop it and
      // pass every other check in this file, which is the whole reason it is asserted.
      expect(source).toContain("A key can still be minted into no particular Channel");
    }
  });

  it("is pointed at by the rule it holds", async () => {
    // A rule stated in prose and held nowhere is what this was until #311, so the statement
    // names the assertion. Reading it here is what stops the two drifting apart: rename this
    // file and the pointer has to move with it.
    expect(await readText("docs/agents/the-admin.md")).toContain(basename(thisFile));
  });
});

/**
 * This file, which is not swept.
 *
 * It sits in `tests/`, outside both trees above, so the fixtures it spells out are read by the
 * cases that want them and by nothing else. Derived from `import.meta.url`, so renaming it
 * cannot leave a stale path behind.
 */
const thisFile = fileURLToPath(import.meta.url);
