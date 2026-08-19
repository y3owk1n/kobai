import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ADMIN_PATH,
  type AdminSeam,
  auditAccessibility,
  BROWSER_SEAM_TIMEOUT,
  BROWSERS_SCRIPT,
  defaultPageLimit,
  documentClasses,
  HEADLESS_SHELL,
  hides,
  isFocused,
  keyboardTo,
  LOCATOR_TIMEOUT,
  refocusTheWindow,
  shows,
  startAdminSeam,
  tabTo,
  watchForWrites,
} from "./support/admin-browser.ts";
import { readDevbox } from "./support/init-hook.ts";

/**
 * The Admin, in a real browser, against a really-booted reference Project (#175, ADR-0063).
 *
 * `reference/admin/` had no tests at all until this file. What stood in for them was
 * `tests/admin-uses-only-the-public-api.test.ts`, a static ban on network primitives: it
 * proves the Admin cannot cheat and nothing whatever about whether it works.
 *
 * **Every case here is a promise of the frame**, and the test for that is whether a request
 * could have asked it instead. Deep-linking, refresh, browser back and forward, a session
 * running out mid-use and the Merchant returning to where they were, a refusal appearing where
 * the action was attempted, and the difference between "loading" and "there is nothing here" —
 * none of those is a response body, and every one of them is a thing this Admin claims. Screen
 * behaviour is asserted through the API, as it always has been.
 *
 * Two of these were written after watching a browser catch them, and neither was visible to
 * any other seam in this repository: signing out left the Admin looking signed in, because
 * `queryClient.clear()` destroys the query a mounted `useQuery` is attached to and the observer
 * goes on holding what it last read; and `Button render={<Link/>}` gave every link in the Admin
 * `role="button"` through Base UI, which is why the navigation cases below ask for links by
 * their **role** rather than by their text.
 *
 * **Ten of these were watched failing on the frame as #174 left it**, which is the only reason
 * to believe they can. Every one was an `axe-core` refusal and every one was real: the layout
 * rendered a second `main` inside `SidebarInset`'s, so the document had two main landmarks and
 * neither was unique; the sidebar's contents sat outside any landmark at all; no list screen
 * had an `h1`, nor did the sign-in screen, which renders in place of the frame and so inherits
 * nothing; and the Products table's action column had an empty header. All four are fixed in
 * the same commit, in `reference/admin/`, and none of them was visible to any other seam.
 *
 * `tests/support/admin-browser.ts` is the harness and says how to add a case. In short: arrange
 * through the API, open a window with `seam.signedIn(…)` or `seam.anonymous(…)`, and audit
 * every screen you visit.
 */

/**
 * One boot and one browser for the whole file, because the boot is the expensive part.
 *
 * The cost of that is a shared catalog, and the cases that care say so — `emptyTheCatalog`
 * ahead of anything about an empty list or a page count, and a title of its own on anything
 * created for one case to find.
 */
let seam: AdminSeam;

vi.setConfig({ testTimeout: 60_000, hookTimeout: BROWSER_SEAM_TIMEOUT });

beforeAll(async () => {
  seam = await startAdminSeam();
});

afterAll(async () => {
  await seam?.[Symbol.asyncDispose]();
});

/**
 * Where the browser is, as a path inside the Admin rather than a whole URL.
 *
 * The origin is a port the OS handed out and `/admin-ui` is the frame's `basename`, so neither
 * is a thing a case should have to spell — what a case is asserting is the route.
 */
function where(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname.slice(ADMIN_PATH.length)}${url.search}`;
}

/**
 * The rows of whatever list is on screen, which is what a page of one looks like.
 *
 * A header row's cells are `th` and a body row's are `td`, so this is "the rows with data in
 * them" without any list having to say how many columns it has or what its first one holds.
 * Filtering on the Open link instead would have worked for Products and Orders and quietly
 * counted zero on the API keys screen, whose rows carry a Revoke button rather than a link.
 */
function listRows(page: Page) {
  return page.getByRole("row").filter({ has: page.locator("td") });
}

/**
 * The New Product form, which is the one place in this Admin an action can be refused.
 *
 * Named by a field only it has, because the sign-in form and this one are both `<form>` and a
 * case that asserted a refusal rendered "on the page" would pass with it rendered anywhere.
 */
function newProductForm(page: Page) {
  return page.locator("form").filter({ hasText: PRICE_FIELD });
}

const PRICE_FIELD = "Price, in minor units";

/** Fills the New Product form and submits it. */
async function createProductInTheAdmin(
  page: Page,
  product: { title: string; sku: string; amount?: string },
): Promise<void> {
  const form = newProductForm(page);
  await form.getByLabel("Title").fill(product.title);
  await form.getByLabel("SKU").fill(product.sku);
  await form.getByLabel(PRICE_FIELD).fill(product.amount ?? "1250");
  await form.getByRole("button", { name: "Create" }).click();
}

/**
 * Waits for a page of the list to be the size it should be.
 *
 * Polled rather than read once, and that is the whole of what `keepPreviousData` costs a
 * test: the page you were reading stays on screen while the next one is fetched, so counting
 * the moment after a click counts the page you came from.
 */
async function holdsRows(page: Page, rows: number): Promise<void> {
  await expect
    .poll(() => listRows(page).count(), {
      timeout: LOCATOR_TIMEOUT,
      message: `The list never settled at ${rows} rows.`,
    })
    .toBe(rows);
}

/**
 * The first cell of every row on screen, which is what tells one page from another.
 *
 * A Product's title and an Order's number both live there, and both are unique in the fixtures
 * these cases build — so comparing two pages' worth is how "these are different pages, and no
 * row is on both" becomes something an assertion can see.
 */
async function firstCells(page: Page): Promise<string[]> {
  const rows = await listRows(page).all();
  return Promise.all(
    rows.map(async (row) => (await row.locator("td").first().innerText()).trim()),
  );
}

/**
 * Waits for the rows on screen to be the ones the case is about.
 *
 * The other half of what `keepPreviousData` costs a test: the page you were reading stays up
 * while the next one is fetched, so anything read the moment after a click reads the page you
 * came from. `holdsRows` waits on how many; this waits on which.
 */
async function settlesOn(
  page: Page,
  rows: (cells: string[]) => boolean,
  message = "The list never settled on the rows this case is about.",
): Promise<void> {
  await expect
    .poll(async () => rows(await firstCells(page)), { timeout: LOCATOR_TIMEOUT, message })
    .toBe(true);
}

/** Signs in through the form the way a Merchant does, keyboard only. */
async function signInWithTheKeyboard(page: Page): Promise<void> {
  const email = page.getByLabel("Email");
  await shows(email, "the sign-in form's email field");

  await tabTo(page, email, "the email field");
  await page.keyboard.type(seam.merchant.email);
  await page.keyboard.press("Tab");
  expect(
    await isFocused(page.getByLabel("Password")),
    "Tab from the email field did not land on the password field.",
  ).toBe(true);
  await page.keyboard.type(seam.merchant.password);
  // Enter in a text field submits the form it is in, which is the whole of what a Merchant
  // signing in one-handed does. A Sign in button that had to be clicked would be a keyboard
  // failure nothing else here would see.
  await page.keyboard.press("Enter");
}

describe("the browser the gate downloads", () => {
  /**
   * The gate installs the browser this seam launches, and it is one decision in two files.
   *
   * `devbox run browsers`, `devbox run test` and `devbox run ci` all have to reach for the
   * same thing, or a Developer's local run and CI drive different browsers — the same
   * invisible difference `devbox run lint` and the gate's lint step are held together against
   * (ADR-0039). And the flag and the channel are two halves of one choice: `--only-shell`
   * downloads the headless shell alone, and a launch that did not name the channel would ask
   * for the full Chromium that was deliberately not downloaded.
   */
  it("is asked for identically by every command that runs the suite", async () => {
    const scripts = (await readDevbox()).shell?.scripts ?? {};
    // The fresh-checkout guard says what has to be true before pnpm can run at all and is not
    // part of what playwright is asked to do, exactly as it is stripped off `lint` before the
    // gate's lint step is compared against it. `ci` carries no guard, because it installs.
    const invocation = scripts[BROWSERS_SCRIPT]?.replace(
      /^sh scripts\/require-install\.sh \S+ && /,
      "",
    );

    expect(
      invocation,
      `\`devbox run ${BROWSERS_SCRIPT}\` decides which Chromium exists, and the seam launches ${JSON.stringify(HEADLESS_SHELL)} — which is what \`--only-shell\` downloads and the only thing it downloads. Change one and change the other.`,
    ).toBe("pnpm exec playwright install --only-shell chromium");
    expect(scripts.ci).toContain(invocation);
    expect(scripts.test).toContain(invocation);
  });
});

describe("the way in", () => {
  it("renders sign-in in place of the screen that was asked for, and leaves the URL alone", async () => {
    const product = await seam.createProduct({ title: "A deep-linked poster" });
    const page = await seam.anonymous(`/products/${product.id}`);

    await shows(page.getByText("Sign in to change this Store."), "the sign-in form");
    // In place of the routes rather than at a route of its own: the address a Merchant was
    // sent is still in the bar, so there is no return path for anything to remember.
    expect(where(page)).toBe(`/products/${product.id}`);
    // A session that never existed is `session-missing`, and saying "your session expired" to
    // somebody who never had one would be noise on the Admin's very first request.
    await expect(page.getByText("Your session expired.").count()).resolves.toBe(0);

    await auditAccessibility(page, "the sign-in screen");
  });

  it("signs in with the keyboard alone and lands on the screen that was asked for", async () => {
    const product = await seam.createProduct({ title: "A keyboard poster" });
    const page = await seam.anonymous(`/products/${product.id}`);

    await signInWithTheKeyboard(page);

    await shows(
      page.getByRole("heading", { name: "A keyboard poster" }),
      "the Product a deep link named",
    );
    expect(where(page)).toBe(`/products/${product.id}`);
  });

  it("says what was wrong with the credentials, where they were typed", async () => {
    const page = await seam.anonymous();

    await page.getByLabel("Email").fill(seam.merchant.email);
    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await shows(page.getByText("That did not work."), "the refusal on the sign-in form");
    await shows(page.getByLabel("Email"), "the sign-in form, still there to try again");
    await auditAccessibility(page, "the sign-in screen showing a refusal");
  });
});

