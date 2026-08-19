import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * A Role and a Merchant are arranged through the routes that make them, kept true by the
 * build rather than by whoever last read the convention.
 *
 * Before #173 there was no route that made a Role, so Core's own tests wrote
 * `insert into core_role (name, permissions) values (…)` and said so in a comment: *"Roles
 * are rows, so a narrower one is a row."* That was true, and it was the finding rather than
 * the shortcut — #173 built the routes (ADR-0066) and converted all six sites. Nothing held
 * the result, so a seventh site added tomorrow would have passed the gate.
 *
 * The reason to care is not tidiness. **A test that builds its Role with SQL is not
 * exercising the surface a Merchant uses**, so it passes just as well against a route that
 * is broken, missing, or gated wrongly — the same argument ADR-0010 makes for the Admin
 * using only the public API. A capability reached around the front door proves nothing about
 * the front door.
 *
 * `tests/no-push-script.test.ts` is the house pattern for this shape: a rule everyone agrees
 * on, held by something that reads the repository rather than by a convention.
 *
 * **This is the second thing here that reads TypeScript, and that is worth someone's
 * attention rather than nobody's.** `tests/an-empty-bag-is-asserted-so-it-can-fail.test.ts`
 * (#186) asks git for the same set of files and lexes the same comments and strings — to
 * *blank* them, where this one wants what is inside them, which is why neither could call the
 * other as it stands. AGENTS.md's own verdict on `kobai_dotenv` — *"a second parser would be
 * two answers"* — applies, and the two answers already differ in what they know: the fail-open
 * this reader was fixed for is a hazard the other's line-local blanking never had, and the
 * `/` handling that fixed it is knowledge only this one has. One reader under `tests/support/`
 * that offers both readings is the honest end state; extracting it is its own change, because
 * it edits a guardrail this ticket is not about.
 */
const run = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

/**
 * The tables a test must not write, and what writes each one instead.
 *
 * **Two, not one and not every table.** `core_merchant` joins `core_role` because #173 made
 * it reachable too and the argument is identical: a second Merchant conjured in SQL says
 * nothing about whether `POST /admin/merchants` works, and nothing writes that table
 * directly today, so it costs no exemption to forbid.
 *
 * `core_store` is deliberately **not** here, and it is the case that shows why the list is a
 * decision rather than an oversight: `packages/core/src/store/store.test.ts` inserts a second
 * Store row on purpose, because the singleton constraint is that test's subject and no route
 * could arrange a violation of it. A table whose direct write is somebody's subject does not
 * belong in a ban — see the note on `insert` below for the same reasoning inside a table.
 */
const ARRANGED_THROUGH_A_ROUTE: Readonly<Record<string, string>> = {
  core_role: "POST /admin/roles",
  core_merchant: "POST /admin/merchants",
};

/**
 * **`insert` only, so that no allowlist is needed.**
 *
 * `packages/core/src/db/updated-at.test.ts` writes `core_role` directly on purpose: it is the
 * test that Core does not mediate every write (ADR-0037), so reaching past Core *is* its
 * subject. It uses `update core_role`, never `insert`, so banning the statement that *builds*
 * a Role permits it without naming it — and an allowlist is a second thing to keep correct,
 * whose first entry is usually the one that should have made somebody think.
 *
 * Tolerant of the spellings Postgres accepts for the same statement — a schema qualifier, a
 * quoted identifier, a line break between the words — because none of them changes what the
 * statement does, and a ban that only knows one spelling is a ban on typing it that way.
 */
const buildsOneIn = (table: string) =>
  new RegExp(`\\binsert\\s+into\\s+(?:"?\\w+"?\\s*\\.\\s*)?"?${table}(?!\\w)"?`, "gi");

/**
 * This file, the one thing the scan does not read.
 *
 * It is the assertion rather than an exemption: the fixtures below spell both offences out on
 * purpose, and `"would fail against a file that offends"` scans this very file to watch the
 * scan find them. Derived from `import.meta.url` rather than written down, so renaming this
 * file cannot silently leave a stale path excluded.
 */
const thisFile = fileURLToPath(import.meta.url);

/** One direct write, as its file, its line, and the statement that offends. */
type Offence = {
  readonly path: string;
  readonly line: number;
  readonly table: string;
  readonly route: string;
  /** What was found, whitespace collapsed, because a SQL statement wraps over lines. */
  readonly statement: string;
};

/** The failure a reader can act on: which file, which line, and what to do instead. */
const readable = (offence: Offence) =>
  `${offence.path}:${offence.line} builds a ${offence.table} row with SQL (${offence.statement}) — arrange it through ${offence.route}`;

/**
 * Every file the rule applies to: a test, or a helper a test arranges through.
 *
 * The rule is about the **seam**, not about a directory — `docs/agents/writing-tests.md` says
 * so — and a shortcut hidden in `@kobai/core/testing` would be worse than one in a test file,
 * not better, because every Plugin author's tests inherit it. So a file counts when it is
 * named `*.test.ts` or sits in a `testing/` or `tests/` directory.
 *
 * Production code is deliberately out of scope. Core has to write these tables somehow — it
 * does so through Drizzle today, and `packages/core/migrations/0003_seed_owner_role.sql`
 * seeds the owner Role in SQL because a migration is SQL by definition. Neither is a test
 * reaching around a route, and forbidding them here would be this file deciding something
 * #173 did not.
 */
const isATestSeam = (path: string) =>
  /\.test\.tsx?$/.test(path) || /(^|\/)(tests|testing)\//.test(path);

/**
 * The files to read, asked of git rather than walked.
 *
 * `--cached --others --exclude-standard` is tracked files **plus** untracked ones git would
 * not ignore, which is the pair that matters: the second half means a test being written
 * right now is scanned before it is ever staged, and the first half means the answer in CI is
 * the same one. Asking git is also what keeps this out of everything `.gitignore` covers —
 * `node_modules`, `dist`, and above all `.claude/worktrees/`, where a harness puts a whole
 * second checkout of this repository (ADR-0068 § the gate lints what git tracks).
 */
async function testSeamPaths(): Promise<string[]> {
  const { stdout } = await run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: fileURLToPath(repoRoot), maxBuffer: 32 * 1024 * 1024 },
  );

  const paths = stdout
    .split("\0")
    .filter((path) => path.length > 0 && isATestSeam(path))
    .filter((path) => fileURLToPath(new URL(path, repoRoot)) !== thisFile);

  if (paths.length === 0) {
    // Failing open would be worse than failing: an empty list makes this whole file pass by
    // reading nothing, which is indistinguishable from reading everything.
    throw new Error(
      "git listed no test file, so nothing was checked for a Role or a Merchant built with SQL.",
    );
  }

  return paths;
}

