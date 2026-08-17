import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * What "green" means, kept true by the build rather than by a reviewer's memory.
 *
 * Biome 2 re-tiered its default rule severities: most `style` and `complexity` rules
 * dropped to `info`, most `suspicious` and the `noUnused*` family to `warn`, and **`biome
 * ci` exits zero on both**. Under Biome 1 several of those were errors. So the 1 → 2
 * upgrade in #28 loosened the gate without anybody choosing to, and it stayed loose long
 * enough for three real unused-code findings to sit on `main` being reported on every run
 * and failing nothing (#45, #75).
 *
 * The decision this file enforces is in
 * `docs/adr/0039-the-lint-gate-fails-on-every-finding.md`: **the floor is `warn`, and
 * nothing Biome reports may sit below it.** Two mechanisms hold that up and each covers
 * what the other cannot:
 *
 * - `--error-on-warnings` on the invocation turns `warn` into a non-zero exit. It covers
 *   the ~90 recommended rules that default to `warn`, and keeps covering rules Biome adds
 *   at that tier later, because it names no rules.
 * - `biome.json` lifts the recommended rules that default to `info` up to `warn`. No flag
 *   can do this — `--error-on-warnings` ignores `info`, and `--diagnostic-level` only
 *   decides what is *printed*.
 *
 * The last test is the one that matters most, and it is the reason this file exists rather
 * than a line in a checklist. The others prove the mechanism works *today*; that one fails
 * the build the day Biome re-tiers again or ships a new recommended rule below the floor —
 * which is the failure that produced #45, caught the moment it recurs instead of whenever
 * someone next thinks to re-check.
 */
const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const biomeBin = join(repoRoot, "node_modules/.bin/biome");

/** The severity below which a finding would be reported and not acted on. */
const FLOOR = "warn";

/**
 * `nursery` is excluded because the `recommended` preset does not enable it, so its rules
 * are off whatever severity they carry. `biome explain` still reports some of them as
 * recommended — it is describing what they would be once promoted out of nursery, not what
 * this configuration turns on. The final test asserts the config never opts in, which is
 * what makes skipping the group safe rather than merely convenient.
 */
const GROUPS = [
  "a11y",
  "complexity",
  "correctness",
  "performance",
  "security",
  "style",
  "suspicious",
] as const;

const SEVERITIES = ["info", "warn", "error"] as const;
type Severity = (typeof SEVERITIES)[number];

/**
 * One rule still to be judged, and how it came to be enabled.
 *
 * `explicitlyOn` matters because `"on"` is legal Biome for *enable at the default severity*,
 * and it turns a rule on that the `recommended` preset leaves off. Such a rule has to be
 * judged by that default like any other — skipping it because it is not recommended would
 * leave a deliberately enabled rule sitting below the floor unreported.
 */
type Rule = { group: string; rule: string; explicitlyOn: boolean };

/** What Biome says about a rule when it has not been configured here. */
type RuleDefault = { severity: Severity; recommended: boolean };

function parseJsonFile(text: string, path: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join(", ");
    throw new Error(`Could not parse ${path}: ${detail}.`);
  }
  return value;
}

type BiomeConfig = {
  linter?: {
    rules?: Record<string, unknown> & { preset?: string };
  };
  overrides?: { linter?: unknown }[];
};

type DevboxConfig = { shell?: { scripts?: Record<string, string> } };

let biomeConfig: BiomeConfig;
let scripts: Record<string, string>;

beforeAll(async () => {
  biomeConfig = parseJsonFile(
    await readFile(join(repoRoot, "biome.json"), "utf8"),
    "biome.json",
  ) as BiomeConfig;
  const devbox = parseJsonFile(
    await readFile(join(repoRoot, "devbox.json"), "utf8"),
    "devbox.json",
  ) as DevboxConfig;
  scripts = devbox.shell?.scripts ?? {};
});