describe("every screen has a URL", () => {
  it("lands on the Product a deep link names, and stays there across a refresh", async () => {
    const product = await seam.createProduct({ title: "A refreshed poster" });
    const page = await seam.signedIn(`/products/${product.id}`);

    await shows(
      page.getByRole("heading", { name: "A refreshed poster" }),
      "the Product a deep link named",
    );
    await auditAccessibility(page, "the Product screen");

    await page.reload();

    await shows(
      page.getByRole("heading", { name: "A refreshed poster" }),
      "the Product, after a refresh",
    );
    expect(where(page)).toBe(`/products/${product.id}`);
  });

  it("sends the front door to Products, without leaving it in the history", async () => {
    const page = await seam.signedIn("/");

    await shows(page.getByText("Everything this Store sells"), "the Products screen");
    expect(where(page)).toBe("/products");
    await auditAccessibility(page, "the Products screen");
  });

  it("navigates from the sidebar, and the breadcrumb follows the URL", async () => {
    const page = await seam.signedIn("/products");
    const crumb = page.getByRole("navigation", { name: "breadcrumb" });

    await shows(crumb.getByText("Products"), "the Products breadcrumb");

    await page.getByRole("link", { name: "Orders" }).click();

    expect(where(page)).toBe("/orders");
    await shows(crumb.getByText("Orders"), "the Orders breadcrumb");
    await auditAccessibility(page, "the Orders screen");
  });

  it("walks back and forward through the screens the way the web does", async () => {
    const product = await seam.createProduct({ title: "A poster with a history" });
    const page = await seam.signedIn("/products");

    await shows(page.getByText("Everything this Store sells"), "the Products screen");
    await page
      .getByRole("row", { name: /A poster with a history/ })
      .getByRole("link", { name: "Open" })
      .click();
    await shows(
      page.getByRole("heading", { name: "A poster with a history" }),
      "the Product that was opened",
    );

    await page.goBack();
    expect(where(page)).toBe("/products");
    await shows(
      page.getByText("Everything this Store sells"),
      "the Products screen, again",
    );

    await page.goForward();
    expect(where(page)).toBe(`/products/${product.id}`);
    await shows(
      page.getByRole("heading", { name: "A poster with a history" }),
      "the Product, forward again",
    );
  });

  it("answers an address no screen has with a screen rather than an empty frame", async () => {
    const page = await seam.signedIn("/nothing-is-here");

    await shows(page.getByText("No such screen"), "the not-found screen");
    // The Project hands back `index.html` for every path under the Admin's, which is what
    // makes deep links work at all — so a mistyped one arrives here rather than at a 404, and
    // what it must not do is show an empty frame somebody would read as loading.
    await shows(
      page.getByRole("link", { name: "Go to Products" }),
      "the way out of the not-found screen",
    );
    await auditAccessibility(page, "the not-found screen");
  });

  it("says there is no such Product, rather than reporting a refusal", async () => {
    const product = await seam.createProduct({ title: "A poster that was deleted" });
    // Deleted rather than invented, so the address is one that genuinely worked a moment ago
    // — which is the case a Merchant following somebody's link actually meets.
    await seam.api("DELETE", `/admin/products/${product.id}`);

    const page = await seam.signedIn(`/products/${product.id}`);

    // Narrowed from kobai's `product-not-found` rather than read out of its prose (ADR-0063),
    // and shown as a screen with a way out because leaving is the only useful next move.
    await shows(page.getByText("No such Product"), "the no-such-Product screen");
    await shows(
      page.getByRole("link", { name: "Go to Products" }),
      "the way back to the Products list",
    );
    await auditAccessibility(page, "the Product screen for a Product that is not there");
  });
});

describe("paging through the cursor", () => {
  /**
   * A page, and one more — so there are exactly two of them, and the second holds one row,
   * which is what makes "these are different pages" something an assertion can see.
   *
   * The size is **read off the generated description** rather than written here: it is
   * promised (ADR-0064), the Admin sends no `limit` of its own, and a number spelled in this
   * file would go red the day Core's default moved for a reason that has nothing to do with
   * the Admin — ADR-0049's rule, one level along.
   */
  let aPage = 0;
  /** What the second page therefore holds, by construction. */
  const theRest = 1;

  beforeAll(async () => {
    aPage = await defaultPageLimit("/admin/products");
    await seam.emptyTheCatalog();
    await Promise.all(
      Array.from({ length: aPage + theRest }, (_, index) =>
        seam.createProduct({ title: `Paged poster ${String(index).padStart(2, "0")}` }),
      ),
    );
  }, BROWSER_SEAM_TIMEOUT);

  it("puts the cursor in the URL, so a page is a link and a refresh lands on it", async () => {
    const page = await seam.signedIn("/products");
    await shows(listRows(page).first(), "the first page of Products");
    await holdsRows(page, aPage);

    await page.getByRole("link", { name: "Next" }).click();

    // Opaque, so there is nothing to assert about the value — only that it is there, which is
    // what makes the page a URL somebody can send (ADR-0064).
    expect(where(page)).toMatch(/^\/products\?after=.+/);
    await holdsRows(page, theRest);
    const second = where(page);

    await page.reload();
    expect(where(page)).toBe(second);
    await shows(listRows(page).first(), "the second page after a refresh");
    await holdsRows(page, theRest);

    await auditAccessibility(page, "a second page of Products");
  });

  it("walks back through the pages with the browser's own back button", async () => {
    const page = await seam.signedIn("/products");
    await shows(page.getByRole("link", { name: "Next" }), "the Next control");

    await page.getByRole("link", { name: "Next" }).click();
    expect(where(page)).toMatch(/after=/);

    await page.goBack();

    expect(where(page)).toBe("/products");
    await holdsRows(page, aPage);
  });

  it("offers Previous back to the page it came from, reached with the keyboard", async () => {
    const page = await seam.signedIn("/products");
    const next = page.getByRole("link", { name: "Next" });
    await shows(next, "the Next control");

    await keyboardTo(page, "Tab", next, "the Next control");
    await page.keyboard.press("Enter");
    await shows(
      page.getByRole("link", { name: "Previous" }),
      "the Previous control on the second page",
    );

    await page.getByRole("link", { name: "Previous" }).click();

    expect(where(page)).toBe("/products");
    await holdsRows(page, aPage);
  });
});

describe("loading, empty, and refused", () => {
  it("shows a skeleton while the first page is in flight, and the table after it", async () => {
    const page = await seam.signedIn("/products");
    await shows(listRows(page).first(), "a page of Products");

    // Held long enough that the state between "asking" and "answered" is a thing a test can
    // see at all. Delaying the response is the only honest way to assert on it: the state is
    // real and lasts a few milliseconds against a database on the same machine.
    await page.route(
      (url) => url.pathname === "/admin/products",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue();
      },
    );
    await page.reload();

    const skeleton = page.getByRole("status", { name: "Reading the Products" });
    await shows(skeleton, "the Products skeleton");
    // Audited *while it is up*, because a skeleton is a screen a Merchant looks at and the
    // only place it exists is here.
    await auditAccessibility(page, "the Products screen while it is loading");
    await hides(skeleton, "the Products skeleton");
    await shows(listRows(page).first(), "the Products, once they arrived");
  });

  it("says there are none, rather than showing an empty table", async () => {
    await seam.emptyTheCatalog();
    const page = await seam.signedIn("/products");

    await shows(page.getByText("No Products yet"), "the empty state");
    await expect(listRows(page).count()).resolves.toBe(0);
    await auditAccessibility(page, "the Products screen with nothing on it");
  });

  it("explains a refused creation inside the form it was attempted in", async () => {
    const taken = `TAKEN-${Date.now()}`;
    await seam.createProduct({ title: "The Product that took the SKU", sku: taken });
    const page = await seam.signedIn("/products");

    await createProductInTheAdmin(page, { title: "A second poster", sku: taken });

    // Inside the form, not somewhere else on the page: the explanation belongs where the
    // Merchant already is (ADR-0063). Nothing here predicted it — the creation was attempted
    // and kobai's `sku-taken` is what came back.
    await shows(
      newProductForm(page).getByText(/Another Variant already carries that SKU/),
      "the refusal, inside the New Product form",
    );
    await auditAccessibility(page, "the Products screen showing a refusal");
  });

  it("checks the shape of the form without asking kobai", async () => {
    const page = await seam.signedIn("/products");
    const form = newProductForm(page);

    let asked = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/admin/products"
      ) {
        asked += 1;
      }
    });

    await form.getByRole("button", { name: "Create" }).click();

    await shows(
      form.getByText("A Product needs a title."),
      "the empty title's own message",
    );
    // Structure only, and no round trip: whether that SKU is free is a rule that lives in
    // Core and arrives as a refusal, but whether a title was typed at all is a shape.
    expect(
      asked,
      "An empty form was sent to kobai rather than caught by its own schema.",
    ).toBe(0);
  });

  it("spins over the list it is re-reading, rather than emptying it", async () => {
    await seam.emptyTheCatalog();
    const page = await seam.signedIn("/products");
    await shows(page.getByText("No Products yet"), "the empty state");

    // The same delay the skeleton case uses, for the state on the other side of the first
    // load: a *refetch*, which `keepPreviousData` deliberately makes look different — the
    // list stays and a spinner appears beside its title, rather than the table vanishing.
    await page.route(
      (url) => url.pathname === "/admin/products",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue();
      },
    );

    await createProductInTheAdmin(page, {
      title: "A newly created poster",
      sku: `NEW-${Date.now()}`,
    });

    const spinner = page.getByRole("status", { name: "Loading" });
    await shows(spinner, "the refetch spinner");
    await hides(spinner, "the refetch spinner");
    // Read back rather than predicted: there is no optimistic update anywhere in this Admin
    // (ADR-0063), so what a Product looks like once kobai has it is kobai's answer.
    await shows(
      page.getByRole("row", { name: /A newly created poster/ }),
      "the Product kobai answered with",
    );
  });
});

describe("a session that ran out", () => {
  it("says which refusal it was, keeps the address, and comes back to it", async () => {
    const product = await seam.createProduct({ title: "A poster mid-session" });
    const page = await seam.signedIn(`/products/${product.id}`);
    await shows(
      page.getByRole("heading", { name: "A poster mid-session" }),
      "the Product being looked at",
    );

    // Time is passed by moving the row, never by waiting out a window measured in minutes.
    await seam.expireEverySession();
    await page.reload();

    // `session-expired` rather than `session-missing`, and the Admin says so — the cookie
    // carries no `Expires` of its own precisely so that the database stays the authority and
    // this stays a distinguishable answer (ADR-0032).
    await shows(page.getByText("Your session expired."), "the expiry notice");
    await shows(page.getByText("session-expired"), "the reason kobai gave");
    expect(where(page)).toBe(`/products/${product.id}`);
    await auditAccessibility(page, "the sign-in screen after an expiry");

    await signInWithTheKeyboard(page);

    await shows(
      page.getByRole("heading", { name: "A poster mid-session" }),
      "the Product the Merchant was looking at before the session ran out",
    );
    expect(where(page)).toBe(`/products/${product.id}`);

    // **The keyboard survives the form being taken away.** Signing in unmounts the input that
    // was submitted from, so the browser hands focus back to the document — and what has to be
    // true is that Tab then walks the screen the Merchant was returned to, rather than being
    // stuck in a subtree that no longer exists. Watched: focus is on the document body here,
    // which is the browser's own recovery and not something the Admin arranges.
    //
    // ADR-0063 wants more than this eventually — focus *moved* to the restored screen, so a
    // Merchant does not tab past the whole frame to get back to what they were reading. That
    // is an affordance the Admin does not offer yet; it belongs with #178's, and this case is
    // where it gets asserted when it does.
    await tabTo(
      page,
      page.getByRole("link", { name: "Products" }),
      "the Products section",
    );
  });
});