const readText = (path: string) =>
  readFile(fileURLToPath(new URL(path, repoRoot)), "utf8");

/** Every direct write in one file, in the order they appear. */
function offencesIn(path: string, source: string): Offence[] {
  const found: Offence[] = [];

  for (const literal of stringLiterals(source, path)) {
    for (const [table, route] of Object.entries(ARRANGED_THROUGH_A_ROUTE)) {
      // Every match, not the first: one migration-shaped literal can carry two statements,
      // and a message that named one of them would send a reader back for the other.
      for (const match of literal.text.matchAll(buildsOneIn(table))) {
        const preceding = literal.text.slice(0, match.index).match(/\n/g)?.length ?? 0;
        found.push({
          path,
          line: literal.line + preceding,
          table,
          route,
          statement: match[0].replace(/\s+/g, " "),
        });
      }
    }
  }

  return found;
}

/**
 * One string literal, which is where SQL lives.
 *
 * **Read as literals rather than grepped, because the words survive in prose.** Six places in
 * this repository still say `insert into core_role` — the four test files that were converted
 * explain what they no longer do, and ADR-0066 and `docs/agents/writing-tests.md` record the
 * decision. A grep would have to be blinded to all of them on the day it was written, and to
 * the next comment somebody writes about the history. A literal, meanwhile, is the only way
 * SQL reaches Postgres: through `kobai.database.query(…)` or a `sql` template.
 */
