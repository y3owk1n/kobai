import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * `toMatchObject({ metadata: {} })` asserts nothing, and this is what stops the next one.
 *
 * `toMatchObject` matches a nested object as a **subset**, and `{}` is a subset of every
 * object — so an assertion written that way passes against `{}`, against
 * `{ printer: "riso" }`, and against whatever a bug happened to leave in the bag. It reads
 * exactly like a test that the bag is empty, and it is not one.
 *
 * Prose had already lost this round. #169 wrote one to assert that a named `metadata`
 * **replaces** rather than merges — a rule ADR-0062 states and a Developer relies on — and
 * #172 found it passing just as happily against a merge that had kept the old keys. #186
 * then found three more still live, in `catalog.test.ts` and `place-order.test.ts`, written
 * after that fix landed. The rule itself is written down in `docs/agents/writing-tests.md`;
 * this file is what makes having read it optional.
 *
 * **Not a lint rule, and that was the ticket's open question.** Biome ships nothing for
 * this, so expressing it would mean introducing GritQL plugins as a mechanism for one rule —
 * and severity is not what is missing, since under ADR-0039 every finding fails the gate
 * already. A test is what the rest of this repository's rules have behind them, it can say
 * *why* in the failure it prints, and the shape is exactly decidable: an empty object
 * literal inside a `toMatchObject` argument is never an assertion, whatever it is the value
 * of.
 *
 * **This is not an audit of `toMatchObject`.** There are close to three hundred of them
 * across the workspace and most say the right thing — "these fields, whatever else the route
 * returns" is usually exactly what a test wants of a response body. Only the degenerate case
 * is named here; a subset match on a *populated* bag is left alone, because whether the
 * extra keys matter is a question about that test rather than about the matcher.
 */
const repoRoot = new URL("../", import.meta.url);
const run = promisify(execFile);

/**
 * The two matchers that take a **subset**, wherever the name is not the tail of a longer one.
 *
 * `expect.objectContaining({})` says exactly what `toMatchObject({})` says and says it just
 * as loudly, so a rule about one that let the other through would be half a rule. There are
 * none of either today, which is the moment to sweep for both.
 */
const MATCHER_CALL = /(?<![\w$])(?:toMatchObject|objectContaining)\s*\(/g;

/** What may sit in front of a quote without it opening a string. */
const WORD_CHARACTER = /[\w$]/;

/** An object literal with nothing in it — the whole of what this file looks for. */
const EMPTY_LITERAL = /\{\s*\}/g;

type Offence = { readonly line: number; readonly text: string };

/**
 * The source with its comments and string literals blanked out, character for character.
 *
 * Both would otherwise read as code, and both really do carry this exact text: the comment
 * in `catalog/update.test.ts` that explains the trap quotes the offending assertion, and the
 * fixtures at the foot of this file write several out in full. Blanked rather than removed,
 * so an offset still resolves to the line a Developer would open.
 *
 * **Two rules decide what opens a string, and both exist to stop this failing open.** A
 * blanked span that swallowed a real `toMatchObject` would take a live offence out of the
 * scan and report nothing about it — ADR-0049's trap, arriving as a green build. So a `"` or
 * `'` counts as an opener only when it has a partner before the end of its own line, which
 * neither may cross; and only when nothing word-like and no `/` sits directly in front of
 * it, which is what tells a string from an apostrophe in JSX prose (`don't … it's`) and from
 * a quote inside a regex literal (`/'/`). Both pairs would otherwise close over the code
 * between them. Biome formats every file here, so a real opener always follows a space or a
 * bracket; the fixtures at the foot of this file hold both cases.
 *
 * A template literal may legitimately cross a line and so gets the second rule only — a
 * tagged one is written `sql\`…\``, with the backtick against a word.
 */
function blankCommentsAndStrings(source: string): string {
  // Code units rather than code points: a spread would collapse a surrogate pair into one
  // element, and every offset after the first emoji would name the wrong line.
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== "\n") out[at] = " ";
    }
  };

  let at = 0;
  while (at < source.length) {
    const pair = source.slice(at, at + 2);
    if (pair === "//") {
      const newline = source.indexOf("\n", at);
      const stop = newline === -1 ? source.length : newline;
      blank(at, stop);
      at = stop;
      continue;
    }
    if (pair === "/*") {
      const close = source.indexOf("*/", at + 2);
      const stop = close === -1 ? source.length : close + 2;
      blank(at, stop);
      at = stop;
      continue;
    }
    const quote = source[at];
    if (
      (quote === '"' || quote === "'" || quote === "`") &&
      opensAString(source, at, quote)
    ) {
      const close = closingQuote(source, at, quote);
      if (close === -1) {
        at += 1;
        continue;
      }
      blank(at, close + 1);
      at = close + 1;
      continue;
    }
    at += 1;
  }

  return out.join("");
}