describe("the frame's own controls", () => {
  it("signs out, and the Admin stops looking signed in", async () => {
    const page = await seam.signedIn("/products");
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    await page.getByRole("button", { name: "Sign out" }).click();

    // The bug this case exists for: `queryClient.clear()` destroys the query a mounted
    // `useQuery` is attached to, so the observer went on holding what it last read and the
    // Admin sat there looking signed in with the cookie already gone.
    await shows(page.getByText("Sign in to change this Store."), "the sign-in form");
    await hides(page.getByText("Everything this Store sells"), "the Products screen");
  });

  it("keeps a dark-mode override across a reload", async () => {
    const page = await seam.signedIn("/products");
    const isDark = async () => (await documentClasses(page)).includes("dark");

    const toggle = page.getByRole("button", { name: /^Theme:/ });
    await keyboardTo(page, "Tab", toggle, "the theme toggle");
    await page.keyboard.press("Enter");

    const dark = page.getByRole("menuitemradio", { name: "Dark" });
    await shows(dark, "the theme menu");
    await keyboardTo(page, "ArrowDown", dark, "the Dark option", 8);
    await page.keyboard.press("Enter");

    await expect.poll(isDark).toBe(true);

    // Audited **with the menu open**, which nothing did until #179 — and it was a real
    // violation the whole time: this menu portals its items, and at Base UI's default target of
    // `<body>` they are content outside every landmark, which axe reports as `region`. The
    // frame offers a container inside `main` now (`lib/portal.tsx`) and this is what holds it.
    // Watched failing with that container taken away.
    await page.keyboard.press("Enter");
    await shows(dark, "the theme menu, reopened");
    await auditAccessibility(page, "the Products screen with the theme menu open");
    await page.keyboard.press("Escape");

    await page.reload();
    await shows(
      page.getByText("Everything this Store sells"),
      "the Products screen, reloaded",
    );
    // A full palette wired to nothing was what the Admin shipped before #174; the persistence
    // is what makes the choice a preference rather than a thing to redo every morning.
    await expect(isDark()).resolves.toBe(true);
    await auditAccessibility(page, "the Products screen in dark mode");
  });

  it("reaches a sidebar section with the keyboard and opens it with Enter", async () => {
    const page = await seam.signedIn("/products");
    const apiKeys = page.getByRole("link", { name: "API keys" });
    await shows(apiKeys, "the API keys section in the sidebar");

    await keyboardTo(page, "Tab", apiKeys, "the API keys section");
    await page.keyboard.press("Enter");

    expect(where(page)).toBe("/api-keys");
    await auditAccessibility(page, "the API keys screen");
  });
});

/**
 * The command palette (#177), whose whole interface is the keyboard.
 *
 * A sidebar stops being a pleasant way to navigate somewhere around six entries, and this Admin
 * is on its way to roughly ten — so this is how a Merchant will reach a section, and none of it
 * is visible to a scanner. Opening, filtering, walking the list and choosing are asserted here
 * because every one of them is a keystroke, and **where the keyboard lands on the way out** is
 * asserted twice, because that is the failure nothing else in this repository could see.
 *
 * One thing is asserted on the ARIA state rather than on focus, deliberately. The palette is a
 * combobox over a listbox: the keyboard stays in the input while the arrow keys move the
 * *selection*, which is what `aria-selected` says and what a screen reader announces. So
 * `tabTo` is the right tool for reaching the button and the wrong one for the list — a case
 * that tabbed through the options would be asserting an interaction this widget deliberately
 * does not have — and where the keyboard *ends up* is asked with `isFocused`, because these
 * cases know which control it should be on rather than hunting for it.
 */
describe("the command palette", () => {
  /**
   * The button in the header, which is also where the keyboard is meant to end up.
   *
   * Matched loosely because its name carries the shortcut, and which shortcut it names is the
   * platform's: a case that spelled `⌘K` would be red on the runner rather than in the Admin.
   */
  function paletteButton(page: Page) {
    return page.getByRole("button", { name: /^Search sections/ });
  }

  /** The input the palette is driven from, and the thing that is on screen when it is open. */
  function paletteInput(page: Page) {
    return page.getByRole("combobox", { name: "Search sections" });
  }

  /** The palette's rows: one per section, in a listbox that input drives. */
  function paletteOptions(page: Page) {
    return page.getByRole("option");
  }

  /** Which row the arrow keys are on, which is what a screen reader would announce. */
  function selected(page: Page): Promise<string[]> {
    return paletteOptions(page)
      .and(page.locator('[aria-selected="true"]'))
      .allInnerTexts();
  }

  /**
   * Opens the palette and waits for it to hold the keyboard.
   *
   * The wait is an assertion rather than a settling: **opening has to take the keyboard**, or
   * the next keystroke is one the screen underneath acts on. Without it this file was red about
   * once in four runs and lied about why — the case below typed into a Product's Open link, its
   * Enter followed the link, and the failure read as the palette having navigated to the wrong
   * place rather than as its never having had the keyboard at all.
   */
  async function openPalette(page: Page, opensWith: string): Promise<void> {
    await page.keyboard.press(opensWith);
    await shows(paletteInput(page), "the command palette");
    await expect.poll(() => isFocused(paletteInput(page))).toBe(true);
  }

  it("opens on the shortcut, filters to what was typed, and opens the section left", async () => {
    const page = await seam.signedIn("/products");
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    await openPalette(page, "Meta+k");
    // Audited *while it is open*: an overlay is a different accessibility surface from the page
    // under it, and every other audit in this file is of the page under it.
    await auditAccessibility(page, "the Admin with the command palette open");

    await page.keyboard.type("api");
    await expect.poll(() => paletteOptions(page).allInnerTexts()).toEqual(["API keys"]);

    // A filter that matches nothing says so, rather than showing an empty box — the same
    // distinction between "loading" and "there is none" the list screens draw.
    await page.keyboard.type("-that-this-admin-has-no-screen-for");
    await expect.poll(() => paletteOptions(page).count()).toBe(0);
    await shows(
      page.getByText("Nothing in this Admin is called that."),
      "the empty palette",
    );

    // Back to the one section, so what Enter chooses is the row a Merchant can see.
    for (const _ of "-that-this-admin-has-no-screen-for") {
      await page.keyboard.press("Backspace");
    }
    await expect.poll(() => paletteOptions(page).allInnerTexts()).toEqual(["API keys"]);

    await page.keyboard.press("Enter");

    expect(where(page)).toBe("/api-keys");
    await shows(
      page.getByText("The credentials a storefront presents at"),
      "the API keys screen",
    );
  });

  it("opens on Ctrl+K too, and the arrow keys move the selection down the list", async () => {
    const page = await seam.signedIn("/products");
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    // The other spelling, and it is not a courtesy: a Merchant on Windows or Linux has no ⌘.
    await openPalette(page, "Control+k");

    // Nothing has been typed, so the palette offers every section this Admin has — which is
    // what makes it a way *round* the sidebar rather than a search of it.
    await expect
      .poll(() => paletteOptions(page).allInnerTexts())
      .toEqual(["Products", "Orders", "API keys", "Merchants", "Roles", "Store"]);
    await expect.poll(() => selected(page)).toEqual(["Products"]);

    await page.keyboard.press("ArrowDown");
    await expect.poll(() => selected(page)).toEqual(["Orders"]);
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => selected(page)).toEqual(["API keys"]);
    // Both directions, because a list that only walks one way is one a Merchant who overshoots
    // has to close and reopen.
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => selected(page)).toEqual(["Orders"]);

    await page.keyboard.press("Enter");

    expect(where(page)).toBe("/orders");
    await shows(page.getByText("Every Order this Store has taken"), "the Orders screen");
  });

  it("closes on Escape and hands the keyboard back to the button that opens it", async () => {
    const page = await seam.signedIn("/products");
    const button = paletteButton(page);
    await shows(button, "the command palette's button in the header");

    // Reached without the shortcut, because the shortcut is not the only way in and a Merchant
    // who never learned it still has to be able to get here.
    await tabTo(page, button, "the command palette's button");
    await openPalette(page, "Enter");

    await page.keyboard.press("Escape");

    await hides(paletteInput(page), "the command palette");
    await expect.poll(() => isFocused(button)).toBe(true);
  });

  it("hands the keyboard back after it navigates, rather than stranding it", async () => {
    const product = await seam.createProduct({
      title: "A poster the palette leaves behind",
    });
    const page = await seam.signedIn("/products");
    const open = page
      .getByRole("row", { name: product.title })
      .getByRole("link", { name: "Open" });
    await shows(open, "the Product's row in the list");

    // The whole of this case, and it was watched failing with `finalFocus` taken out of
    // `components/command-palette.tsx`. The keyboard starts on a control **belonging to the
    // screen**, so what focus would otherwise be restored to is a control the Merchant is about
    // to navigate away from — and what happened was worse than a stranded keyboard: focus
    // landed back on this Open link, the Enter that chose Orders arrived on it, and the Admin
    // opened the Product instead of the section that was asked for.
    await tabTo(page, open, `the Open link of ${product.title}`);
    await openPalette(page, "Meta+k");
    await page.keyboard.type("orders");
    await expect.poll(() => paletteOptions(page).allInnerTexts()).toEqual(["Orders"]);
    await page.keyboard.press("Enter");

    expect(where(page)).toBe("/orders");
    await expect.poll(() => isFocused(paletteButton(page))).toBe(true);
  });
});

describe("the gate above every screen", () => {
  it("says it is asking kobai who you are, and that screen is a screen", async () => {
    const page = await seam.signedIn("/products");
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    // The same delay the skeleton cases use, for the one state that is neither signed in nor
    // signed out: `GET /admin/session` in flight. It lasts a few milliseconds against a
    // database on the same machine, which is why nothing had ever looked at it — and it is a
    // whole page, with no frame around it, because which frame to draw is exactly what is not
    // known yet.
    await page.route(
      (url) => url.pathname === "/admin/session",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue();
      },
    );
    await page.reload();

    const asking = page.getByText("Asking kobai who you are…");
    await shows(asking, "the boot gate");
    // Audited *while it is up*: #175 named this screen and the Order screen as the two the
    // browser cases never reached, so neither had ever been scanned.
    await auditAccessibility(page, "the Admin while it is asking who you are");
    await hides(asking, "the boot gate");
    await shows(
      page.getByText("Everything this Store sells"),
      "the Products screen, once kobai answered",
    );
  });
});

describe("Orders", () => {
  it("opens one from the list, and the Order has an address of its own", async () => {
    const [placed] = await seam.placeOrders();
    if (!placed) throw new Error("The seam placed no Order for this case to open.");

    const page = await seam.signedIn("/orders");
    await shows(
      page.getByRole("row", { name: new RegExp(`#${placed.number}\\b`) }),
      "the Order in the list",
    );
    await auditAccessibility(page, "the Orders screen");

    await page
      .getByRole("row", { name: new RegExp(`#${placed.number}\\b`) })
      .getByRole("link", { name: "Open" })
      .click();

    expect(where(page)).toBe(`/orders/${placed.id}`);
    await shows(
      page.getByRole("heading", { name: `Order #${placed.number}` }),
      "the Order's own heading",
    );
    // The crumb names the Order rather than repeating the identifier out of the URL — which
    // is the one thing on this screen a Merchant cannot read aloud to anybody.
    await shows(
      page.getByRole("navigation", { name: "breadcrumb" }).getByText(`#${placed.number}`),
      "the Order's breadcrumb",
    );
    await auditAccessibility(page, "the Order screen");
  });

  it("says there is no such Order, rather than reporting a refusal", async () => {
    // A UUID this Store has certainly never issued. An Order is never deleted (ADR-0009), so
    // this address has always been wrong rather than having stopped working.
    const page = await seam.signedIn(`/orders/${crypto.randomUUID()}`);

    await shows(page.getByText("No such Order"), "the no-such-Order screen");
    await shows(
      page.getByRole("link", { name: "Go to Orders" }),
      "the way back to the Orders list",
    );
    await auditAccessibility(page, "the Order screen for an Order that is not there");
  });
});