type StringLiteral = {
  /** The content, with escapes resolved and any `${…}` holes left out. */
  readonly text: string;
  /** The 1-based line the literal opens on. */
  readonly line: number;
};

/** What the reader is inside. A template's `${…}` hole is code again, so this nests. */
type Frame =
  | { kind: "code"; braces: number }
  | { kind: "template"; text: string; line: number };

/**
 * Every string literal in a TypeScript source, single-quoted, double-quoted or backticked.
 *
 * Hand-written because there is nothing to hand it to: TypeScript 7 ships **no programmatic
 * API** — see AGENTS.md § *There is no TypeScript compiler API* — and this repository's root
 * toolchain is the guardrail suite's and nothing else. It is the same call `vitest.config.ts`
 * makes when it reads a `tsconfig` with `jsonc-parser`: what this needs is one narrow fact
 * about a file's text, not a compiler.
 *
 * A template's interpolations are dropped rather than joined, so `insert into ${table}` is not
 * read as a write to whatever the next chunk happens to start with.
 *
 * **What it does not reach**, said out loud rather than left to be discovered: SQL is not the
 * only way to write a row. `kobai.db` is a Drizzle instance and `packages/core/src/db/schema.ts`
 * exports the table objects, so `db.insert(role).values(…)` inside `packages/core` would build
 * a Role with no statement to find. No test does that today — every direct write in the suite
 * is a `query()` or an `execute(sql\`…\`)` — and catching it is a different mechanism, matching
 * an identifier that an import is free to rename, rather than a stricter reading of a string.
 * `tests/no-push-script.test.ts` bounds itself the same way and for the same reason.
 */
function stringLiterals(source: string, path: string): StringLiteral[] {
  const found: StringLiteral[] = [];
  // Innermost last. The bottom frame is the file itself and is never popped.
  const stack: Frame[] = [{ kind: "code", braces: 0 }];
  const at = (offset: number) => source[offset] ?? "";
  /** The last significant token in code, which is what tells `/` apart from `/`. */
  let previous = "";
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const frame = stack.at(-1);
    if (frame === undefined) break;
    const char = at(index);

    if (frame.kind === "template") {
      if (char === "\\") {
        if (at(index + 1) === "\n") line += 1;
        frame.text += at(index + 1);
        index += 2;
      } else if (char === "`") {
        found.push({ text: frame.text, line: frame.line });
        stack.pop();
        previous = "`";
        index += 1;
      } else if (char === "$" && at(index + 1) === "{") {
        stack.push({ kind: "code", braces: 0 });
        previous = "";
        index += 2;
      } else {
        if (char === "\n") line += 1;
        frame.text += char;
        index += 1;
      }
      continue;
    }

    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }

    if (char === "/" && at(index + 1) === "/") {
      while (index < source.length && at(index) !== "\n") index += 1;
      continue;
    }

    if (char === "/" && at(index + 1) === "*") {
      index += 2;
      while (index < source.length && !(at(index) === "*" && at(index + 1) === "/")) {
        if (at(index) === "\n") line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }

    // A regular expression, skipped whole. Not a nicety: `/[{]/` counts as an open brace
    // otherwise, and one unbalanced brace desynchronises everything after it — see the
    // check at the foot of this function for what happens when it still goes wrong.
    if (char === "/" && opensARegex(previous)) {
      const end = regexEndsAt(source, index);
      if (end !== undefined) {
        previous = "/";
        index = end;
        continue;
      }
    }

    // An identifier or a number, read whole, so that `return /…/` can be told from `x / y`.
    if (/[\w$]/.test(char)) {
      let word = "";
      while (index < source.length && /[\w$]/.test(at(index))) {
        word += at(index);
        index += 1;
      }
      previous = word;
      continue;
    }

    if (char === "'" || char === '"') {
      const quoted = quotedAt(source, index, char);
      if (quoted === undefined) {
        // It never closed on its line, so it was never a string — an apostrophe inside JSX
        // text, most likely, a regular expression having been skipped whole above. Step over
        // the quote and nothing else, so one character is misread rather than the rest of
        // the line; anything worse than that is caught by the check below.
        previous = char;
        index += 1;
        continue;
      }
      found.push({ text: quoted.text, line });
      line += quoted.lines;
      previous = char;
      index = quoted.end;
      continue;
    }

    if (char === "`") {
      stack.push({ kind: "template", text: "", line });
      index += 1;
      continue;
    }

    // Braces are counted so that the `}` closing a `${…}` hole can be told from the ones
    // belonging to an object or a block written inside it.
    if (char === "{") {
      frame.braces += 1;
      previous = char;
      index += 1;
      continue;
    }
    if (char === "}") {
      if (frame.braces > 0) frame.braces -= 1;
      else if (stack.length > 1) stack.pop();
      previous = char;
      index += 1;
      continue;
    }

    if (!/\s/.test(char)) previous = char;
    index += 1;
  }

  // **A reader that lost its place says so, rather than passing what it could not read.**
  // Every `{` in a TypeScript file is closed, so anything else means this reader mis-lexed
  // something — and the damage is silent: a stray open brace turns a template's closing `}`
  // into an ordinary one, leaving the reader in code where the file has text, so every
  // literal after that point goes unseen and the file passes. Failing open is the one
  // outcome a guardrail may not have.
  const rest = stack.at(-1);
  if (stack.length !== 1 || rest?.kind !== "code" || rest.braces !== 0) {
    throw new Error(
      `${path} could not be read to its end: the reader finished ${stack.length - 1} template(s) deep, so anything after that point was never checked for a Role or a Merchant built with SQL. That is a defect in the reader above, not necessarily in the file.`,
    );
  }

  return found;
}