/**
 * Whether the quote at `at` opens a literal, rather than sitting inside something else.
 *
 * A `"` or `'` directly behind a word character or a `/` is an apostrophe or a regex, not an
 * opener — see `blankCommentsAndStrings`. A backtick is exempt, because a tagged template
 * puts one against the end of its tag.
 */
function opensAString(source: string, at: number, quote: string): boolean {
  if (quote === "`") return true;
  const before = source[at - 1];
  if (before === undefined) return true;
  return before !== "/" && !WORD_CHARACTER.test(before);
}

/** Where the literal opened at `open` closes, or `-1` if it never does. */
function closingQuote(source: string, open: number, quote: string): number {
  for (let at = open + 1; at < source.length; at += 1) {
    const char = source[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (char === quote) return at;
    // Neither of the two single-line quotes may cross one, so an opener that reaches the end
    // of its own line was never a string — see `blankCommentsAndStrings`.
    if (char === "\n" && quote !== "`") return -1;
  }
  return -1;
}

/** Where the argument list that opened just before `from` closes, or the end of the source. */
function closingParen(source: string, from: number): number {
  let depth = 1;
  for (let at = from; at < source.length; at += 1) {
    const char = source[at];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return source.length;
}

/** Every empty object literal this source hands to `toMatchObject`, with the line it is on. */
function emptyBagsMatchedAsSubsets(source: string): Offence[] {
  const code = blankCommentsAndStrings(source);
  const lines = source.split("\n");
  const offences: Offence[] = [];

  MATCHER_CALL.lastIndex = 0;
  let call = MATCHER_CALL.exec(code);
  while (call !== null) {
    const opens = call.index + call[0].length;
    const closes = closingParen(code, opens);

    for (const empty of code.slice(opens, closes).matchAll(EMPTY_LITERAL)) {
      const line = code.slice(0, opens + (empty.index ?? 0)).split("\n").length;
      offences.push({ line, text: (lines[line - 1] ?? "").trim() });
    }

    // Past the whole call rather than past its name: one `toMatchObject` cannot sit inside
    // another's argument, and resuming inside would report the same literal twice.
    MATCHER_CALL.lastIndex = closes;
    call = MATCHER_CALL.exec(code);
  }

  return offences;
}

/**
 * Every TypeScript file **git tracks**.
 *
 * Asked of git rather than of the filesystem, for the reason ADR-0068 gives: a harness puts
 * a whole second checkout under `.claude/worktrees/`, and a recursive read would sweep that
 * one's sources too and fail naming a file the reader is not in.
 *
 * Every `.ts` and `.tsx`, not only the ones named `*.test.ts`. An assertion is an assertion
 * wherever it is written, and this repository has two places that write them outside a test
 * file — `tests/support/` and `packages/core/src/testing/`, the second of which is promised
 * surface a Plugin author reads. Neither costs anything to include: `toMatchObject` is
 * vitest's and appears nowhere else, so widening the net catches helpers rather than noise.
 */
async function trackedSources(): Promise<string[]> {
  const { stdout } = await run(
    "git",
    ["ls-files", "--", ":(glob)**/*.ts", ":(glob)**/*.tsx"],
    { cwd: fileURLToPath(repoRoot) },
  );
  return stdout.trim().split("\n").filter(Boolean).sort();
}

describe("an assertion that an open bag is empty", () => {
  it("finds the repository's sources, so an empty scan cannot pass", async () => {
    const files = await trackedSources();

    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("packages/core/src/catalog/catalog.test.ts");
    expect(files).toContain("packages/core/src/testing/catalog.ts");
  });

  it("is written so that it can fail, everywhere in this repository", async () => {
    const files = await trackedSources();

    const offences: string[] = [];
    for (const file of files) {
      const source = await readFile(new URL(file, repoRoot), "utf8");
      for (const offence of emptyBagsMatchedAsSubsets(source)) {
        offences.push(`${file}:${offence.line} — ${offence.text}`);
      }
    }

    // `toEqual` on the bag, or on the whole body: `toMatchObject` cannot express emptiness,
    // so an empty literal inside one asserts nothing at all (docs/agents/writing-tests.md).
    expect(offences).toEqual([]);
  });
});

describe("the scan itself", () => {
  it("names the assertion it exists to catch, wherever the literal sits", () => {
    const found = emptyBagsMatchedAsSubsets(`
      await expect(response.json()).resolves.toMatchObject({
        title: "A2 poster",
        metadata: {},
        variants: [{ sku: "POSTER-A2", metadata: {} }],
      });
      expect(body).toMatchObject({});
    `);

    expect(found.map((offence) => offence.text)).toEqual([
      "metadata: {},",
      'variants: [{ sku: "POSTER-A2", metadata: {} }],',
      "expect(body).toMatchObject({});",
    ]);
  });

  it("leaves the assertions that can already fail alone", () => {
    const found = emptyBagsMatchedAsSubsets(`
      await expect(response.json()).resolves.toEqual({ id, metadata: {} });
      expect(created.metadata).toEqual({});
      expect(product.variants).toEqual([{ sku: "POSTER-A2", metadata: {} }]);
      expect(body).toMatchObject({ metadata: { printer: "riso" } });
    `);

    expect(found).toEqual([]);
  });

  it("reads neither a comment nor a string as the code it quotes", () => {
    const found = emptyBagsMatchedAsSubsets(`
      // The version of this that read toMatchObject({ metadata: {} }) passed just as
      // happily against a merge that had kept the old keys (#172).
      /* toMatchObject({ metadata: {} }) */
      expect(body).toMatchObject({ raw: "toMatchObject({ metadata: {} })" });
      expect(pattern).toMatchObject({ quotes: /["']/ });
    `);

    expect(found).toEqual([]);
  });

  it("sweeps the other matcher that takes a subset", () => {
    const found = emptyBagsMatchedAsSubsets(`
      expect(orders).toEqual([expect.objectContaining({ metadata: {} })]);
    `);

    expect(found.map((offence) => offence.text)).toEqual([
      "expect(orders).toEqual([expect.objectContaining({ metadata: {} })]);",
    ]);
  });

  /**
   * The one way this scan could fail *open*, watched rather than reasoned about.
   *
   * An apostrophe in JSX prose and a quote inside a regex literal both come in pairs, and a
   * pair that was read as a string would blank the code between them — taking a live offence
   * out of the scan and reporting nothing, which is a green build saying the rule holds. Each
   * line below carries a real offence between two such quotes.
   */
  it("does not read a pair of apostrophes as a string and swallow the code between", () => {
    const found = emptyBagsMatchedAsSubsets(
      [
        `render(<p>don't {expect(b).toMatchObject({ m: {} })} it's</p>);`,
        `const t = /'/; expect(c).toMatchObject({ m: {} }); const u = /'/;`,
      ].join("\n"),
    );

    expect(found.map((offence) => offence.line)).toEqual([1, 2]);
  });

  it("keeps counting lines through what it blanked out", () => {
    const found = emptyBagsMatchedAsSubsets(
      [
        "/*",
        " * A block comment, over lines.",
        " */",
        "x.toMatchObject({ m: {} });",
      ].join("\n"),
    );

    expect(found).toEqual([{ line: 4, text: "x.toMatchObject({ m: {} });" }]);
  });
});