describe("paging through the Orders", () => {
  /**
   * A page of Orders and one more, so that there is a second page to reach.
   *
   * This is the list guaranteed to grow without bound, which is why it pages at all — and
   * unlike the Products cases nothing here empties anything first: an Order cannot be deleted
   * (ADR-0009), so a case that asserted an exact number of rows on the second page would be
   * asserting on how many Orders every case before it happened to place. The first page is
   * exactly full, the second holds at least one, and the two hold different Orders. All three
   * are true however many Orders this file has left behind.
   */
  let aPage = 0;

  beforeAll(async () => {
    aPage = await defaultPageLimit("/admin/orders");
    await seam.placeOrders(aPage + 1);
  }, BROWSER_SEAM_TIMEOUT);

  it("puts the cursor in the URL, so a page of Orders is a link", async () => {
    const page = await seam.signedIn("/orders");
    await shows(page.getByRole("link", { name: "Next" }), "the Next control");
    await holdsRows(page, aPage);
    const first = await firstCells(page);

    await page.getByRole("link", { name: "Next" }).click();

    // Opaque, so there is nothing to assert about the value — only that it is there, which is
    // what makes the page a URL somebody can send (ADR-0064).
    expect(where(page)).toMatch(/^\/orders\?after=.+/);
    const second = where(page);
    await settlesOn(page, (numbers) => numbers.join() !== first.join());

    const beyond = await firstCells(page);
    expect(beyond.length).toBeGreaterThan(0);
    // Every Order exactly once, which is the whole argument for a cursor over an offset.
    expect(beyond.filter((number) => first.includes(number))).toEqual([]);

    await page.reload();

    // The page a refresh lands on is the one that was on screen, because the cursor that
    // located it is in the address rather than in this tab's memory.
    expect(where(page)).toBe(second);
    await settlesOn(page, (numbers) => numbers.join() === beyond.join());
    await auditAccessibility(page, "a second page of Orders");
  });

  it("offers only the first page back when the cursor was arrived at cold", async () => {
    const page = await seam.signedIn("/orders");
    await shows(page.getByRole("link", { name: "Next" }), "the Next control");
    await page.getByRole("link", { name: "Next" }).click();
    const second = where(page);

    // A fresh window at that address, which is what a Merchant sending the link produces —
    // and it is deliberately *not* a reload, because a reload restores the history entry's
    // own state and the trail of pages before this one with it.
    const linked = await seam.signedIn(second);

    // A cursor says what comes next and can say nothing about what came before it, so with no
    // trail the page before this one is genuinely unknown. The first page is the one thing
    // that can be offered truthfully, and it is labelled as itself (ADR-0064).
    await shows(
      linked.getByRole("link", { name: "First page" }),
      "the way back to page one",
    );
    await expect(linked.getByRole("link", { name: "Previous" }).count()).resolves.toBe(0);

    await linked.getByRole("link", { name: "First page" }).click();
    expect(where(linked)).toBe("/orders");
  });
});

describe("API keys", () => {
  /**
   * Two frame promises, on the one screen where they are both visible at once.
   *
   * That a key can be minted is a request-level fact and is asserted as one elsewhere. What is
   * only true in a browser is that **the value is on screen exactly once**, in a response body
   * nothing stores, and that the list under it is **re-read rather than patched** — ADR-0063's
   * "no optimistic updates anywhere", which is a property of how the screen was built and not
   * of what kobai answered.
   */
  it("shows a minted key once, and reads the list back rather than patching it", async () => {
    const page = await seam.signedIn("/api-keys");
    const name = `Minted in a browser ${Date.now()}`;

    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Mint" }).click();

    await shows(
      page.getByText("Copy this now — it is shown once."),
      "the key, the once it is shown",
    );
    // Read back rather than predicted: there is no optimistic update anywhere in this Admin
    // (ADR-0063), so what a key looks like once kobai has it is kobai's answer.
    await shows(
      page.getByRole("row", { name: new RegExp(name) }),
      "the key kobai answered with, in the list",
    );
    await auditAccessibility(page, "the API keys screen showing a minted key");
  });

  it("checks the shape of the form without asking kobai", async () => {
    const page = await seam.signedIn("/api-keys");

    let asked = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/admin/api-keys"
      ) {
        asked += 1;
      }
    });

    await page.getByRole("button", { name: "Mint" }).click();

    await shows(
      page.getByText("A key is told from another by its name"),
      "the empty name's own message",
    );
    expect(
      asked,
      "A nameless key was sent to kobai rather than caught by the form's own schema.",
    ).toBe(0);
  });

  it("revokes a key and reads the list back rather than crossing it out", async () => {
    const name = `Revoked in a browser ${Date.now()}`;
    await seam.api("POST", "/admin/api-keys", { name, kind: "publishable" });
    const page = await seam.signedIn("/api-keys");

    const row = page.getByRole("row", { name: new RegExp(name) });
    await shows(row, "the key to revoke");
    // `live` before, `revoked …` after, and the row still there: revoking is not a deletion,
    // so a Merchant can still see the key existed and when it stopped working.
    await shows(row.getByText("live"), "the key's state before revoking it");

    await row.getByRole("button", { name: "Revoke" }).click();

    await shows(row.getByText(/^revoked /), "the key's state, as kobai answered it");
    // Revoke is the only destructive control on any of these screens, and its palette is what
    // #176 had to fix for contrast — so it is audited with a revoked row on screen.
    await auditAccessibility(page, "the API keys screen after a revocation");
  });
});

describe("paging through the API keys", () => {
  /**
   * A page of keys and one more.
   *
   * The same shape as the Orders block above and for the same reason: a key is never deleted,
   * so what the second page holds depends on how many keys the rest of this file happened to
   * mint. A full first page, a non-empty second, and no key on both is true either way.
   */
  let aPage = 0;

  beforeAll(async () => {
    aPage = await defaultPageLimit("/admin/api-keys");
    for (let key = 0; key < aPage + 1; key += 1) {
      await seam.api("POST", "/admin/api-keys", {
        name: `Paged key ${String(key).padStart(2, "0")}`,
        kind: "publishable",
      });
    }
  }, BROWSER_SEAM_TIMEOUT);

  it("puts the cursor in the URL, so the older keys are reachable at all", async () => {
    const page = await seam.signedIn("/api-keys");
    await shows(page.getByRole("link", { name: "Next" }), "the Next control");
    await holdsRows(page, aPage);
    const first = await firstCells(page);

    await page.getByRole("link", { name: "Next" }).click();

    expect(where(page)).toMatch(/^\/api-keys\?after=.+/);
    await settlesOn(page, (names) => names.join() !== first.join());

    const beyond = await firstCells(page);
    expect(beyond.length).toBeGreaterThan(0);
    // The gap this closes: without a pager the keys on this page could never be revoked, and
    // the Admin mints one for itself per browser session that has none.
    expect(beyond.filter((name) => first.includes(name))).toEqual([]);
  });
});

describe("the storefront price preview", () => {
  /**
   * The one screen whose whole subject is a request only a browser makes.
   *
   * ADR-0010 gives the Admin no privileged API, so "what price would a storefront receive" is
   * answered by *being* a storefront — a second client, a publishable key, over `/store`
   * (ADR-0020). Nothing about that is visible in a response body: the assertion is on the
   * request the page itself made, which no other seam in this repository can see. What is on
   * screen afterwards is asserted only as far as it takes to know the answer arrived rather
   * than being swallowed.
   */
  it("answers by being a storefront, over a publishable key", async () => {
    // Priced at 12.50, which this Project does not charge: `kobai.config.ts` fills Core's
    // `select-price` slot with `everything-costs-one-cent`, so the answer is one cent and the
    // difference is the whole point of the screen.
    const product = await seam.createProduct({
      title: "A poster with a preview",
      amount: 1250,
    });
    const page = await seam.signedIn(`/products/${product.id}`);

    const asked: { path: string; authorization: string }[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (!pathname.startsWith("/store/")) return;
      asked.push({
        path: pathname,
        authorization: request.headers().authorization ?? "",
      });
    });

    await page.getByRole("button", { name: "What would a storefront receive?" }).click();

    await shows(
      page.getByText("This Project changed the price."),
      "the difference between what was entered and what a storefront gets",
    );
    await shows(
      page.getByText("everything-costs-one-cent"),
      "the Step this Project put in the slot",
    );

    // The criterion itself (ADR-0020): the Admin found out what a storefront receives by
    // *being* one — over `/store`, with a `kobai_pk_` key — rather than by asking the admin
    // surface for a number no storefront could get. There is no such route and there must not
    // be one.
    expect(asked).toEqual([
      {
        path: `/store/variants/${product.variantId}/price`,
        authorization: expect.stringMatching(/^Bearer kobai_pk_/),
      },
    ]);

    await auditAccessibility(page, "the Product screen showing a resolved price");
  });
});

/**
 * What a Role may do, as the Admin offers it (#178, ADR-0063).
 *
 * **Every case here signs in as somebody other than the seeded Merchant**, because the seeded
 * one holds `owner` — every Permission Core defines (ADR-0041) — so there is nothing for the
 * Admin to hide or explain to them. `seam.merchantOnARole` is what makes a narrow one.
 *
 * None of this is a boundary and no case here should be read as asserting one. `requirePermission`
 * is the enforcement, and it is asserted where it lives — `auth.test.ts` sweeps the whole admin
 * surface for it. What is asserted here is the **affordance**: that a section a Role cannot read
 * is not offered, that an action it cannot perform is shown, reachable, and explained rather
 * than hidden or silently dead, and that a Role edited under a live session takes effect without
 * anybody signing out. Every one of those is a thing only a browser can be asked.
 *
 * The `aria-disabled` cases are the ones with no substitute anywhere else. A truly `disabled`
 * control takes no focus and fires no pointer events, so the explanation this ticket exists to
 * give would be unreachable through the obvious implementation — and the price of `aria-disabled`
 * is that it does *not* prevent activation, so the no-op has to be real. Both halves are asked:
 * the keyboard reaches the control and is told why, and pressing Enter on it changes nothing.
 */
