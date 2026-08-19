import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * ADR-0063's `aria-disabled`, kept true by the build rather than by whoever last read the
 * decision (#199).
 *
 * An action a Merchant's Role cannot perform is **`aria-disabled`, never `disabled`**, and
 * #178 spells out why that is not a style preference: a truly disabled control takes no focus
 * and fires **no pointer events**, so it can host no tooltip and cannot be reached to be told
 * why it is unavailable — the explanation the whole affordance exists to give is unreachable
 * through the obvious implementation of it.
 *
 * A Tailwind recipe that then sets `pointer-events-none` on `aria-disabled:` puts that missing
 * half straight back. The control is focusable and inert to the mouse, so it can host no
 * tooltip either, and the affordance is defeated in **silence**: no scanner reports it, and
 * `axe-core` has nothing to say about a control that is styled out of reach.
 *
 * That is not hypothetical. `components/ui/sidebar.tsx` shipped exactly this in two recipes,
 * because upstream shadcn mirrors each of its `disabled:` rules onto `aria-disabled:` — and it
 * arrived through `shadcn add`, which is the door it would come back through.
 * `buttonVariants` never did it, which is the only reason `components/action-button.tsx` works
 * at all. Nothing in the gate could see any of it.
 *
 * **`disabled:pointer-events-none` is deliberately untouched.** A control dead only while a
 * request is in flight has nothing to explain and nobody to explain it to, which is why every
 * mutation in this Admin still passes `disabled={…isPending}` and why `components/pager.tsx`'s
 * dead Next and Previous are really disabled. The ban is on the ARIA attribute alone.
 *
 * `tests/no-push-script.test.ts` is the house pattern: a rule everybody agrees on, held by
 * something that reads the repository rather than by a convention.
 */
const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

/**
 * The variants that take pointer events away from an `aria-disabled` control.
 *
 * A bare substring, so `group-aria-disabled:` and `peer-aria-disabled:` are caught by the same
 * needle without being written out — a prefixed variant is the same defect one element away,
 * and reaches the same control. The arbitrary-property spelling is listed beside it because
 * Tailwind accepts both and they compile to the same rule.
 *
 * **What it does not reach**, said out loud rather than left to be found: an arbitrary
 * *variant* — `[&[aria-disabled]]:pointer-events-none` — spells the selector rather than the
 * state, and a `pointer-events: none` written in `src/index.css` against an attribute selector
 * is not a class at all. Neither has ever been written here, and a scan wide enough to catch
 * them would be reading CSS rather than looking for a token. The rule above is still yours to
 * have read; this catches the way the defect actually arrives, which is a `shadcn add`.
 */
const CANNOT_BE_REACHED = [
  "aria-disabled:pointer-events-none",
  "aria-disabled:[pointer-events:none]",
] as const;

/**
 * The trees swept: the Admin a maintainer boots, and the copy a Developer is actually handed.
 *
 * The second is generated from the first and
 * `tests/create-kobai-matches-the-reference-project.test.ts` byte-compares them, so a finding
 * here names both files and one edit fixes both. It is sweeping the template anyway because
 * what ships is the thing worth asserting about — and because a sweep that trusted another
 * test's guarantee would be trusting it in the one direction that matters least.
 */
const ADMIN_SOURCE = [
  "reference/admin/src/",
  "packages/create-kobai/template/admin/src/",
];

/**
 * This file, which spells both needles out and is not swept.
 *
 * It needs no exemption to say them — it sits in `tests/`, outside the two trees above — and
 * that is what lets it be the red case rather than a fixture: `"would fail against a file that
 * offends"` reads this very file and watches the sweep find them. Derived from
 * `import.meta.url`, so renaming this file cannot leave a stale path behind.
 */
const thisFile = fileURLToPath(import.meta.url);

/** One offence, as the file it is in, the line, and the variant found there. */
type Offence = {
  readonly path: string;
  readonly line: number;
  readonly variant: string;
};

/** The failure a reader can act on: which file, which line, and what the rule is. */
const readable = (offence: Offence) =>
  `${offence.path}:${offence.line} sets ${offence.variant}, so a control that is unavailable to this Role fires no pointer events, can host no tooltip, and cannot be reached to be told why (ADR-0063, #178) — delete the variant and keep the disabled: one`;

/**
 * **The token is banned outright, comments included, and that is deliberate.**
 *
 * Blanking comments and string literals first would let a `CHANGED FROM UPSTREAM` note quote
 * the class it removes — and it would mean a second TypeScript reader in this repository,
 * whose failure mode is to lose its place and pass a file it never finished (see the foot of
 * `tests/a-role-is-made-through-the-route.test.ts`, which was fixed for exactly that). A
 * guardrail may not fail open, and a plain search cannot. The price is that the two notes in
 * `sidebar.tsx` describe the variant instead of spelling it; the words themselves live in
 * `reference/admin/src/components/ui/README.md`, which is prose and is not swept.
 *
 * One offence per line per variant, never one per occurrence. A recipe is a single very long
 * class string, so a line is the place a reader has to go and edit — and `sidebar.tsx`, which
 * offended twice, offended on two lines.
 */
function offencesIn(path: string, source: string): Offence[] {
  const found: Offence[] = [];

  source.split("\n").forEach((text, index) => {
    for (const variant of CANNOT_BE_REACHED) {
      if (text.includes(variant)) {
        found.push({ path, line: index + 1, variant });
      }
    }
  });

  return found;
}

/**
 * The files to read, asked of git rather than walked.
 *
 * `--cached --others --exclude-standard` is tracked files **plus** untracked ones git would
 * not ignore, so a component vendored right now is swept before it is ever staged and CI
 * answers the same. Asking git is also what keeps `reference/admin/dist/` out of it — a built
 * bundle carries every class it was given — along with `node_modules` and above all
 * `.claude/worktrees/`, where a harness puts a whole second checkout (ADR-0068).
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
    .filter((path) => ADMIN_SOURCE.some((tree) => path.startsWith(tree)));

  if (paths.length === 0) {
    // Failing open would be worse than failing: an empty list makes this whole file pass by
    // reading nothing, which is indistinguishable from reading everything.
    throw new Error(
      "git listed no Admin source file, so nothing was checked for a control that cannot be reached.",
    );
  }

  return paths;
}

const readText = (path: string) =>
  readFile(fileURLToPath(new URL(path, repoRoot)), "utf8");

describe("an action a Role cannot perform can still be reached", () => {
  it("finds no vendored recipe that takes its pointer events away", async () => {
    const paths = await adminSourcePaths();
    const offences = (
      await Promise.all(paths.map(async (path) => offencesIn(path, await readText(path))))
    ).flat();

    expect(offences.map(readable)).toEqual([]);
  });

  it("reads the files the rule is about", async () => {
    // Discovery is what makes this cover the next component vendored without an edit, and the
    // way discovery fails is by quietly reaching less than it did. These are the ones whose
    // absence would matter most: the file that offended, the recipe that never did, the
    // component the whole decision is implemented in, and the copy a Developer receives.
    const paths = await adminSourcePaths();

    expect(paths).toContain("reference/admin/src/components/ui/sidebar.tsx");
    expect(paths).toContain("reference/admin/src/components/ui/button.tsx");
    expect(paths).toContain("reference/admin/src/components/action-button.tsx");
    expect(paths).toContain(
      "packages/create-kobai/template/admin/src/components/ui/sidebar.tsx",
    );
  });

  it("would fail against a file that offends, and this is that file", async () => {
    // The red case, run against a real file on disk rather than a fixture: the needles this
    // file spells out are found by the same reading the sweep does.
    //
    // There is deliberately no assertion that the sweep skipped this file. `ADMIN_SOURCE` is
    // what excludes it, so such a line could not fail — the trap ADR-0049 names, and a
    // guardrail's own test is the last place to keep one. It needs none: a sweep widened far
    // enough to read `tests/` would go red on these very fixtures, which announces itself
    // more loudly than an expectation would.
    const offences = offencesIn(basename(thisFile), await readFile(thisFile, "utf8"));

    expect(offences.map((offence) => offence.variant)).toContain(
      "aria-disabled:pointer-events-none",
    );
    expect(offences.map((offence) => offence.variant)).toContain(
      "aria-disabled:[pointer-events:none]",
    );
  });

  it("leaves the disabled: variant alone", () => {
    // The ban is on the ARIA attribute, never on the real one. A control dead while a request
    // is in flight has nothing to explain, and both recipes in `sidebar.tsx` still carry
    // `disabled:pointer-events-none` — so a sweep that caught it would be red today, on a
    // line ADR-0063 has no argument with.
    expect(
      offencesIn(
        "sidebar.tsx",
        '"… focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 …"',
      ),
    ).toEqual([]);
  });

  it("catches the variant behind a group or a peer prefix", () => {
    // The same defect one element away: the control still fires no pointer events, so it can
    // still host nothing. One needle covers all three spellings, which is why it is a
    // substring rather than a word.
    const found = offencesIn(
      "some.tsx",
      [
        '"group-aria-disabled:pointer-events-none"',
        '"peer-aria-disabled:pointer-events-none"',
      ].join("\n"),
    );

    expect(found.map((offence) => offence.line)).toEqual([1, 2]);
  });

  it("names every line, not only the first", () => {
    // `sidebar.tsx` offended in two recipes, and a message that named one of them would have
    // sent a reader back for the other.
    expect(
      offencesIn(
        "sidebar.tsx",
        [
          '"a aria-disabled:pointer-events-none"',
          '"b aria-disabled:pointer-events-none"',
        ].join("\n"),
      ).map((offence) => offence.line),
    ).toEqual([1, 2]);
  });

  it("keeps the tooltip's recorded gap where a reader will meet it", async () => {
    // The other half of #199, and the half nothing else could see. Recording the gap rather
    // than fixing the primitive was the decision — but the note's own argument is that
    // `shadcn add tooltip --overwrite` takes a departure away in silence, and that is as true
    // of the note as it would have been of a fix. A record nothing holds is the shape this
    // whole file exists to replace, so both copies are asked for the two facts a reader needs:
    // that the primitive announces nothing, and where to go instead.
    for (const tooltip of [
      "reference/admin/src/components/ui/tooltip.tsx",
      "packages/create-kobai/template/admin/src/components/ui/tooltip.tsx",
    ]) {
      const source = await readText(tooltip);

      expect(source).toContain('no `role="tooltip"`');
      expect(source).toContain("components/action-button.tsx");
    }
  });

  it("is pointed at by the rule it holds", async () => {
    // A rule stated in prose and held nowhere is what `sidebar.tsx` was, so the statements
    // name the assertion. Reading them here is what stops the two drifting apart: rename this
    // file and both pointers have to move with it.
    expect(await readText("docs/agents/the-admin.md")).toContain(basename(thisFile));
    expect(await readText("reference/admin/src/components/ui/README.md")).toContain(
      basename(thisFile),
    );
  });
});