/**
 * Whether a `/` here opens a regular expression rather than dividing, judged the way every
 * JavaScript lexer judges it: by what came before. After a value — an identifier, a number,
 * a closing bracket, a string — a `/` divides; anywhere a value could start, it quotes one.
 */
function opensARegex(previous: string): boolean {
  return (
    previous === "" ||
    BEFORE_A_VALUE.has(previous) ||
    (previous.length === 1 && "([{,;:=!&|?+-*%~^<>".includes(previous))
  );
}

/** The keywords a regular expression can follow. `x in /y/` is not a thing; `case /y/` is. */
const BEFORE_A_VALUE = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/**
 * The offset just past the regular expression starting at `start`, or `undefined` where
 * there is none — a `/` that closes on no line of its own is a division after all.
 *
 * A `/` inside a character class does not close it, which is the whole reason this is a
 * function rather than an `indexOf`.
 */
function regexEndsAt(source: string, start: number): number | undefined {
  let index = start + 1;
  let inClass = false;

  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === "\n") return undefined;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (/[a-z]/.test(source[index] ?? "")) index += 1;
      return index;
    }
    index += 1;
  }

  return undefined;
}

/**
 * A `'…'` or `"…"` literal starting at `start`, or `undefined` where it does not close on
 * its own line — which is a quote that was never opening a string.
 */
function quotedAt(
  source: string,
  start: number,
  quote: string,
): { text: string; end: number; lines: number } | undefined {
  let text = "";
  let lines = 0;
  let index = start + 1;

  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === "\n") return undefined;
    if (char === "\\") {
      // A backslash-newline is a line continuation: the string carries on, and so must the
      // line count, or every line reported after it is wrong.
      if ((source[index + 1] ?? "") === "\n") lines += 1;
      text += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === quote) return { text, end: index + 1, lines };
    text += char;
    index += 1;
  }

  return undefined;
}