describe("what a Role may do", () => {
  /** The Permissions the Admin's own screens read, spelled as the API spells them. */
  const CATALOG_READ = "catalog:read";
  const CATALOG_WRITE = "catalog:write";
  const ORDER_READ = "order:read";
  const API_KEY_READ = "api-key:read";
  const API_KEY_WRITE = "api-key:write";

  /**
   * What a screen reader would read out about a control, off its `aria-describedby`.
   *
   * The tooltip is the *visual* half of the explanation and associates itself with nothing —
   * Base UI's popup carries no `role="tooltip"` and sets no `aria-describedby` — so this is the
   * half that is actually announced, and a case that only asserted the tooltip would pass
   * against a control a screen reader is told nothing about.
   */
  async function describedText(page: Page, control: Locator): Promise<string> {
    const describedBy = await control.getAttribute("aria-describedby");
    expect(describedBy, "the control is described by nothing at all").toBeTruthy();
    // `textContent` rather than `innerText`: the sentence is deliberately rendered where only
    // a screen reader finds it, and what a screen reader reads is the text and not the pixels.
    return (await page.locator(`#${describedBy}`).textContent()) ?? "";
  }

  /** The sidebar's own entries, which are links and not buttons (`LinkButton`, #175). */
  function sections(page: Page): Promise<string[]> {
    return page
      .getByRole("complementary", { name: "Sections and account" })
      .getByRole("link")
      .allInnerTexts();
  }

  it("offers only the sections the Role can read, in the sidebar and in the palette", async () => {
    const narrow = await seam.merchantOnARole([CATALOG_READ, CATALOG_WRITE]);
    const page = await seam.signedInAs(narrow, "/products");
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    // Orders and API keys would 403 on load for this Role, and an empty screen that refuses
    // teaches nothing — so they are absent rather than present and dead (ADR-0063).
    await expect.poll(() => sections(page)).toEqual(["Products"]);

    // The palette reads the same list, which is the whole reason `lib/sections.ts` is a module:
    // two navigation affordances over one list cannot disagree about what this Admin has.
    await page.keyboard.press("Meta+k");
    await shows(
      page.getByRole("combobox", { name: "Search sections" }),
      "the command palette",
    );
    await expect
      .poll(() => page.getByRole("option").allInnerTexts())
      .toEqual(["Products"]);

    await auditAccessibility(page, "the Admin's palette on a narrow Role");
  });

  it("sends the front door to a section the Role can actually read", async () => {
    // No `catalog:read`, so the Products list this Admin's front door has always pointed at is
    // a screen this Merchant would meet a refusal on.
    const narrow = await seam.merchantOnARole([ORDER_READ]);
    const page = await seam.signedInAs(narrow, "/");

    await expect.poll(() => where(page)).toBe("/orders");
    await expect.poll(() => sections(page)).toEqual(["Orders"]);
    await auditAccessibility(
      page,
      "the front door on a Role that cannot read the catalog",
    );
  });

  it("says so, rather than showing an empty frame, when a Role reaches nothing at all", async () => {
    // A Role with no Permissions at all is what `POST /admin/roles` creates by default, so it
    // is not a contrived state: it is the one a colleague is added on before anybody says what
    // they may do.
    const narrow = await seam.merchantOnARole([]);
    const page = await seam.signedInAs(narrow, "/");

    await shows(
      page.getByText("This Admin has nothing to show you"),
      "the screen for a Role that can read nothing",
    );
    await expect.poll(() => sections(page)).toEqual([]);
    // The frame names the section in the document's one `h1`, and this address belongs to no
    // section — so the fallback matters here in a way it never did while `/` redirected
    // instantly. A Merchant whose Role is empty must not hear their Admin announced as an
    // error.
    expect(await page.getByRole("heading", { level: 1 }).innerText()).toBe("kobai Admin");
    await auditAccessibility(page, "the Admin on a Role that reaches nothing");
  });

  it("shows an action the Role cannot perform, reachable by keyboard, and says why", async () => {
    const narrow = await seam.merchantOnARole([CATALOG_READ]);
    const page = await seam.signedInAs(narrow, "/products");
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    const create = newProductForm(page).getByRole("button", { name: "Create" });
    // Shown rather than hidden: a Merchant with no way to see that Products can be created has
    // no way to learn to ask for the Permission (ADR-0063).
    await shows(create, "the Create button");
    expect(await create.getAttribute("aria-disabled")).toBe("true");
    // And not the attribute that would have made the explanation unreachable.
    expect(await create.getAttribute("disabled")).toBeNull();
    // The half `disabled` would have taken away, and the reason `aria-disabled` is not a style
    // preference: a control that takes no focus cannot be reached to be told why it is dead.
    await tabTo(page, create, "the unavailable Create button");

    // What a mouse gets, from the keyboard: focusing the control opens the same tooltip
    // hovering it would.
    const tooltip = page.locator('[data-slot="tooltip-content"]');
    await shows(tooltip, "the tooltip explaining the Create button");
    expect(await tooltip.innerText()).toContain(`does not hold "${CATALOG_WRITE}"`);
    // And what a screen reader gets, which is not the same thing: Base UI's tooltip is a
    // visual affordance and associates itself with nothing, so the control has to be described
    // by the sentence whether the tooltip is open or not.
    expect(await describedText(page, create)).toContain(
      `does not hold "${CATALOG_WRITE}"`,
    );

    await auditAccessibility(page, "the Products screen on a Role that cannot write");
  });

  it("does nothing at all when an unavailable action is activated", async () => {
    const narrow = await seam.merchantOnARole([CATALOG_READ]);
    const page = await seam.signedInAs(narrow, "/products");
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    const title = `Never created ${Date.now()}`;
    const form = newProductForm(page);
    await form.getByLabel("Title").fill(title);
    await form.getByLabel("SKU").fill(`NEVER-${Date.now()}`);
    await form.getByLabel(PRICE_FIELD).fill("1250");

    const writes = watchForWrites(page);

    // `aria-disabled` does not prevent activation, which is exactly why the handler has to
    // no-op for real — and there are three ways in. A click is the mouse's, forced past
    // Playwright's own refusal to click something `aria-disabled`, because a browser has no
    // such refusal; Enter on the focused control is the keyboard's; and Enter in a *field* is
    // implicit submission, which a browser performs by clicking this form's default button —
    // so it arrives at the same handler, which is why the form needs no guard of its own.
    //
    // Watched failing with the handler forwarded: this reported `POST /admin/products`.
    const create = form.getByRole("button", { name: "Create" });
    await create.click({ force: true });
    await create.press("Enter");
    await form.getByLabel(PRICE_FIELD).press("Enter");

    // A refused creation is not the failure this case is about: spending a round trip to be
    // told something the Admin already knew is the thing the affordance exists to avoid.
    await expect(writes.settled()).resolves.toEqual([]);

    // And the books, because the screen cannot prove a Product was not created.
    const listed = await seam.api<{ products: { title: string }[] }>(
      "GET",
      "/admin/products?limit=100",
    );
    expect(listed.products.map((product) => product.title)).not.toContain(title);
  });

  it("does nothing when an unavailable action is not a form's either", async () => {
    // The Create button above is a `type="submit"`, so what stops it is `preventDefault` on the
    // click. Revoke is a plain button, where the whole of the no-op is the caller's own handler
    // not being forwarded — a different half of the same component, and the one that carries
    // every unavailable action this Admin has that is not a form's.
    //
    // Watched failing with that handler forwarded: this reported the `DELETE` it should not
    // have made.
    const narrow = await seam.merchantOnARole([API_KEY_READ]);
    await seam.api("POST", "/admin/api-keys", {
      name: `never revoked ${Date.now()}`,
      kind: "publishable",
    });
    const page = await seam.signedInAs(narrow, "/api-keys");
    await shows(
      page.getByText("The credentials a storefront presents at"),
      "the API keys screen",
    );

    const revoke = page.getByRole("button", { name: "Revoke" }).first();
    await shows(revoke, "a Revoke button");
    expect(await revoke.getAttribute("aria-disabled")).toBe("true");
    expect(await describedText(page, revoke)).toContain(
      `does not hold "${API_KEY_WRITE}"`,
    );

    const writes = watchForWrites(page);

    await revoke.click({ force: true });
    await revoke.press("Enter");

    await expect(writes.settled()).resolves.toEqual([]);
    await auditAccessibility(page, "the API keys screen on a Role that cannot revoke");
  });

  it("takes a Role edited elsewhere on the next navigation, without signing out", async () => {
    const narrow = await seam.merchantOnARole([CATALOG_READ, ORDER_READ]);
    const page = await seam.signedInAs(narrow, "/products");
    await expect.poll(() => sections(page)).toEqual(["Products", "Orders"]);

    // Somebody else, in another browser, widens this Role. The Merchant's session is untouched
    // — a Role is read on every request rather than copied into the session — so the Admin is
    // now confidently wrong about what this Merchant may do until it asks again.
    await seam.api("PATCH", `/admin/roles/${narrow.roleId}`, {
      permissions: [CATALOG_READ, ORDER_READ, API_KEY_READ],
    });

    await page.getByRole("link", { name: "Orders" }).click();
    expect(where(page)).toBe("/orders");

    // The half of ADR-0063 that #175 left unwired: the session query is re-read on navigation
    // as well as on window focus, so the frame catches up without anybody signing out.
    await expect.poll(() => sections(page)).toEqual(["Products", "Orders", "API keys"]);

    // And back the other way, which is the direction that actually takes an offer away — a
    // frame that only ever grew would be wrong in the one case a Merchant is *meant* to stop
    // being able to reach something.
    await seam.api("PATCH", `/admin/roles/${narrow.roleId}`, {
      permissions: [CATALOG_READ],
    });
    await page.getByRole("link", { name: "Products" }).click();
    await expect.poll(() => sections(page)).toEqual(["Products"]);
  });

  it("takes a Role edited elsewhere when the window is focused, with no navigation", async () => {
    const narrow = await seam.merchantOnARole([CATALOG_READ]);
    const page = await seam.signedInAs(narrow, "/products");
    await expect.poll(() => sections(page)).toEqual(["Products"]);

    await seam.api("PATCH", `/admin/roles/${narrow.roleId}`, {
      permissions: [CATALOG_READ, ORDER_READ],
    });

    // The other half of ADR-0063's re-read, and the half a headless browser cannot produce for
    // real: its page is always visible, so there is no window to come back to. What is asserted
    // is that the Admin is listening — TanStack Query's focus manager subscribes to
    // `visibilitychange` on `window`, and this Admin says `refetchOnWindowFocus` rather than
    // inheriting it. Watched failing with that turned off, which is what makes this a case
    // about the Admin rather than about TanStack Query's defaults.
    await refocusTheWindow(page);

    expect(where(page)).toBe("/products");
    await expect.poll(() => sections(page)).toEqual(["Products", "Orders"]);
  });
});

/**
 * The catalog screens, and the promises only a browser can be asked about (#179).
 *
 * Everything a Merchant can do to a catalog entry is on the Product screen, and almost all of
 * it is asserted through the API in `packages/core/src/catalog/`. What is here is the handful
 * of things a request cannot ask: that a refused deletion is answered **inside the dialog it
 * was attempted from**, that the delete control is offered even when the deletion is about to
 * be refused, that superseding a Price really is an add followed by a remove *in that order*,
 * and that deleting a Product leaves the address that no longer resolves.
 */
