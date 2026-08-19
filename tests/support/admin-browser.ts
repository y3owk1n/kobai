import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@kobai/core/testing";
import axe from "axe-core";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright";
import { expect } from "vitest";
import { ADMIN_PATH } from "../../reference/src/admin-assets.ts";
import { type BootedProject, bootProject } from "./project.ts";

export { ADMIN_PATH };

/**
 * The browser seam: a real Chromium, driving the real Admin, against a really-booted
 * reference Project (ADR-0063, #175).
 *
 * Everything else in this repository asserts through the public HTTP API, and that is still
 * where screen behaviour belongs. What lives here is the handful of promises **only a browser
 * can be asked about** — a deep link, a refresh, the back button, a session running out
 * mid-use and the Merchant coming back to where they were, a refusal appearing where the
 * action was attempted, and the difference between "loading" and "there is nothing here".
 * `tests/admin-uses-only-the-public-api.test.ts` proves the Admin cannot cheat; this proves it
 * works. **A case that could have been a request-level test belongs there instead.**
 *
 * ## Adding a case
 *
 * A case is an `it` inside `tests/the-admin-in-a-browser.test.ts`, and it needs three lines:
 *
 * ```ts
 * it("lands on the Product a deep link names", async () => {
 *   const product = await seam.createProduct({ title: "A poster" });
 *   const page = await seam.signedIn(`/products/${product.id}`);
 *
 *   await shows(page.getByRole("heading", { name: "A poster" }), "the Product's title");
 *   await auditAccessibility(page, "the Product screen");
 * });
 * ```
 *
 * - **Arrange through the API**, with {@link AdminSeam.api} or one of the helpers built on it.
 *   Driving the UI to set something up makes the arrangement part of what the case asserts,
 *   and the first screen to change then breaks every case that walked through it.
 * - **Open a window with {@link AdminSeam.signedIn} or {@link AdminSeam.anonymous}.** Each is a
 *   browser context of its own — its own cookie jar, its own `localStorage` — so no case can
 *   be reached by what another one left behind. Both take a path *inside* the Admin, written
 *   the way `app.tsx` spells the route and without `/admin-ui` in front of it.
 * - **Audit every screen the case visits** with {@link auditAccessibility}. It is a call per
 *   *screen* rather than per case: a case that navigates twice audits twice.
 * - **Reach a control the way a Merchant without a mouse would** where that is the subject —
 *   {@link tabTo}, {@link isFocused} and `page.keyboard`. A scanner sees none of this.
 * - **The catalog is shared**, because booting a Project per case is not affordable. Give
 *   anything you create a title of its own and assert on that; call
 *   {@link AdminSeam.emptyTheCatalog} first if the case's subject is a list with nothing in it.
 *
 * A later ticket wanting a file of its own takes one line — `await using seam = await
 * startAdminSeam()` in a `beforeAll` — and pays another boot, which is a few seconds. Adding a
 * `describe` to the existing file pays nothing.
 *
 * ## What it costs, and why it is in the gate anyway
 *
 * ADR-0044's line, taken for a different subject with the same reasoning: a guardrail behind
 * an opt-in step is not a faster guardrail, it is an optional one. The gate already builds two
 * images and stands a registry up.
 *
 * The browser is Chromium's **headless shell** rather than the full browser — this seam is
 * headless by definition, and the shell is a third of the download and starts in a fraction of
 * the time. `devbox run browsers` installs it, and `devbox run ci` runs that itself.
 */

const repoRoot = new URL("../../", import.meta.url);

/** The devbox script that downloads the browser, and what a refusal here tells a reader to run. */
export const BROWSERS_SCRIPT = "browsers";

const BROWSERS = `devbox run ${BROWSERS_SCRIPT}`;

