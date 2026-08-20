import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { testPostgresUrl } from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * The two-sources-must-agree defect (#21), on the number nothing derives.
 *
 * A worktree gets `POSTGRES_PORT` written into its own `.env`, and `compose.yaml` and
 * `vitest.config.ts` both read that one value — so the container's published port and the
 * address the harness dials come from one place and cannot drift apart (ADR-0084,
 * AGENTS.md § The ports belong to the checkout). **That is the path the gate runs on, which
 * is exactly why the gate cannot see what this file is about.**
 *
 * Underneath it, both files carry a literal for the ordinary case, where there is no `.env`
 * at all: `compose.yaml`'s `${POSTGRES_PORT:-…}` and the harness's fallback URL. Those two
 * are the original shape #21 removed everywhere else — one number written twice, kept in
 * step by whoever remembers. Change one and the container comes up on one port while the
 * suite dials another, and neither error names the other.
 *
 * So this reads both, out of the files themselves, and holds them to being one number.
 * There is deliberately no third copy of it here: a literal in this file to compare both
 * against would be the very thing it exists to forbid.
 *
 * **The credentials in those same two fallbacks are covered next door**, in
 * `tests/the-postgres-credentials-belong-to-dot-env.test.ts`. They were left out of this
 * file deliberately and are not the same defect wearing different clothes: the ports
 * disagree only where nothing has been written down, while `POSTGRES_USER` and
 * `POSTGRES_PASSWORD` used to be carried to the harness on *no* path at all — a Developer
 * who changed them in `.env` got a container with the new ones and a suite dialling the old.
 * Two agreeing literals would not have fixed that, and would have read as though something
 * had. #63 wired them through, which is what made the literals underneath worth holding
 * together, and put that guardrail with the change that earned it.
 */
const repoRoot = new URL("../", import.meta.url);

const COMPOSE = "compose.yaml";
const HARNESS = "packages/core/src/testing/database.ts";

/** A port one of the two files falls back to, and where in that file it was read from. */
type Fallback = {
  readonly port: number;
  /** Named in the failure, so it says which line to go and look at. */
  readonly where: string;
};

/** The shape of a compose file, not a domain concept — `CONTEXT.md` reserves no term here. */
type ComposeFile = {
  services?: Record<string, { ports?: unknown[] | null } | null> | null;
};

/**
 * `compose.yaml`'s default published port, read out of the file.
 *
 * Every service is scanned rather than the `db` one by name: what matters is the entry that
 * publishes `POSTGRES_PORT`, wherever it lives, and a renamed service should not quietly
 * take this check out of the file. Finding none, or finding several, throws — an entry this
 * no longer recognises has to fail rather than leave the assertion below comparing nothing.
 */
function composeFallback(contents: string): Fallback {
  const { services } = (parseYaml(contents) ?? {}) as ComposeFile;
  const published: Fallback[] = [];

  for (const [service, definition] of Object.entries(services ?? {})) {
    for (const entry of definition?.ports ?? []) {
      // Compose takes both `"host:container"` and the long `{ target, published }` form.
      // Rendering the entry rather than reading a shape covers the second without a second
      // reader — the variable appears in either, and a compose file that legitimately
      // switched syntax should not turn this red.
      const text = typeof entry === "string" ? entry : JSON.stringify(entry);
      if (!text.includes("POSTGRES_PORT")) continue;

      const where = `${COMPOSE} → service "${service}": ${text}`;
      // `${POSTGRES_PORT:-55432}` — the `:-` default is the whole subject: an entry that
      // named the variable and defaulted to nothing would publish nothing outside devbox.
      const port = /\$\{POSTGRES_PORT:-(\d+)\}/.exec(text)?.[1];
      if (port === undefined) {
        throw new Error(
          `${where} names POSTGRES_PORT but declares no \`:-<port>\` default, so a bare \`docker compose\` outside devbox publishes no port at all.`,
        );
      }

      published.push({ port: Number(port), where });
    }
  }

  const [only] = published;
  if (published.length !== 1 || only === undefined) {
    // Failing open would be worse than failing: with nothing found there is no compose
    // value to compare, and this file would pass by checking neither side.
    throw new Error(
      `${published.length} port entries in ${COMPOSE} publish POSTGRES_PORT, so the port a bare \`docker compose\` falls back to could not be read. Expected exactly one, as \`"\${POSTGRES_PORT:-<port>}:5432"\`.`,
    );
  }

  return only;
}

/**
 * The harness's fallback URL, read out of `packages/core/src/testing/database.ts`.
 *
 * The literal comes from the source and the value comes from the function: the string below
 * is found in the file, and the test named for it then confirms the harness actually falls
 * back to that same string. Either alone leaves a hole — a literal the file no longer uses
 * would be guarded while the live default drifted, and a value with nothing behind it in
 * the file would say nothing about the fallback this ticket is about.
 *
 * Exactly one such literal, or this throws: several would leave the choice of which to
 * guard to a regular expression, and none means the default has been restructured into
 * something this can no longer see.
 */
function harnessFallbackLiteral(contents: string): string {
  const urls = [...contents.matchAll(/"(postgres(?:ql)?:\/\/[^"]*)"/g)].flatMap(
    ([, url]) => (url === undefined ? [] : [url]),
  );

  const [only] = urls;
  if (urls.length !== 1 || only === undefined) {
    // Failing open would be worse than failing, and this is the likelier way it happens
    // than the file disappearing: the default is rebuilt from parts, nothing here matches,
    // and the guardrail passes while guarding nothing.
    throw new Error(
      `${urls.length} Postgres URLs are written out in ${HARNESS}, so the address the test harness falls back to outside devbox could not be read. Expected exactly one.`,
    );
  }

  return only;
}