describe("a Role and a Merchant are made through the routes that make them", () => {
  it("finds no test that builds one with SQL", async () => {
    const paths = await testSeamPaths();
    const offences = (
      await Promise.all(paths.map(async (path) => offencesIn(path, await readText(path))))
    ).flat();

    expect(offences.map(readable)).toEqual([]);
  });

  it("reads the files the rule is about", async () => {
    // Discovery is what makes this cover the next test file without an edit, and the way
    // discovery fails is by quietly reaching less than it did. These four are the ones whose
    // absence would matter most: the test that reaches past Core on purpose, the test that
    // owns the routes, the harness every Plugin author's tests go through, and the reference
    // Project, which is a Developer's tests as much as it is kobai's.
    const paths = await testSeamPaths();

    expect(paths).toContain("packages/core/src/db/updated-at.test.ts");
    expect(paths).toContain("packages/core/src/auth/role.test.ts");
    expect(paths).toContain("packages/core/src/testing/merchant.ts");
    expect(paths).toContain("reference/src/server.test.ts");
  });

  it("would fail against a file that offends, and this is that file", async () => {
    // The red case, run against a real file on disk rather than a fixture: the offences the
    // fixtures below spell out are found by the same reading the scan does. It is also what
    // makes the one exclusion honest — this file is skipped because it is the assertion, and
    // an exclusion that made no difference would be decoration.
    const offences = offencesIn(basename(thisFile), await readFile(thisFile, "utf8"));

    expect(offences.map((offence) => offence.table)).toContain("core_role");
    expect(offences.map((offence) => offence.table)).toContain("core_merchant");
    expect(await testSeamPaths()).not.toContain(`tests/${basename(thisFile)}`);
  });

  it("is pointed at by the rule it holds", async () => {
    // A rule stated in prose and held nowhere is what this file was written about, so the
    // statement names the assertion. Reading it here is what stops the two drifting apart:
    // rename this file and the pointer has to move with it.
    const guidance = await readText("docs/agents/writing-tests.md");

    expect(guidance).toContain(basename(thisFile));
  });
});

/**
 * The scan is only as good as its reading, so these cover it against the ways a direct write
 * is actually written and the ways the words appear when nothing is wrong. They go through
 * `offencesIn`, the same reader the scan itself uses.
 */