describe("the catalog screens", () => {
  /** The Product screen for something this case made, opened. */
  async function openAProduct(product: { id: string }): Promise<Page> {
    const page = await seam.signedIn(`/products/${product.id}`);
    await shows(page.getByRole("heading", { level: 2 }), "the Product's title");
    return page;
  }

  /** The Stock section's table, named by the column only it has. */
  function stockTable(page: Page) {
    return page
      .getByRole("table")
      .filter({ has: page.getByRole("columnheader", { name: "Reserved" }) });
  }

  /** The Prices table, named the same way. */
  function priceTable(page: Page) {
    return page
      .getByRole("table")
      .filter({ has: page.getByRole("columnheader", { name: "Minor units" }) });
  }

  it("renames a Product, and reads the new title back rather than keeping the typed one", async () => {
    const product = await seam.createProduct({ title: "A poster with a typo" });
    const page = await openAProduct(product);

    await page.getByLabel("Title").fill("A poster, corrected");
    await page.getByRole("button", { name: "Rename" }).click();

    // The heading and the breadcrumb both come from the re-read, not from the field: there is
    // no optimistic update anywhere in this Admin (ADR-0063).
    await shows(
      page.getByRole("heading", { name: "A poster, corrected" }),
      "the renamed Product's heading",
    );
    await auditAccessibility(page, "the Product screen after a rename");
  });

  it("adds a Variant to a Product that already exists", async () => {
    const product = await seam.createProduct({ title: "A poster wanting a second size" });
    const page = await openAProduct(product);

    const form = page.locator("form").filter({ hasText: "Add Variant" });
    await form.getByLabel("SKU").fill(`SECOND-${Date.now()}`);
    await form.getByRole("button", { name: "Add Variant" }).click();

    // Two Variant cards where there was one, read back off kobai.
    await expect
      .poll(() => page.getByRole("heading", { level: 3, name: /^Variant/ }).count(), {
        timeout: LOCATOR_TIMEOUT,
        message: "The second Variant never appeared on the Product screen.",
      })
      .toBe(2);
    await auditAccessibility(page, "the Product screen with two Variants");
  });

  it("counts stock, and shows on hand, reserved and available separately", async () => {
    const product = await seam.createProduct({ title: "A poster to be counted" });
    const page = await openAProduct(product);

    // Untracked is not none left, and the screen says so in words before anybody counts.
    await shows(
      page.getByText(/Nobody is counting this Variant/),
      "the untracked explanation",
    );

    await page.getByLabel(/On hand/).fill("7");
    await page.getByRole("button", { name: "Set count" }).click();

    // Three numbers rather than one: stock that is gone and stock that is spoken for are
    // different facts a Merchant acts on differently. `available` is `onHand - reserved`, a
    // subtraction this browser cannot do, so it is read back rather than predicted.
    const cells = stockTable(page).getByRole("cell");
    await shows(cells.first(), "the stock table");
    await expect
      .poll(() => cells.allInnerTexts(), {
        timeout: LOCATOR_TIMEOUT,
        message: "The stock count never settled at what was entered.",
      })
      .toEqual(["7", "0", "7"]);
    await auditAccessibility(page, "the Product screen showing a stock count");
  });

  it("corrects a SKU and swaps the Strategy together, and the count under it does not move", async () => {
    const product = await seam.createProduct({ title: "A poster becoming a download" });
    // Counted *before* the swap, which is the whole of what makes the last assertion mean
    // anything: an uncounted Variant reports `inventory: null` afterwards whatever happened to
    // it, so asserting on that would have been an assertion `null` passes by existing.
    await seam.api("PUT", `/admin/variants/${product.variantId}/inventory`, {
      onHand: 4,
    });
    const page = await openAProduct(product);

    // Scoped to the Variant's own section rather than taken `.first()`: the Add a Variant form
    // below carries a SKU and a Strategy of its own, so an unscoped locator is two elements and
    // an unscoped `.first()` is the right one only by accident of DOM order.
    const identity = page.getByRole("group", { name: "Identity" });

    // The picker is fed by `GET /admin/fulfilment-strategies` (ADR-0067) — the route this
    // ticket added because the Admin had no way to learn the set, and hard-coding Core's two
    // is the closed set ADR-0014 exists to prevent, written into the client.
    const picker = identity.getByRole("combobox", { name: "Fulfilment Strategy" });
    await shows(picker, "the Fulfilment Strategy picker");

    // Exactly what this deployment wired, asked of kobai rather than written down here: a case
    // that spelled `physical` and `digital` would be the same closed set in a third place, and
    // would go red on the first deployment that wires a Plugin's Strategy — as this one does,
    // because the reference Project wires `@kobai/plugin-made-to-order`'s beside Core's two.
    const wired = (
      await seam.api<{ strategies: { name: string }[] }>(
        "GET",
        "/admin/fulfilment-strategies",
      )
    ).strategies.map((strategy) => strategy.name);

    await picker.click();
    await expect
      .poll(() => page.getByRole("option").allInnerTexts(), {
        timeout: LOCATOR_TIMEOUT,
        message: "The Strategy list never filled in from kobai.",
      })
      .toEqual(wired);

    // Audited **with the list open**, because an overlay is a screen — and this is the audit
    // that `lib/portal.tsx` exists for. Base UI portals the list out of its card, and at its
    // default target of `<body>` it is content outside every landmark, which axe reports as
    // `region`. Watched failing exactly that way before the frame offered a container inside
    // `main`, and that is the only reason to believe this case can catch it.
    await auditAccessibility(page, "the Product screen with the Strategy list open");

    // Both fields at once, because that is what the one form does — ADR-0062 settles the SKU
    // and the Strategy as corrections in place, and a Merchant here to repair one is very often
    // fixing the other.
    const corrected = `SWAPPED-${Date.now()}`;
    await page.getByRole("option", { name: "digital", exact: true }).click();
    await identity.getByLabel("SKU").fill(corrected);
    await page.getByRole("button", { name: "Save Variant" }).click();

    await expect
      .poll(async () => (await picker.innerText()).trim(), {
        timeout: LOCATOR_TIMEOUT,
        message: "The Variant never settled on the Strategy it was swapped onto.",
      })
      .toBe("digital");
    await shows(
      page.getByRole("heading", { level: 3, name: `Variant ${corrected}` }),
      "the Variant under its corrected SKU",
    );

    // **The count under it does not move**, which is ADR-0062's decision and the one thing a
    // swap must not quietly do: discarding it would throw away a number a Merchant went and
    // counted, and `consume` is guarded, so it could fail a Capture past `take-payment`.
    await expect(
      seam.api<{ variants: { sku: string; inventory: unknown }[] }>(
        "GET",
        `/admin/products/${product.id}`,
      ),
    ).resolves.toMatchObject({
      variants: [{ sku: corrected, inventory: { onHand: 4, reserved: 0, available: 4 } }],
    });
  });

  it("deletes a Price on its own, and reads the Variant back without it", async () => {
    const product = await seam.createProduct({
      title: "A poster with a Price to drop",
      amount: 1250,
    });
    // A second Price, so the delete is the subject rather than the Variant becoming unquotable.
    await seam.api("POST", `/admin/variants/${product.variantId}/prices`, {
      amount: 900,
    });
    const page = await openAProduct(product);
    await expect
      .poll(() => priceTable(page).getByRole("row").count(), {
        timeout: LOCATOR_TIMEOUT,
        message: "The Variant never showed both of its Prices.",
      })
      .toBe(3);

    // The newest is at the head of the list, which is the one this row's Delete belongs to.
    const row = priceTable(page).getByRole("row").filter({ hasText: "900" });
    await row.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("alertdialog");
    await shows(dialog, "the Delete Price confirmation");
    await dialog.getByRole("button", { name: "Delete" }).click();

    await hides(dialog, "the Delete Price dialog");
    // Read back rather than filtered out of an array: a Price is a row, and what the Variant
    // carries once one is gone is kobai's answer (ADR-0008, ADR-0063).
    await expect
      .poll(() => priceTable(page).getByRole("row").count(), {
        timeout: LOCATOR_TIMEOUT,
        message: "The deleted Price never left the table.",
      })
      .toBe(2);
    await shows(priceTable(page).getByText("1250"), "the Price that was left alone");
  });

  it("supersedes a Price by adding the new one before removing the old, and never edits one", async () => {
    const product = await seam.createProduct({
      title: "A poster whose price was wrong",
      amount: 1250,
    });
    const page = await openAProduct(product);

    /**
     * Every write this screen makes, in the order it made them.
     *
     * The whole subject of the case. There is deliberately no route that edits a Price's
     * amount (ADR-0062), so what "supersede" has to be is `POST` then `DELETE` — and in that
     * order, because the reverse leaves the Variant carrying no Price at all for as long as
     * the second request takes, which is a Shopper mid-checkout getting no quote.
     */
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "GET") return;
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });

    await page.getByRole("button", { name: "Supersede" }).click();
    await page.getByLabel(/New amount/).fill("900");
    await page.getByRole("button", { name: "Replace Price" }).click();

    await expect
      .poll(() => priceTable(page).getByRole("row").count(), {
        timeout: LOCATOR_TIMEOUT,
        message: "The superseded Price never settled to a single row.",
      })
      // The header row and one Price: the new one is there and the old one is gone.
      .toBe(2);
    await shows(priceTable(page).getByText("900"), "the Price it was superseded to");

    expect(
      writes,
      "superseding did not add the new Price before removing the old.",
    ).toEqual([
      `POST /admin/variants/${product.variantId}/prices`,
      expect.stringMatching(
        new RegExp(`^DELETE /admin/variants/${product.variantId}/prices/`),
      ),
    ]);
    // And the Admin implies no edit route exists, because it does not: nothing here ever
    // `PATCH`es or `PUT`s a Price.
    expect(writes.filter((write) => /^(PATCH|PUT) .*\/prices/.test(write))).toEqual([]);
  });

  it("keeps the dialog open and renders a refused deletion inside it", async () => {
    // A Product with exactly one Variant, which is the state `last-variant` exists for: a
    // Product is only sellable through a Variant, so kobai refuses to remove its last one.
    const product = await seam.createProduct({ title: "A poster with one Variant" });
    const page = await openAProduct(product);

    const trigger = page.getByRole("button", { name: "Delete Variant" });
    // Nothing is predicted: the control is offered, not greyed out by an Admin that decided
    // for itself that this deletion would be refused. That rule lives in Core, Core may
    // change it, and a Developer's Project may already have (ADR-0059, ADR-0063).
    await expect(trigger.getAttribute("aria-disabled")).resolves.toBeNull();
    await trigger.click();

    const dialog = page.getByRole("alertdialog");
    await shows(dialog, "the Delete Variant confirmation");
    await dialog.getByRole("button", { name: "Delete Variant" }).click();

    // The refusal is *inside the dialog the Merchant is still looking at*. Closing it and
    // announcing the failure elsewhere would put the explanation where they no longer are —
    // and the Variant would still be on screen, so the screen would read as though nothing
    // had happened at all.
    await shows(
      dialog.getByText(/kobai will not remove its last one/),
      "the refusal, inside the dialog it was attempted from",
    );

    // Audited *while it is up*: an overlay is a screen, and this one is the only place this
    // sentence is ever rendered. It also waits for every animation to have finished, which is
    // what the assertion below needs and could not do for itself.
    await auditAccessibility(page, "the Delete Variant dialog showing a refusal");

    // **After** the audit, deliberately. A closing dialog fades rather than vanishing, so it
    // stays mounted and visible for the length of `data-closed:animate-out` — long enough that
    // this assertion, made the moment the refusal appeared, passed against a `ConfirmDelete`
    // that closed on every answer. Watched failing that way: with `onSettled: () => setOpen(false)`
    // the refusal still flashes on screen and only this line goes red.
    expect(
      await dialog.isVisible(),
      "The dialog closed on a refusal, which puts the explanation where the Merchant is not.",
    ).toBe(true);

    // And nothing was deleted, which is the other half of "it was refused".
    await expect(
      seam.api<{ variants: unknown[] }>("GET", `/admin/products/${product.id}`),
    ).resolves.toMatchObject({ variants: [{}] });
  });

  it("deletes a Variant a Product can spare, and reads the Product back", async () => {
    const product = await seam.createProduct({ title: "A poster with a spare Variant" });
    const spare = `SPARE-${Date.now()}`;
    await seam.api("POST", `/admin/products/${product.id}/variants`, { sku: spare });
    const page = await openAProduct(product);

    const card = page.locator("[data-slot=card]").filter({ hasText: spare });
    await card.getByRole("button", { name: "Delete Variant" }).click();
    const dialog = page.getByRole("alertdialog");
    await auditAccessibility(page, "the Delete Variant dialog before it is confirmed");
    await dialog.getByRole("button", { name: "Delete Variant" }).click();

    await hides(dialog, "the Delete Variant dialog");
    await hides(card, "the deleted Variant's card");
  });

  it("deletes a Product, and leaves the address that no longer resolves", async () => {
    const product = await seam.createProduct({ title: "A poster nobody wants" });
    const page = await openAProduct(product);

    await page.getByRole("button", { name: "Delete Product" }).click();
    const dialog = page.getByRole("alertdialog");
    await shows(dialog, "the Delete Product confirmation");
    await dialog.getByRole("button", { name: "Delete Product" }).click();

    // Away from an address that would now answer `product-not-found`, and `replace`, so the
    // back button does not walk straight back onto a deleted Product.
    await expect
      .poll(() => where(page), {
        timeout: LOCATOR_TIMEOUT,
        message: "Deleting the Product left the browser on the Product's own address.",
      })
      .toBe("/products");
    await shows(page.getByRole("heading", { name: "Products" }), "the Products list");
    await auditAccessibility(page, "the Products list after a Product was deleted");
  });

  it("offers no delete at all to a Role that cannot write the catalog, and says why", async () => {
    const product = await seam.createProduct({
      title: "A poster a reader is looking at",
    });
    const reader = await seam.merchantOnARole(["catalog:read"]);
    const page = await seam.signedInAs(reader, `/products/${product.id}`);
    await shows(page.getByRole("heading", { level: 2 }), "the Product's title");

    const trigger = page.getByRole("button", { name: "Delete Product" });
    // Shown rather than hidden, `aria-disabled` rather than `disabled`, and reachable by
    // keyboard so the sentence can be heard (ADR-0063, #178).
    await expect(trigger.getAttribute("aria-disabled")).resolves.toBe("true");
    await tabTo(page, trigger, "the Delete Product button");

    const watching = watchForWrites(page);
    // Forced past Playwright's own refusal to click something `aria-disabled`, because a
    // browser has no such refusal — and `press` is the keyboard's way in, which is the one a
    // Merchant who reached this control with Tab would use.
    await trigger.click({ force: true });
    await trigger.press("Enter");
    // No dialog, and no request: `aria-disabled` does not prevent activation, so the handler
    // has to genuinely no-op — which is the half a scanner cannot see.
    await expect(page.getByRole("alertdialog").count()).resolves.toBe(0);
    await expect(watching.settled()).resolves.toEqual([]);
    await auditAccessibility(page, "the Product screen on a read-only Role");
  });
});