/** The port a fallback URL dials, which it has to have for the two to be comparable. */
function portOf(url: string): Fallback {
  const where = `${HARNESS} → "${url}"`;

  let port: string;
  try {
    port = new URL(url).port;
  } catch (cause) {
    // Reachable: the literal above is only known to start `postgres://`, and an authority
    // `new URL` refuses — an unbracketed IPv6 host, say — dies here rather than in a bare
    // TypeError that names no file.
    throw new Error(`${where} is not a URL.`, { cause });
  }

  if (port === "") {
    // Postgres' own default is 5432, and `compose.yaml` deliberately does not publish
    // there — so a fallback URL with no port is not a smaller version of this agreement,
    // it is the suite dialling a Developer's own database.
    throw new Error(
      `${where} names no port, so there is nothing for ${COMPOSE}'s published port to agree with.`,
    );
  }

  return { port: Number(port), where };
}

/** The failure: both files, both ports, and why nothing else would have said so. */
function disagreement(compose: Fallback, harness: Fallback): string {
  return [
    "Outside devbox these two are one number, and they have come apart.",
    `  publishes ${compose.port} — ${compose.where}`,
    `  dials ${harness.port} — ${harness.where}`,
    "Change both, or neither. Inside devbox both come from the derived POSTGRES_PORT, so nothing else here would have told you.",
  ].join("\n");
}

/**
 * What the harness dials with no `KOBAI_TEST_DATABASE_URL` set — the fallback itself, asked
 * of the harness rather than inferred from its source.
 *
 * The variable is unset for the length of the call and put back afterwards. devbox exports
 * it in front of every script, so under the gate it is always set: a test about the
 * fallback has to take it away to see one, and this is the *only* environment this file
 * touches. `POSTGRES_PORT` is deliberately left alone — the derived port is what the rest
 * of the suite is running against.
 */
function dialsWithoutDevbox(): string {
  const previous = process.env.KOBAI_TEST_DATABASE_URL;
  delete process.env.KOBAI_TEST_DATABASE_URL;
  try {
    return testPostgresUrl();
  } finally {
    if (previous === undefined) delete process.env.KOBAI_TEST_DATABASE_URL;
    else process.env.KOBAI_TEST_DATABASE_URL = previous;
  }
}

async function readText(path: string): Promise<string> {
  return readFile(fileURLToPath(new URL(path, repoRoot)), "utf8");
}

const harnessLiteral = async () => harnessFallbackLiteral(await readText(HARNESS));