describe("reading a test file", () => {
  const scan = (source: string) => offencesIn("some.test.ts", source).map(readable);

  it("catches a Role built on the test database's own connection", () => {
    expect(
      scan(`
        await kobai.database.query(
          "insert into core_role (name, permissions) values ($1, $2)",
          ["bookkeeper", ["order:read"]],
        );
      `),
    ).toHaveLength(1);
  });

  it("catches one built through a sql template, wrapped over lines", () => {
    // The shape `store.test.ts` uses for its deliberate direct write, so it is the shape the
    // next shortcut is likeliest to take.
    const found = scan(`
      await kobai.db.execute(sql\`insert into
        core_role (name, permissions) values ('bookkeeper', '["order:read"]')\`);
    `);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("insert into core_role");
  });

  it("catches a Merchant built the same way", () => {
    expect(
      scan(`await kobai.database.query("insert into core_merchant (email) …");`),
    ).toEqual([
      "some.test.ts:1 builds a core_merchant row with SQL (insert into core_merchant) — arrange it through POST /admin/merchants",
    ]);
  });

  it("catches the spellings Postgres treats as the same statement", () => {
    // A schema qualifier and a quoted identifier. A line break between the words is the
    // third, and the wrapped `sql` template above is already that case.
    expect(scan(`query("INSERT INTO public.core_role (name) values ($1)")`)).toHaveLength(
      1,
    );
    expect(scan(`query('insert into "core_role" (name) values ($1)')`)).toHaveLength(1);
  });

  it("names the line the statement is on, not the line the literal opened on", () => {
    // A SQL template usually opens with a backtick and says nothing else on that line.
    const found = scan(`await kobai.database.query(\`
      insert into core_role (name, permissions)
      values ($1, $2)
    \`);`);

    expect(found[0]).toContain("some.test.ts:2");
  });

  it("passes a comment describing what the file no longer does", () => {
    // Four converted test files, ADR-0066 and docs/agents/writing-tests.md all say these
    // words in prose. A scan that could not tell prose from SQL would have been red on the
    // day it was written, and would stay red for as long as the history is worth explaining.
    expect(
      scan(`
        // Made through POST /admin/roles since #173, rather than with insert into core_role.
        /**
         * They used to be built with \`insert into core_role …\` and a comment saying
         * "Roles are rows, so a narrower one is a row".
         */
        const role = await kobai.request("/admin/roles", json(narrow, owner.headers));
      `),
    ).toEqual([]);
  });

  it("passes the test that reaches past Core on purpose", () => {
    // ADR-0037's subject, and the reason the ban is on `insert` alone: `updated-at.test.ts`
    // needs a write Core never saw, and gets one without an entry in any list.
    expect(
      scan(`
        await kobai.database.query("update core_role set metadata = $1 where id = $2", [
          JSON.stringify({ renamedBy: "a Project, in SQL Core never saw" }),
          seeded.id,
        ]);
        const [seeded] = await kobai.database.query(
          "select id, updated_at from core_role order by created_at limit 1",
        );
      `),
    ).toEqual([]);
  });

  it("passes a direct write to a table no route could arrange", () => {
    // `store.test.ts` inserts a second Store because the singleton constraint is its subject.
    // A ban wide enough to catch that one would have needed the allowlist this one avoids.
    expect(
      scan(
        "await kobai.db.execute(sql`insert into core_store (singleton, name) values (false, 'second')`);",
      ),
    ).toEqual([]);
  });

  it("passes a write to a table whose name merely starts the same way", () => {
    expect(scan(`query("insert into core_role_grant (role_id) values ($1)")`)).toEqual(
      [],
    );
  });

  it("does not read the words as SQL when they are assembled from a variable", () => {
    // The chunks either side of a hole are separate literals, so neither one is a statement.
    expect(scan(`query(\`insert into \${table} (name) values ($1)\`)`)).toEqual([]);
  });

  it("keeps its place past a brace inside a regular expression", () => {
    // The reader counts braces so it can find the `}` that closes a `${…}` hole, and a `{`
    // inside a regular expression is not one of them. Miscounting here is the expensive
    // mistake: the hole never closes, so the reader stays in code where the file has text
    // and everything after it — here, an offence on the very next line — goes unseen.
    expect(
      scan(`
        const a = \`insert into core_role (name) values (\${x.replace(/[{]/g, "")})\`;
        const b = 'insert into core_merchant (email) values ($1)';
      `),
    ).toHaveLength(2);
  });

  it("keeps its place past a regular expression that contains a slash", () => {
    // The shape that made this a fail-open rather than a curiosity, taken from
    // `tests/a-generated-project-boots.test.ts`, which writes an `.npmrc` line. Read
    // naively, the `\/\/` in the pattern is a `//` comment: it ate the rest of the line,
    // including the `}` closing the hole it sat in, and the reader was left one frame deep
    // for the rest of the file. Everything after it — five lines that a probe proved
    // invisible — went unchecked while the build stayed green.
    const found = scan(`
      await writeFile(join(project, ".npmrc"), \`//\${registry.url.replace(/^https?:\\/\\//, "")}/:_authToken=x\`);
      await kobai.database.query("insert into core_role (name) values ($1)");
    `);

    expect(found).toHaveLength(1);
  });

  it("refuses to pass a file it lost its place in", () => {
    // Whatever else the reader gets wrong, it may not go quiet. A file it cannot finish
    // reading is a file nothing has checked, and that must read as a failure rather than
    // as a pass.
    expect(() => scan("const unfinished = `${")).toThrow(/could not be read to its end/);
  });

  it("names both statements when one literal carries two", () => {
    expect(
      scan(`await kobai.database.query(\`
        insert into core_role (name) values ('bookkeeper');
        insert into core_merchant (email) values ('a@b.c');
      \`);`),
    ).toHaveLength(2);
  });

  it("keeps reading past an apostrophe that is not opening a string", () => {
    // A regular expression is the case: `/don't/` opens a quote that never closes, and a
    // reader that swallowed the rest of the file would go blind at the first one.
    expect(
      scan(`
        const humanised = name.replace(/doesn't/, "does not");
        await kobai.database.query("insert into core_role (name) values ($1)", [name]);
      `),
    ).toHaveLength(1);
  });
});