/**
 * The channel {@link BROWSERS} installs.
 *
 * Since Playwright 1.49 a bare `headless: true` launches the **full** Chromium in its new
 * headless mode, which `playwright install --only-shell chromium` deliberately does not
 * download. Naming the channel is what asks for the one that was installed, so the flag in
 * `devbox.json` and this constant are one decision written in two files.
 */
export const HEADLESS_SHELL = "chromium-headless-shell";

/** A boot, a browser launch and every case in a file, on a cold CI runner. */
export const BROWSER_SEAM_TIMEOUT = 180_000;

/**
 * How long a locator may take to turn up before the case fails.
 *
 * Every wait in this seam is on something a real round trip produces, so the number has to
 * cover a cold JIT and a loaded runner. It is deliberately below vitest's own timeout for a
 * case: a wait that outlived it would arrive as "test timed out", which names nothing.
 */
export const LOCATOR_TIMEOUT = 15_000;

/** The first Merchant this deployment is seeded with, which is the only way in (#25). */
const MERCHANT = {
  email: "browser-seam@kobai.test",
  password: "the-browser-seam-signs-in-with-this",
} as const;

export type CreatedProduct = { readonly id: string; readonly title: string };

export type AdminSeam = {
  /** Where the Project is serving, on a port the OS chose. */
  readonly origin: string;
  /** The seeded Merchant's credentials, for a case that types them into the form. */
  readonly merchant: { readonly email: string; readonly password: string };
  /** The throwaway database, for arranging what the API cannot reach. */
  readonly database: TestDatabase;

  /** A browser with no cookie at all, at a path inside the Admin. */
  anonymous(path?: string): Promise<Page>;
  /** A browser already carrying a Merchant session, at a path inside the Admin. */
  signedIn(path?: string): Promise<Page>;

  /** One call against the public API, as the seeded Merchant. */
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** A Product with one Variant, created through the API. */
  createProduct(product: { title: string; sku?: string }): Promise<CreatedProduct>;
  /** Deletes every Product, for a case whose subject is a list with nothing in it. */
  emptyTheCatalog(): Promise<void>;
  /**
   * Winds every session's idle window back, so the next request meets `session-expired`.
   *
   * Time is passed by moving the row rather than by waiting, exactly as `auth.test.ts` does —
   * a window measured in minutes is not something a test may sit through.
   */
  expireEverySession(): Promise<void>;

  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * Boots the Project, launches the browser, and hands back the seam.
 *
 * The Project is the **built** reference Project — `node dist/src/server.js`, the artifact its
 * own Dockerfile runs — against a throwaway database it migrates itself, on a port the OS
 * hands out rather than one anybody chose. So this needs `devbox run build` to have happened,
 * which the gate does before vitest and a bare `vitest` does not; that is checked here rather
 * than discovered as a missing file three frames down.
 *
 * **The Project's port is the OS's, not this checkout's derived `PORT`**, and that is
 * `free-port.ts`'s argument rather than a departure from it: the derived one is what
 * `devbox run up` publishes on, so binding it here would make `devbox run ci` and a Developer
 * serving the same checkout fight over one socket — and nothing this seam starts outlives its
 * run, so there is nothing to find again at a stable address. The *database* is on the derived
 * port, through `createTestDatabase`, exactly like every other test.
 */
export async function startAdminSeam(): Promise<AdminSeam> {
  requireBuiltProject();

  const database = await createTestDatabase();
  let project: BootedProject | undefined;
  let browser: Browser | undefined;
  const windows: BrowserContext[] = [];

  const dispose = async () => {
    for (const context of windows.splice(0)) await context.close();
    await browser?.close();
    await project?.stop();
    await database.drop();
  };

  try {
    project = await bootProject(
      fileURLToPath(new URL("reference/", repoRoot)),
      database.url,
      {
        KOBAI_INITIAL_MERCHANT_EMAIL: MERCHANT.email,
        KOBAI_INITIAL_MERCHANT_PASSWORD: MERCHANT.password,
      },
    );
    browser = await launchBrowser();
  } catch (cause) {
    await dispose();
    throw cause;
  }

  const { origin } = project;
  const started = browser;

  /**
   * A session cookie for the arrangement calls, minted once and reused.
   *
   * These are not the Admin signing in — they are the test standing a catalog up before a
   * browser ever opens — so they go over plain `fetch` and share one session. Each browser
   * window still signs in for itself.
   */
  let arranging: Promise<string> | undefined;
  const arrangingCookie = () => {
    arranging ??= signInOverFetch(origin);
    return arranging;
  };

  const openWindow = async (path: string, credentialled: boolean): Promise<Page> => {
    const context = await started.newContext({ baseURL: origin });
    context.setDefaultTimeout(LOCATOR_TIMEOUT);
    windows.push(context);

    if (credentialled) {
      // Through the browser context's own request API, so the `Set-Cookie` is stored by the
      // same jar the page reads — attributes, path scoping and all — rather than by this
      // seam's idea of what the cookie looks like (ADR-0032).
      const signIn = await context.request.post(`${origin}/admin/session`, {
        data: MERCHANT,
      });
      if (!signIn.ok()) {
        throw new Error(
          `The seeded Merchant could not sign in (${signIn.status()}): ${await signIn.text()}`,
        );
      }
    }

    const page = await context.newPage();
    await page.goto(adminUrl(path));
    return page;
  };

  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: {
        cookie: await arrangingCookie(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `\`${method} ${path}\` answered ${response.status} while arranging a browser case: ${await response.text()}`,
      );
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  };

  return {
    origin,
    merchant: MERCHANT,
    database,

    anonymous: (path = "/") => openWindow(path, false),
    signedIn: (path = "/") => openWindow(path, true),

    api,

    async createProduct({ title, sku = `SEAM-${randomSuffix()}` }) {
      const created = await api<{ id: string; title: string }>(
        "POST",
        "/admin/products",
        {
          title,
          variants: [{ sku }],
        },
      );
      return { id: created.id, title: created.title };
    },

    async emptyTheCatalog() {
      for (;;) {
        const listed = await api<{ products: { id: string }[] }>(
          "GET",
          "/admin/products?limit=100",
        );
        if (listed.products.length === 0) return;
        for (const product of listed.products) {
          await api("DELETE", `/admin/products/${product.id}`);
        }
      }
    },

    async expireEverySession() {
      await database.query(
        "update core_session set expires_at = now() - interval '1 hour'",
      );
      // Including the one the arrangement calls share, which is what "every" has to mean: a
      // helper that spared its own session would be expiring something other than what a
      // deployment expires. The next `api` call signs in again.
      arranging = undefined;
    },

    [Symbol.asyncDispose]: dispose,
  };
}

/**
 * How many a list answers with when nobody asked, read off the generated description.
 *
 * Never written down here (ADR-0049's rule, one level along): the number is `DEFAULT_PAGE_LIMIT`
 * in `packages/core/src/db/page.ts`, it is **promised** (ADR-0064) and so it is in
 * `openapi.json`, and a case that spelled it would go red for a reason that has nothing to do
 * with the Admin. The Admin sends no `limit` of its own, so this is exactly the size of page a
 * Merchant sees.
 */
export async function defaultPageLimit(path: string): Promise<number> {
  const description = JSON.parse(
    await readFile(
      fileURLToPath(new URL("packages/core/openapi.json", repoRoot)),
      "utf8",
    ),
  ) as {
    paths?: Record<
      string,
      { get?: { parameters?: { name?: string; schema?: { default?: unknown } }[] } }
    >;
  };

  const limit = description.paths?.[path]?.get?.parameters?.find(
    (parameter) => parameter.name === "limit",
  )?.schema?.default;

  if (typeof limit !== "number") {
    throw new Error(
      `\`GET ${path}\` declares no numeric \`limit\` default in packages/core/openapi.json, so a browser case cannot say how big a page of it is. Regenerate with \`devbox run openapi:generate\`, or check the route still pages.`,
    );
  }
  return limit;
}

/** A path inside the Admin, as the browser has to ask for it. */
function adminUrl(path: string): string {
  return `${ADMIN_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Waits for something to be on screen, and says what it was when it never arrives.
 *
 * Playwright's own timeout names a selector, which is the right answer for somebody holding
 * the code and the wrong one for somebody reading a CI log at three in the morning.
 */
export async function shows(locator: Locator, what: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: LOCATOR_TIMEOUT });
  } catch (cause) {
    throw new Error(`${what} never appeared in the Admin.`, { cause });
  }
}

/** The other direction: waits for something to go, and says what it was when it stays. */
export async function hides(locator: Locator, what: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: "hidden", timeout: LOCATOR_TIMEOUT });
  } catch (cause) {
    throw new Error(`${what} was still on screen in the Admin.`, { cause });
  }
}

/**
 * As much of the browser's `document` as the callbacks below reach for.
 *
 * Declared here rather than by putting `"dom"` in `tsconfig.base.json`'s `lib`: everything
 * under `tests/` is Node, and handing the whole suite a second set of globals — a `fetch`, a
 * `Response`, a `setTimeout` with a different return type — to typecheck three callbacks would
 * be a large change to make a small one. The callbacks are the one place a browser exists at
 * all, so **anything a new one needs is added here**, and the shape is deliberately the
 * narrowest that compiles.
 */
declare const document: {
  readonly activeElement: unknown;
  readonly documentElement: { readonly className: string };
};

/** What has the keyboard, as something a failure can print. */
export async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement as {
      tagName: string;
      textContent: string | null;
      getAttribute(name: string): string | null;
    } | null;
    if (!element) return "nothing";
    const name =
      element.getAttribute("aria-label") ??
      element.textContent?.trim().slice(0, 40) ??
      "";
    return `${element.tagName.toLowerCase()}${name === "" ? "" : ` "${name}"`}`;
  });
}

/** Whether the element a locator names is the one holding the keyboard. */
export async function isFocused(locator: Locator): Promise<boolean> {
  const element = locator.first();
  if ((await element.count()) === 0) return false;
  return element.evaluate((node) => node === document.activeElement);
}

/**
 * The classes on `<html>`, which is where the Admin's theme lives.
 *
 * `.dark` is what `@custom-variant dark` matches on, so this one list is the whole of what a
 * case asking about dark mode has to look at — and it is read off the document rather than out
 * of `localStorage`, because what a Merchant sees is the class and not the preference.
 */
export async function documentClasses(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document.documentElement.className.split(/\s+/).filter(Boolean),
  );
}

/**
 * Presses one key until a control has the keyboard, and fails saying where it got to instead.
 *
 * Every decision ADR-0063 makes that accessibility could sink is a keyboard one, and a scanner
 * sees none of them — so a control this seam claims is reachable is reached the way a Merchant
 * without a mouse reaches it. `Tab` walks the page; `ArrowDown` walks an open menu, which is a
 * different mechanism and the one #177's command palette will be asked about.
 *
 * The bound is generous and finite: a focus trap is exactly the failure worth catching, and an
 * unbounded loop would report it as a hung test instead of naming the control. It has to clear
 * a whole page of a list — a full page of Products puts about thirty stops between the sidebar
 * and the pager — so a case reaching past a longer list than that passes its own, larger one
 * rather than raising this for everybody.
 */
export async function keyboardTo(
  page: Page,
  key: string,
  target: Locator,
  what: string,
  presses = 60,
): Promise<void> {
  for (let press = 0; press < presses; press += 1) {
    if (await isFocused(target)) return;
    await page.keyboard.press(key);
  }
  throw new Error(
    `${key} never reached ${what}: after ${presses} presses the keyboard was on ${await focused(page)}.`,
  );
}

/** {@link keyboardTo} with the key a whole page is walked with. */
export function tabTo(page: Page, target: Locator, what: string): Promise<void> {
  return keyboardTo(page, "Tab", target, what);
}

/**
 * What `axe.run()` hands back, as much of it as this seam reads.
 *
 * Declared rather than imported: the code below runs **in the browser**, where `axe` is a
 * global this seam evaluated into the page and not a module anything imported.
 */
type AxeWindow = {
  readonly axe: {
    run(): Promise<{
      violations: {
        id: string;
        impact?: string | null;
        help: string;
        nodes: { target: unknown[] }[];
      }[];
    }>;
  };
};

/**
 * Runs axe-core over whatever is on screen, and fails the build on any violation.
 *
 * Every screen these tests visit is audited, which is the acceptance criterion and also the
 * cheapest half of it: a scanner sees contrast, labelling and roles, and sees none of the
 * keyboard decisions above. Both halves are wanted and neither substitutes for the other.
 *
 * `where` is what the failure names, because "a violation on the page" is not a diagnosis.
 */
export async function auditAccessibility(page: Page, where: string): Promise<void> {
  // The whole of axe, evaluated into the page. Re-evaluating on a page already carrying it is
  // harmless, and a navigation throws it away — so this is per audit rather than per window.
  await page.evaluate(axe.source);

  const violations = await page.evaluate(async () => {
    const { axe: runner } = globalThis as unknown as AxeWindow;
    const results = await runner.run();
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? "unknown",
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
  });

  expect(
    violations.map(
      (violation) =>
        `${violation.impact} — ${violation.id}: ${violation.help} (${violation.targets.join(", ")})`,
    ),
    `axe-core found accessibility violations on ${where}.`,
  ).toEqual([]);
}

/**
 * The browser, or a refusal naming the command that installs one.
 *
 * A checkout that has installed its packages and never downloaded a browser is an ordinary
 * state — the npm package ships none — and what Playwright says about it names an executable
 * path nobody chose, in a directory nobody has heard of.
 */
async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, channel: HEADLESS_SHELL });
  } catch (cause) {
    throw new Error(
      `The Admin's browser seam could not start Chromium. Run \`${BROWSERS}\` to download it — \`devbox run ci\` and \`devbox run test\` both do that themselves.`,
      { cause },
    );
  }
}