describe("compose and the test harness agree on the fallback Postgres port", () => {
  it("publishes the port the harness dials, outside devbox", async () => {
    const compose = composeFallback(await readText(COMPOSE));
    const harness = portOf(await harnessLiteral());

    expect(harness.port, disagreement(compose, harness)).toBe(compose.port);
  });

  it("falls back to the literal that is written in the harness", async () => {
    // What makes the check above a guardrail rather than a grep: the string it read out of
    // the file is the one `testPostgresUrl()` actually returns when devbox has not set the
    // address. A literal left behind in the file after the default moved would pass every
    // assertion about itself and guard nothing.
    //
    // This is also the half that runs *against* the derived path rather than around it:
    // `KOBAI_TEST_DATABASE_URL` is set under the gate, and taking it away is what makes a
    // fallback visible at all.
    expect(dialsWithoutDevbox()).toBe(await harnessLiteral());
  });
});

/**
 * The check above is only as good as its reading of the two files, and files that agree
 * today cannot demonstrate the failure. These drive both readers, and the failure they
 * report, against contents written to offend — through the same functions the real check
 * uses.
 */
describe("reading the two fallbacks", () => {
  const compose = `
services:
  db:
    image: postgres:17-alpine
    ports:
      - "\${POSTGRES_PORT:-55432}:5432"
  app:
    ports:
      - "\${PORT:-3000}:3000"
`;

  it("reads the default out of the entry that publishes POSTGRES_PORT", () => {
    expect(composeFallback(compose).port).toBe(55432);
  });

  it("reads the long port syntax as well as the short one", () => {
    expect(
      composeFallback(`
services:
  db:
    ports:
      - target: 5432
        published: "\${POSTGRES_PORT:-55432}"
`).port,
    ).toBe(55432);
  });

  it("refuses a compose file that publishes POSTGRES_PORT nowhere", () => {
    // The fail-closed case: a renamed variable, or a `ports:` block gone, must not leave
    // this passing by comparing nothing.
    expect(() =>
      composeFallback(`
services:
  db:
    ports:
      - "5432:5432"
`),
    ).toThrow(/could not be read/);
  });

  it("refuses an entry that names POSTGRES_PORT with no default behind it", () => {
    // `"${POSTGRES_PORT}:5432"` publishes nothing at all outside devbox, which is a worse
    // version of the bug this file is about rather than an absence of it.
    expect(() =>
      composeFallback(`
services:
  db:
    ports:
      - "\${POSTGRES_PORT}:5432"
`),
    ).toThrow(/no `:-<port>` default/);
  });

  it("refuses a compose file with two of them, rather than picking one", () => {
    expect(() =>
      composeFallback(`
services:
  db:
    ports:
      - "\${POSTGRES_PORT:-55432}:5432"
  replica:
    ports:
      - "\${POSTGRES_PORT:-55433}:5432"
`),
    ).toThrow(/Expected exactly one/);
  });

  it("reads the harness's fallback URL out of its source", () => {
    expect(
      harnessFallbackLiteral(`
export function testPostgresUrl(): string {
  return (
    process.env.KOBAI_TEST_DATABASE_URL ?? "postgres://kobai:kobai@127.0.0.1:55432/kobai"
  );
}
`),
    ).toBe("postgres://kobai:kobai@127.0.0.1:55432/kobai");
  });

  it("refuses a harness whose default is no longer a URL it can find", () => {
    // The fail-closed case on the other side: the default assembled from parts leaves
    // nothing to read, and reading nothing must not pass.
    expect(() =>
      harnessFallbackLiteral(`
export function testPostgresUrl(): string {
  return process.env.KOBAI_TEST_DATABASE_URL ?? \`postgres://\${user}@\${host}:\${port}/kobai\`;
}
`),
    ).toThrow(/could not be read/);
  });

  it("refuses a fallback URL that names no port", () => {
    expect(() => portOf("postgres://kobai:kobai@127.0.0.1/kobai")).toThrow(
      /names no port/,
    );
  });

  it("names both files and both ports when they disagree", () => {
    // The failure is the whole product here: this one is read at the moment two numbers
    // have to be reconciled, and "expected 55432 to be 55433" would send the reader
    // looking for neither file.
    const failure = disagreement(
      composeFallback(compose),
      portOf("postgres://kobai:kobai@127.0.0.1:55433/kobai"),
    );

    expect(failure).toContain(COMPOSE);
    expect(failure).toContain('service "db"');
    expect(failure).toContain("55432");
    expect(failure).toContain(HARNESS);
    expect(failure).toContain("55433");
  });
});