/**
 * Merchants, Roles and the Store — the settings half of the Admin (#180, ADR-0066, ADR-0065).
 *
 * Everything these screens do to a record is asserted through the API, in
 * `packages/core/src/auth/` and `packages/core/src/store/`. What is here is the handful of
 * promises a request cannot ask, and each of them is a thing this ticket exists for:
 *
 * - that a **Permission Core has never heard of** is shown in the Role editor, ticked, and is
 *   still on the Role after a save — the API preserves it (#173), and an editor that hid it
 *   would put it back missing, which is data loss spelled as a form;
 * - that the **lockout is legible before it is attempted** and kobai's refusal still renders
 *   where it was attempted, which is the one place in this Admin anything is said about a
 *   refusal in advance;
 * - that a Role a Merchant cannot administer is **offered and explained** rather than hidden;
 * - and that the Store's **default currency is shown and not offered**, which is the honest
 *   reflection of #172's decision that a form could very easily have got wrong.
 *
 * **No case here creates a Merchant holding `merchant:write`**, and that is load-bearing rather
 * than incidental: the lockout case below attempts a change that is only refused while `owner`
 * is the last Role any Merchant holds carrying it, and a colleague on an administering Role
 * would make that attempt *succeed* — taking the seam's own Merchant's access away and failing
 * every case after it for a reason naming none of this. The case guards the invariant itself
 * before it attempts anything, so breaking it is a red build with a sentence rather than a
 * cascade.
 */