/**
 * The two build outputs this seam serves, checked before anything is booted.
 *
 * `devbox run ci` builds before it runs vitest, so this is only ever reached by a bare
 * `vitest` — the same failure `tests/the-cli-and-the-migrator-agree.test.ts` answers, and the
 * same answer: name the command rather than the missing file.
 */
function requireBuiltProject(): void {
  const missing = [
    "reference/dist/src/server.js",
    "reference/admin/dist/index.html",
  ].filter((path) => !existsSync(fileURLToPath(new URL(path, repoRoot))));

  if (missing.length > 0) {
    throw new Error(
      `The Admin's browser seam serves the built Project and the built Admin, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not there. Run \`devbox run build\` first; \`devbox run ci\` and \`devbox run test\` both do.`,
    );
  }
}

async function signInOverFetch(origin: string): Promise<string> {
  const response = await fetch(new URL("/admin/session", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(MERCHANT),
  });
  if (!response.ok) {
    throw new Error(
      `The seeded Merchant could not sign in to arrange a browser case (${response.status}): ${await response.text()}`,
    );
  }
  const cookie = response.headers.getSetCookie().at(0)?.split(";").at(0);
  if (cookie === undefined) {
    throw new Error("Signing in answered no session cookie, so nothing can be arranged.");
  }
  return cookie;
}

/** Enough of a random tail that two Products created in one run cannot share a SKU. */
function randomSuffix(): string {
  return crypto.randomUUID().slice(0, 8).toUpperCase();
}