/**
 * The flags the gate lints with, read out of `devbox.json` rather than hard-coded *here*.
 *
 * The two fixture tests below would otherwise prove something about a command nobody runs,
 * which is the shape of the bug this file exists to catch: taking the flags from the script
 * means deleting `--error-on-warnings` there turns those tests red. The last test does spell
 * the whole script out, deliberately — pinning its exact text is that test's subject.
 */
function lintFlags(): string[] {
  const script = scripts.lint;
  const match = /^pnpm exec biome ci \.(?<flags>.*)$/.exec(script ?? "");
  if (!match?.groups) {
    throw new Error(
      `devbox.json's "lint" script is ${JSON.stringify(script)}, which this test cannot read. It expects \`pnpm exec biome ci .\` followed by flags, because it reruns those same flags against a fixture. Update this test alongside the script.`,
    );
  }
  return (match.groups.flags ?? "").split(" ").filter(Boolean);
}

/** Runs the gate's own lint flags over one throwaway file and reports how it exited. */
async function lintFixture(
  filename: string,
  source: string,
): Promise<{ code: number; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kobai-lint-floor-"));
  try {
    await writeFile(join(dir, filename), source);
    try {
      const { stdout } = await run(
        biomeBin,
        ["ci", dir, "--config-path", repoRoot, "--reporter=summary", ...lintFlags()],
        { cwd: repoRoot },
      );
      return { code: 0, output: stdout };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("the lint gate", () => {
  /**
   * `noExplicitAny` is Biome's own `warn` and this repository does not touch its severity,
   * so what fails here is the flag and nothing else. Picking a rule the config *did*
   * promote would prove the promotion twice and the flag not at all.
   */
  it("fails on a rule Biome reports at warn", async () => {
    const { code, output } = await lintFixture(
      "warn-level.ts",
      "export function widen(value: unknown): any {\n  return value;\n}\n",
    );

    expect(output).toContain("lint/suspicious/noExplicitAny");
    expect(code).not.toBe(0);
  });

  /**
   * `useTemplate` is Biome's own `info`, which no flag can fail on — `--error-on-warnings`
   * ignores that tier entirely. So this passes only because `biome.json` lifted the rule to
   * the floor, and it is the half of the decision the flag cannot carry.
   */
  it("fails on a rule Biome reports at info", async () => {
    const { code, output } = await lintFixture(
      "info-level.ts",
      'export const greet = (n: string): string => "Hello, " + n;\n',
    );

    expect(output).toContain("lint/style/useTemplate");
    expect(code).not.toBe(0);
  });

  /**
   * The local command and the gate are the same command.
   *
   * A gate stricter than the command a Developer is told to run reproduces #45 at a new
   * seam: `devbox run lint` passes, the pull request goes red, and the difference is
   * invisible in both places. `devbox run format` is where leniency belongs — it rewrites
   * rather than reports.
   */
  it("lints identically locally and in the gate", () => {
    expect(scripts.lint).toBe("pnpm exec biome ci . --error-on-warnings");
    expect(scripts.ci).toContain(scripts.lint);
  });

  /**
   * The drift guard: no rule this configuration enables may sit below the floor.
   *
   * This is the assertion that survives the next re-tiering. It reads every rule's default
   * severity from Biome itself rather than from a list checked in beside it, so a Biome
   * upgrade that demotes a rule, or adds a recommended one at `info`, fails here — naming
   * the rule and what to do about it — instead of quietly widening what the gate lets
   * through. That is exactly how #45 was allowed to happen.
   */
  it("leaves no enabled rule below the floor", async () => {
    const rules = biomeConfig.linter?.rules ?? {};
    expect(rules.preset).toBe("recommended");
    expect(rules.nursery).toBeUndefined();

    // This sweep judges `linter.rules` and nothing else, so an override that set a severity
    // of its own would be a second, unjudged place for a rule to sit below the floor. There
    // are none — the one override in `biome.json` is a JSON parser setting. If a linter
    // override is ever wanted, teach this test to walk it rather than deleting the guard.
    expect(
      (biomeConfig.overrides ?? []).filter((entry) => entry.linter !== undefined),
    ).toEqual([]);

    const schema = parseJsonFile(
      await readFile(
        join(repoRoot, "node_modules/@biomejs/biome/configuration_schema.json"),
        "utf8",
      ),
      "biome's configuration schema",
    ) as { $defs: Record<string, { properties?: Record<string, unknown> }> };

    const below: string[] = [];
    /**
     * Every rule still to be judged, as one queue rather than one queue per group.
     * `biome explain` is a process spawn each, and the groups differ in size by an order of
     * magnitude, so per-group parallelism spends most of its time waiting on `style` alone.
     */
    const pending: Rule[] = [];
    for (const group of GROUPS) {
      const configured = (rules[group] ?? {}) as Record<string, unknown>;
      for (const rule of ruleNames(schema, group)) {
        const explicit = severityOf(configured[rule]);
        if (explicit === "off") continue;
        if (explicit && explicit !== "on") {
          if (rank(explicit) < rank(FLOOR)) below.push(`${group}/${rule}`);
          continue;
        }
        pending.push({ group, rule, explicitlyOn: explicit === "on" });
      }
    }

    let next = 0;
    await Promise.all(
      Array.from({ length: 24 }, async () => {
        for (let i = next++; i < pending.length; i = next++) {
          const { group, rule, explicitlyOn } = pending[i] as Rule;
          const { severity, recommended } = await explain(rule);
          // Not recommended and not turned on by name, so nothing enables it.
          if (!recommended && !explicitlyOn) continue;
          if (rank(severity) < rank(FLOOR)) below.push(`${group}/${rule}`);
        }
      }),
    );

    expect(
      below.sort(),
      `These rules are enabled but sit below "${FLOOR}", so \`biome ci --error-on-warnings\` reports them and exits zero. Either promote each to "${FLOOR}" under its group in biome.json, or turn it "off" deliberately. See docs/adr/0039-the-lint-gate-fails-on-every-finding.md.`,
    ).toEqual([]);
  }, 120_000);
});

function rank(severity: string): number {
  return { info: 0, warn: 1, error: 2 }[severity] ?? 3;
}

/** A rule's configured value is either a severity string or `{ level, options }`. */
function severityOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "level" in value) {
    const level = (value as { level?: unknown }).level;
    return typeof level === "string" ? level : undefined;
  }
  return undefined;
}

function ruleNames(
  schema: { $defs: Record<string, { properties?: Record<string, unknown> }> },
  group: string,
): string[] {
  const capitalised = group.charAt(0).toUpperCase() + group.slice(1);
  const properties = schema.$defs[capitalised]?.properties ?? {};
  return Object.keys(properties).filter(
    (name) => name !== "recommended" && name !== "preset",
  );
}

const explained = new Map<string, Promise<RuleDefault>>();

/**
 * A rule's default severity, asked of the Biome binary that will run in the gate.
 *
 * Read from the tool rather than from a table beside it, because a table is a second copy
 * of Biome's defaults and this whole file exists because the first copy went stale.
 */
function explain(rule: string): Promise<RuleDefault> {
  const cached = explained.get(rule);
  if (cached) return cached;
  const pending = run(biomeBin, ["explain", rule], { cwd: repoRoot }).then(
    ({ stdout }) => {
      const reported = /Default severity:\s*(\S+)/.exec(stdout)?.[1];
      const severity = SEVERITIES.find((known) => known === reported);
      if (!severity) {
        throw new Error(
          `\`biome explain ${rule}\` did not report a default severity this test recognises. Biome's output format has changed and this test needs updating — do not delete the assertion to get green.`,
        );
      }
      return { severity, recommended: /This rule is recommended/.test(stdout) };
    },
  );
  explained.set(rule, pending);
  return pending;
}