describe("Merchants, Roles and the Store", () => {
  /** The seeded `owner` Role, which is the only one that exists before a case makes another. */
  async function ownerRole(): Promise<{ id: string; permissions: string[] }> {
    const listed = await seam.api<{
      roles: { id: string; name: string; permissions: string[] }[];
    }>("GET", "/admin/roles?limit=100");
    const owner = listed.roles.find((role) => role.name === "owner");
    if (owner === undefined) {
      throw new Error("This deployment has no `owner` Role, so it was never seeded.");
    }
    return owner;
  }

  /** A Role made through the API, for a case whose subject is what the Admin does with one. */
  async function createRole(role: {
    name: string;
    permissions: readonly string[];
  }): Promise<{ id: string }> {
    return seam.api<{ id: string }>("POST", "/admin/roles", role);
  }

  /** The sections this ticket adds, as the sidebar and the palette spell them. */
  const SETTINGS_SECTIONS = ["Merchants", "Roles", "Store"];

  /** What the sidebar offers, which are links rather than buttons (`LinkButton`, #175). */
  function sidebarSections(page: Page): Promise<string[]> {
    return page
      .getByRole("complementary", { name: "Sections and account" })
      .getByRole("link")
      .allInnerTexts();
  }

  it("offers the three settings sections in the sidebar and in the palette", async () => {
    const page = await seam.signedIn("/products");
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    // Containment rather than the whole list, deliberately: what this case is about is that
    // the three screens this ticket adds are reachable from both affordances, and the
    // exhaustive list is already the subject of the palette's own case above — two copies of it
    // would be two edits every time a section is added, which is the tax `lib/sections.ts`
    // exists to stop one level down.
    await expect
      .poll(() => sidebarSections(page))
      .toEqual(expect.arrayContaining(SETTINGS_SECTIONS));

    // The palette reads the *same* list, which is why `lib/sections.ts` is a module rather
    // than markup in the sidebar: a screen added to one and not the other is how the two come
    // to disagree about what this Admin has.
    await page.keyboard.press("Meta+k");
    await shows(
      page.getByRole("combobox", { name: "Search sections" }),
      "the command palette",
    );
    await expect
      .poll(() => page.getByRole("option").allInnerTexts())
      .toEqual(expect.arrayContaining(SETTINGS_SECTIONS));

    await auditAccessibility(page, "the Admin's palette with the settings sections");
  });

  it("shows a Permission Core has never heard of, and keeps it across a save", async () => {
    // A word no build of Core defines. `POST /admin/roles` stores it because the set of
    // Permissions is open by design (ADR-0066) — and an Admin that offered only the words it
    // knew would drop it on the next save without anybody being told.
    const unknown = `reports:read-${Date.now()}`;
    const role = await createRole({
      name: `a Role with a word Core does not know ${Date.now()}`,
      permissions: ["catalog:read", unknown],
    });

    const page = await seam.signedIn(`/roles/${role.id}`);
    const held = page.getByRole("checkbox", { name: unknown });
    // **Watched failing** against a `useOfferedPermissions` built from the signed-in Merchant's
    // own Role alone — which is the shape an editor takes when nobody has thought about the
    // open set — and it failed here, on the checkbox never appearing, rather than three lines
    // down on the Permission having gone. That is the only reason to believe this case can
    // catch the thing it is about.
    await shows(held, "the unknown Permission's checkbox");
    // Ticked, not merely listed: it is a Permission this Role *holds*.
    await expect(held.getAttribute("aria-checked")).resolves.toBe("true");

    await auditAccessibility(page, "the Role editor holding an unknown Permission");

    // A change that has nothing to do with the unknown word, which is the point: what is
    // asserted is that saving something *else* does not quietly take it away.
    await page.getByRole("checkbox", { name: "order:read" }).click();
    await page.getByRole("button", { name: "Save Role" }).click();

    await expect
      .poll(
        async () =>
          (
            await seam.api<{ permissions: string[] }>("GET", `/admin/roles/${role.id}`)
          ).permissions
            .slice()
            .sort(),
        {
          timeout: LOCATOR_TIMEOUT,
          message: "The saved Role never settled at what the editor was showing.",
        },
      )
      .toEqual(["catalog:read", "order:read", unknown].sort());
  });

  it("adds a Permission this deployment has never used, typed rather than chosen", async () => {
    // The other half of an open set: a Permission **nobody holds** cannot be in a list built
    // out of what kobai has already said, so the only way it is ever reachable is by typing.
    const role = await createRole({
      name: `a Role about to learn a new word ${Date.now()}`,
      permissions: [],
    });
    const invented = `shipping:label-${Date.now()}`;

    const page = await seam.signedIn(`/roles/${role.id}`);
    await shows(page.getByRole("heading", { level: 2 }), "the Role's name");

    await page.getByLabel("Add another Permission").fill(invented);
    // With the keyboard, because Enter in that box would otherwise submit the form around it
    // and save the Role *without* the word just typed — which is the whole reason the field
    // has a key handler at all.
    await page.getByLabel("Add another Permission").press("Enter");

    const added = page.getByRole("checkbox", { name: invented });
    await shows(added, "the typed Permission's checkbox");
    await expect(added.getAttribute("aria-checked")).resolves.toBe("true");

    // Unticking it leaves it on screen rather than making it disappear. The list is built out
    // of what the Role holds, so a word nothing else in the deployment uses would otherwise be
    // gone the moment it was unticked — and a Merchant who mis-clicked would have to remember
    // it and type it again.
    await added.click();
    await expect(added.getAttribute("aria-checked")).resolves.toBe("false");
    await added.click();
    await expect(added.getAttribute("aria-checked")).resolves.toBe("true");
    // And Enter added it rather than saving: the Role has not moved yet.
    await expect(
      seam.api<{ permissions: string[] }>("GET", `/admin/roles/${role.id}`),
    ).resolves.toMatchObject({ permissions: [] });

    await page.getByRole("button", { name: "Save Role" }).click();
    await expect
      .poll(
        async () =>
          (await seam.api<{ permissions: string[] }>("GET", `/admin/roles/${role.id}`))
            .permissions,
        {
          timeout: LOCATOR_TIMEOUT,
          message: "The typed Permission never reached kobai.",
        },
      )
      .toEqual([invented]);
  });

  it("says the lockout rule before it is attempted, and renders kobai's refusal where it was", async () => {
    const owner = await ownerRole();

    /**
     * The invariant this case rests on, checked before anything is attempted.
     *
     * Stripping `merchant:write` from `owner` is refused **only** while no Merchant anywhere
     * holds it through another Role. If some earlier case has created an administering
     * colleague, the attempt below succeeds instead — and the seeded Merchant, which is how
     * every other case arranges anything, loses the power to administer access for the rest
     * of the run. So this fails loudly here rather than there.
     */
    const roster = await seam.api<{
      merchants: { email: string; role: { name: string; permissions: string[] } }[];
    }>("GET", "/admin/merchants?limit=100");
    expect(
      roster.merchants
        .filter((merchant) => merchant.role.permissions.includes("merchant:write"))
        .map((merchant) => merchant.role.name),
      "some case created a Merchant on an administering Role, so stripping `owner` would succeed rather than be refused — and would lock this seam out of its own deployment.",
    ).toEqual(["owner"]);

    const page = await seam.signedIn(`/roles/${owner.id}`);
    const administers = page.getByRole("checkbox", { name: "merchant:write" });
    await shows(administers, "the merchant:write checkbox");
    await administers.click();

    // **Said before the attempt, and it is a rule rather than a verdict.** Whether any Merchant
    // would be left holding the Permission is a question about rows this browser has not read,
    // and `GET /admin/merchants` pages — so the Admin states what kobai will do and does not
    // claim to know the answer. Nothing is disabled by it.
    await shows(
      page.getByText(/This Role is losing the power to administer access/),
      "the lockout warning",
    );
    const save = page.getByRole("button", { name: "Save Role" });
    await expect(save.getAttribute("aria-disabled")).resolves.toBeNull();
    await auditAccessibility(page, "the Role editor warning about a lockout");

    await save.click();

    // And the answer is kobai's, rendered in the form the change was attempted in — the same
    // rule as a refused deletion rendering in its dialog (ADR-0059, ADR-0063).
    await shows(
      page.getByText(/would leave nobody who could put it back/),
      "the last-administrator refusal",
    );
    await auditAccessibility(page, "the Role editor showing a refused change");

    // Nothing moved, which is the other half of "it was refused" — and, here, the reason the
    // rest of this file still works.
    await expect(
      seam.api<{ permissions: string[] }>("GET", `/admin/roles/${owner.id}`),
    ).resolves.toMatchObject({ permissions: owner.permissions });
  });

  it("creates a Role through the Admin and lists it", async () => {
    const name = `made in the Admin ${Date.now()}`;
    const page = await seam.signedIn("/roles");
    await shows(page.getByText("What a colleague can be given"), "the Roles screen");

    const form = page.locator("form").filter({ hasText: "Create Role" });
    await form.getByLabel("Name").fill(name);
    await form.getByRole("checkbox", { name: "catalog:read" }).click();
    await form.getByRole("button", { name: "Create Role" }).click();

    // Read back rather than patched in: newest first, so the Role kobai made is at the head of
    // the list it answers (ADR-0063, ADR-0064).
    const row = page.getByRole("row").filter({ hasText: name });
    await shows(row, "the new Role's row");
    await shows(row.getByText("catalog:read"), "the Permission it was given");
    await auditAccessibility(page, "the Roles list after a Role was created");
  });

  it("refuses a Role whose name is taken, in the form it was attempted in", async () => {
    const name = `taken twice ${Date.now()}`;
    await createRole({ name, permissions: [] });

    const page = await seam.signedIn("/roles");
    const form = page.locator("form").filter({ hasText: "Create Role" });
    await form.getByLabel("Name").fill(name);
    await form.getByRole("button", { name: "Create Role" }).click();

    await shows(
      form.getByText(/A Role already carries that name/),
      "the role-name-taken refusal, in the form it was attempted in",
    );
    await auditAccessibility(page, "the Roles screen showing a refused creation");
  });

  it("refuses to delete a Role Merchants hold, and stays in the dialog saying so", async () => {
    // A Role somebody actually holds, which is the state `role-in-use` exists for: kobai
    // refuses rather than cascading onto the Merchant or moving them somewhere it chose.
    const holder = await seam.merchantOnARole(["catalog:read"]);

    const page = await seam.signedIn(`/roles/${holder.roleId}`);
    const trigger = page.getByRole("button", { name: "Delete Role" });
    // Nothing is predicted: whether a Merchant holds this Role is a fact in Core, so the
    // control is offered and the answer is rendered (ADR-0059).
    await expect(trigger.getAttribute("aria-disabled")).resolves.toBeNull();
    await trigger.click();

    const dialog = page.getByRole("alertdialog");
    await shows(dialog, "the Delete Role confirmation");
    await dialog.getByRole("button", { name: "Delete Role" }).click();

    await shows(
      dialog.getByText(/Merchants hold this Role/),
      "the refusal, inside the dialog it was attempted from",
    );
    // The audit is also what waits for the closing animation that never comes, which is what
    // makes the assertion after it mean something rather than catching a dialog mid-fade.
    await auditAccessibility(page, "the Delete Role dialog showing a refusal");
    expect(
      await dialog.isVisible(),
      "The dialog closed on a refusal, which puts the explanation where the Merchant is not.",
    ).toBe(true);
  });

  it("deletes a Role nobody holds, and leaves the address that no longer resolves", async () => {
    const role = await createRole({
      name: `nobody wants this Role ${Date.now()}`,
      permissions: [],
    });
    const page = await seam.signedIn(`/roles/${role.id}`);

    await page.getByRole("button", { name: "Delete Role" }).click();
    const dialog = page.getByRole("alertdialog");
    await shows(dialog, "the Delete Role confirmation");
    await dialog.getByRole("button", { name: "Delete Role" }).click();

    await expect
      .poll(() => where(page), {
        timeout: LOCATOR_TIMEOUT,
        message: "Deleting the Role left the browser on the Role's own address.",
      })
      .toBe("/roles");
    await shows(page.getByRole("heading", { name: "Roles" }), "the Roles list");
  });

  it("says there is no such Role, rather than reporting a refusal", async () => {
    const page = await seam.signedIn("/roles/8f3c0f4e-0000-4000-8000-000000000000");

    await shows(page.getByText("No such Role"), "the no-such-Role screen");
    await shows(page.getByRole("link", { name: "Go to Roles" }), "the way back");
    await auditAccessibility(page, "the Role screen for an address with no Role");
  });

  it("adds a colleague against a narrower Role, and shows what they may do", async () => {
    const roleName = `a colleague's Role ${Date.now()}`;
    await createRole({ name: roleName, permissions: ["catalog:read"] });
    const email = `colleague-${Date.now()}@kobai.test`;

    const page = await seam.signedIn("/merchants");
    await shows(page.getByText("Everybody who can sign in"), "the Merchants screen");

    const form = page.locator("form").filter({ hasText: "Add Merchant" });
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Password").fill("this-colleague-signs-in-with-this");

    // The picker is fed by `GET /admin/roles` rather than by anything written down here: which
    // Roles a deployment has is kobai's answer, and a Role renamed between this read and the
    // submit is still attempted and still refused with `unknown-role`.
    const picker = form.getByRole("combobox", { name: "Role" });
    // Named before anything is chosen rather than blank: the form starts on no Role at all,
    // because `owner` — the Role `POST /admin/merchants` applies when none is named — is every
    // Permission Core defines, and is not a thing to hand out by not choosing.
    await expect
      .poll(async () => (await picker.innerText()).trim())
      .toBe("Choose a Role");
    await picker.click();
    await shows(
      page.getByRole("option", { name: roleName, exact: true }),
      "the Role this colleague is to be created against",
    );
    // Audited with the list open, because an overlay is a screen — and this is what
    // `lib/portal.tsx` exists for: at a portal's default target the list is content outside
    // every landmark, which axe reports as `region`.
    await auditAccessibility(page, "the Merchants screen with the Role list open");
    await page.getByRole("option", { name: roleName, exact: true }).click();

    await form.getByRole("button", { name: "Add Merchant" }).click();

    const row = page.getByRole("row").filter({ hasText: email });
    await shows(row, "the new Merchant's row");
    await shows(row.getByText(roleName), "the Role they were created against");
    await shows(row.getByText("catalog:read"), "what that Role may do");
    await auditAccessibility(page, "the Merchants list after a colleague was added");
  });

  it("offers the roster to a Role that may read it, and explains the actions it may not", async () => {
    // `merchant:read` without `merchant:write`: the split ADR-0066 draws, because seeing who
    // has access escalates to nothing while adding a colleague confers everything.
    const reader = await seam.merchantOnARole(["merchant:read"]);
    const page = await seam.signedInAs(reader, "/merchants");
    await shows(page.getByText("Everybody who can sign in"), "the Merchants screen");

    // Both sections this Permission opens, and nothing else.
    await expect.poll(() => sidebarSections(page)).toEqual(["Merchants", "Roles"]);

    const add = page.getByRole("button", { name: "Add Merchant" });
    // Shown rather than hidden, so a Merchant can learn the Permission is a thing to ask for,
    // and `aria-disabled` rather than `disabled`, so the sentence can be reached (ADR-0063).
    await expect(add.getAttribute("aria-disabled")).resolves.toBe("true");
    await expect(add.getAttribute("disabled")).resolves.toBeNull();
    await tabTo(page, add, "the unavailable Add Merchant button");

    const watching = watchForWrites(page);
    await add.click({ force: true });
    await add.press("Enter");
    // `aria-disabled` does not prevent activation, so the handler has to genuinely no-op —
    // the half a scanner cannot see.
    await expect(watching.settled()).resolves.toEqual([]);
    await auditAccessibility(page, "the Merchants screen on a read-only Role");
  });

  it("reads the Store, edits its name and metadata, and never offers to move the currency", async () => {
    const page = await seam.signedIn("/settings");
    await shows(page.getByRole("heading", { level: 1 }), "the Store screen");

    // Readable and not editable, which is #172's decision reflected honestly rather than an
    // input that was always going to be refused (ADR-0065).
    const currency = page.getByLabel("Default currency");
    await shows(currency, "the default currency");
    await expect(currency.getAttribute("readonly")).resolves.not.toBeNull();
    await shows(page.getByText(/Fixed\./), "the reason the currency does not move");

    const name = `The browser seam's Store ${Date.now()}`;
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Metadata").fill('{\n  "tone": "brisk"\n}');
    await page.getByRole("button", { name: "Save Store" }).click();

    await expect
      .poll(
        () =>
          seam.api<{ name: string; metadata: Record<string, unknown> }>(
            "GET",
            "/admin/store",
          ),
        {
          timeout: LOCATOR_TIMEOUT,
          message: "The Store never settled at what was entered.",
        },
      )
      .toMatchObject({ name, metadata: { tone: "brisk" } });
    await auditAccessibility(page, "the Store screen after a change");
  });

  it("checks that metadata is JSON without asking kobai", async () => {
    const page = await seam.signedIn("/settings");
    await shows(page.getByLabel("Metadata"), "the metadata field");

    const watching = watchForWrites(page);
    await page.getByLabel("Metadata").fill("not json at all");
    await page.getByRole("button", { name: "Save Store" }).click();

    // The *shape* of the field, which is what a schema in this Admin is for — whether the body
    // is an object at all is structure, and what is in it is nobody's business here
    // (ADR-0063). Nothing was sent.
    await shows(
      page.getByText(/this is not JSON kobai could read/),
      "the metadata shape message",
    );
    await expect(watching.settled()).resolves.toEqual([]);
    await auditAccessibility(page, "the Store screen with an unreadable metadata field");
  });
});
