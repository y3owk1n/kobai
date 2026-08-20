import { crc32, deflateSync } from "node:zlib";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  A_NARROW_WINDOW,
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
  storedInTheBrowser,
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
 * The currency pickers, which are three screens' worth and one question (#300).
 *
 * These are at the file's level rather than inside a `describe` because two of them are: the
 * Store and Region screens' pickers are asserted with the rest of the settings screens, and the
 * Price editor's with the catalog, and every one of them offers the Store's enabled set under a
 * name `Intl` gave it.
 */

/** This Store, straight from kobai — what it prices in, and what it is denominated in. */
function theStore(): Promise<{
  defaultCurrency: string;
  currencies: { code: string }[];
}> {
  return seam.api("GET", "/admin/store");
}

/** What this Store prices in, which is the set every one of those pickers offers. */
async function enabledCurrencies(): Promise<readonly string[]> {
  return (await theStore()).currencies.map((one) => one.code);
}

/**
 * Enables a currency if this Store has not got it, and answers the set as it now stands.
 *
 * **By appending**, because the whole set travels on every write: a body naming only what one
 * case cares about would disable whatever another had enabled. A case that needs a second
 * currency to look at arranges it rather than relying on the case that happens to run before it.
 */
async function alsoPricingIn(code: string): Promise<readonly string[]> {
  const already = await enabledCurrencies();
  if (already.includes(code)) return already;

  await seam.api("PATCH", "/admin/store", {
    currencies: [...already, code].map((one) => ({ code: one })),
  });
  return enabledCurrencies();
}

/**
 * The box a Merchant types into, which is **inside** the picker's popup.
 *
 * That is Base UI's other arrangement for a combobox and the one this Admin uses, for the reason
 * `components/combobox-field.tsx` gives at length: with the box outside, everything the popup is
 * not is `aria-hidden` while it is open — the field's own label included — and the audits in
 * these cases have been watched failing on exactly that. So the control on the screen is a
 * trigger, and the search is in the dialog it opens.
 */
function currencySearch(page: Page): Locator {
  return page.getByRole("dialog").getByRole("combobox");
}

/**
 * The codes an open currency list is offering, off the head of each row.
 *
 * Every row reads `<code> — <what this runtime calls it>`, and the name is the runtime's own
 * business — it moves with a browser's locale data and with the Merchant's locale. So the code is
 * what a case asserts on, and that a row *has* a name is asked separately.
 */
async function currencyCodesOffered(page: Page): Promise<string[]> {
  const rows = await page.getByRole("option").allInnerTexts();
  return rows.map((text) => text.trim().split(" ")[0] ?? "");
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
 * The sidebar's landmark, wherever it renders — named by `app-layout.tsx`, and by nothing else.
 *
 * It is one function rather than one per block because the narrow window renders the sidebar as
 * a sheet and the wide one as a column, and what a case asks for is the landmark either way.
 */
function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "Sections and account" });
}

/**
 * The headings over the sidebar's groups, in the order a Merchant reads them (#266).
 *
 * Read off the label rather than off the group's accessible name, because the label is the
 * thing on screen: a group named for a reader and headed with something else would satisfy
 * {@link sectionsInGroup} and tell a Merchant looking at it nothing.
 */
function sectionGroups(page: Page): Promise<string[]> {
  return sidebar(page).locator('[data-slot="sidebar-group-label"]').allInnerTexts();
}

/** What one of those groups holds, which are links rather than buttons (`LinkButton`, #175). */
function sectionsInGroup(page: Page, group: string): Promise<string[]> {
  return sidebar(page)
    .getByRole("group", { name: group })
    .getByRole("link")
    .allInnerTexts();
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

    expect(where(page)).toBe("/developer/api-keys");
    await auditAccessibility(page, "the API keys screen");
  });
});

/**
 * The frame at a width where the Admin renders its other self (#193).
 *
 * **This seam proves what it visits, at the viewport it visits it**, and until this block every
 * window in the file was Playwright's 1280×720 — comfortably above `md`, which is the only width
 * at which `Sidebar` takes its desktop branch. So `app-layout.tsx`'s `role="complementary"` and
 * its `aria-label` reached an element on every screen #175 audited, and below `md` reached a
 * Base UI dialog **root**,
 * which is a state container and not an element: the Admin had no sidebar landmark on a phone at
 * all, and the ticket whose whole subject was catching exactly this could not see it.
 *
 * **Which cases run twice is a decision, and the answer is "the sidebar's".** Running the file
 * at two widths would double the wall-clock of a file the maintainer was told costs 5–15 seconds,
 * and would re-audit an identical document for almost all of it: `hooks/use-mobile.ts` is the
 * only thing in this Admin that renders anything *different*, and `components/ui/sidebar.tsx` is
 * the only file that reads it. Everything else narrows in CSS, which changes a layout rather than
 * a document, and axe reads the document. So these two cases cover the three places that hook is
 * read — which branch `Sidebar` renders, which half `SidebarProvider`'s toggle takes, and whether
 * `SidebarMenuButton` hides its tooltip — and **a third case is earned by something else
 * branching on it**, not by a screen looking different when it is narrow.
 *
 * Both were watched failing before the fix, with `{...props}` still landing on `Sheet`, and both
 * failed on the landmark never appearing — which is the whole of the fault and is worth saying
 * exactly: axe stayed quiet on the sheet either way, because it excludes a `role="dialog"`
 * subtree from the `region` rule. **Nothing but asking for the landmark by name could have found
 * this**, which is why the case does that rather than leaning on the audit beside it.
 */
describe("the frame on a narrow screen", () => {
  /** The only way to a section below `md`, since the sidebar is not on screen until it is asked for. */
  function toggle(page: Page) {
    return page.getByRole("button", { name: "Toggle Sidebar" });
  }

  it("keeps the sidebar's landmark, and its sections, where the sidebar is a sheet", async () => {
    const page = await seam.signedIn("/products", A_NARROW_WINDOW);
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    // A screen with no sidebar on it at all, which is what a Merchant meets first on a phone:
    // the desktop branch is `hidden md:block` and the sheet has not been opened.
    await auditAccessibility(page, "the Products screen in a narrow window");

    await toggle(page).click();

    await shows(sidebar(page), "the sidebar's landmark in a narrow window");
    // Its contents, rather than only the role: a landmark on something holding nothing would
    // satisfy the assertion above and none of what the landmark is for. The **groups**, since
    // #266, because the sheet is the other document this Admin has and the grouping is drawn
    // in it too — and two of the sections rather than all of them, since `lib/sections.ts` is
    // where that list lives and a copy here would be the second answer to what this Admin has.
    await expect
      .poll(() => sectionGroups(page))
      .toEqual(["Commerce", "Settings", "Developer"]);
    await shows(
      sidebar(page)
        .getByRole("group", { name: "Commerce" })
        .getByRole("link", { name: "Products" }),
      "the Products section, inside the sheet's Commerce group",
    );
    await shows(
      sidebar(page)
        .getByRole("group", { name: "Developer" })
        .getByRole("link", { name: "API keys" }),
      "the API keys section, inside the sheet's Developer group",
    );
    await auditAccessibility(
      page,
      "the Products screen with the sidebar open in a narrow window",
    );
  });

  it("navigates from the sheet, which is the only way to a section on a phone", async () => {
    const page = await seam.signedIn("/products", A_NARROW_WINDOW);
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    await toggle(page).click();
    await shows(sidebar(page), "the sidebar's landmark in a narrow window");
    await sidebar(page).getByRole("link", { name: "Orders" }).click();

    expect(where(page)).toBe("/orders");
    await shows(page.getByText("Every Order this Store has taken"), "the Orders screen");
    // Nothing here says whether the sheet closed behind the navigation. What this case is about
    // is that a section is reachable from inside it and that the document is sound afterwards;
    // an assertion either way would be writing down today's answer to a question #193 never
    // asked, and this Admin does not close it.
    await auditAccessibility(page, "the Orders screen reached from the sheet");
  });
});

/**
 * The sections, in the three groups #266 puts them in (ADR-0079).
 *
 * A flat list stopped being a list at about eight entries, which is what #254 made it by adding
 * Media as the second section in a row whose only available place was "at the end". So the
 * sidebar draws **Commerce**, **Settings** and **Developer**, and the Developer group holds the
 * screen that was always in it: API keys mints credentials for a storefront and explains a
 * prefix convention, and no part of it is about running a shop.
 *
 * These are frame promises nothing else in this repository can ask. **Which groups a Role is
 * offered** is the narrowing of `lib/sections.ts` seen from outside — a Role whose sections all
 * sit in one group must meet that group alone rather than two empty headings, and a heading
 * over nothing reads as a list that failed to load. **Where the order inside a group sends the
 * front door** is the other one, and it is why `Settings` reads Merchants, Roles, Store: the
 * front door is the head of the narrowed list, so the order those three were already in is the
 * order that leaves an existing Role where it was. And **no redirect was left behind**: kobai
 * is not published, so the address API keys used to have is one no screen answers, and the
 * not-found screen is the honest answer to it.
 *
 * Two things this block deliberately does not repeat. The **new address** is asserted where the
 * sidebar is already driven — the keyboard case above reaches the API keys entry and lands on
 * `/developer/api-keys` — so what is left here is that the entry is inside the Developer group.
 * And the **palette** is asserted where the palette is: it stays flat, and the case that spells
 * its rows out is the one that also holds it to a single heading.
 */
describe("the sections, in three groups", () => {
  /** What each group holds, in the order the sidebar draws them — `lib/sections.ts`'s order. */
  const COMMERCE = ["Products", "Media", "Collections", "Orders", "Carts"];
  // Regions and Channels are **appended** to Settings rather than inserted, which is what leaves
  // the front door where it was: it lands on the head of the narrowed list, so a section put
  // ahead of another moves where every Role holding both arrives (#291, #266).
  const SETTINGS = ["Merchants", "Roles", "Store", "Regions", "Channels"];
  const DEVELOPER = ["API keys", "Deployment", "Playground"];

  it("draws Commerce, Settings and Developer, and every section inside one of them", async () => {
    const page = await seam.signedIn("/products");
    await shows(page.getByText("Everything this Store sells"), "the Products screen");

    await expect
      .poll(() => sectionGroups(page))
      .toEqual(["Commerce", "Settings", "Developer"]);
    // Exhaustively, and at this width only: this is the one case that says what the whole of
    // this Admin's navigation is, and the narrow one asserts the groups are drawn in the sheet
    // rather than repeating their contents.
    await expect.poll(() => sectionsInGroup(page, "Commerce")).toEqual(COMMERCE);
    await expect.poll(() => sectionsInGroup(page, "Settings")).toEqual(SETTINGS);
    await expect.poll(() => sectionsInGroup(page, "Developer")).toEqual(DEVELOPER);

    await auditAccessibility(page, "the Products screen with the sections grouped");
  });

  it("answers the address API keys used to have with no screen, and no redirect", async () => {
    const page = await seam.signedIn("/api-keys");

    // **No redirect is left behind** (ADR-0079). kobai is not published, so there is no
    // bookmark to preserve, and a redirect would be permanent furniture in vendored source
    // `kobai-upgrade` can never reach. Asserting the address as well as the screen, because a
    // redirect that landed on the new screen would satisfy the second alone.
    await shows(page.getByText("No such screen"), "the not-found screen");
    expect(where(page)).toBe("/api-keys");
    await auditAccessibility(page, "the old API keys address");
  });

  it("offers a Role holding only api-key:read the Developer group and nothing else", async () => {
    // The screen moved and its Permission did not, so this is the same Role that could reach
    // API keys before — meeting it in its new place, in the one group it can read anything in.
    const narrow = await seam.merchantOnARole(["api-key:read"]);
    const page = await seam.signedInAs(narrow, "/");

    // The front door is still the head of the *filtered* list, which for this Role is the one
    // section it holds — a heading over nothing is what a group that was drawn regardless
    // would have given it.
    await expect.poll(() => where(page)).toBe("/developer/api-keys");
    await expect.poll(() => sectionGroups(page)).toEqual(["Developer"]);
    // The one entry rather than {@link DEVELOPER}, and the difference is the subject: the group
    // holds Deployment too since #267, and this Role does not hold `deployment:read`. A group
    // narrowed to what a Role can read is what makes it an affordance rather than a menu.
    await expect.poll(() => sectionsInGroup(page, "Developer")).toEqual(["API keys"]);
    await auditAccessibility(page, "the Admin on a Role that may read only the API keys");
  });

  it("lands a Role that reads the Store and the roster on Merchants, as it did before", async () => {
    // **The order inside `Settings` is what decides this**, and nothing else does: the front
    // door is the head of the narrowed list, so `Merchants` ahead of `Store` is what keeps this
    // Role arriving where the flat list of eight put it. It is the case the order was chosen
    // for, so it is asserted here rather than argued in a comment in `lib/sections.ts`.
    //
    // What could not be preserved is a Role whose head *was* API keys — one holding
    // `api-key:read` alongside any of these three now lands on Merchants instead, because that
    // screen is last rather than fifth and moving it into `Developer` is the whole of #266.
    const narrow = await seam.merchantOnARole(["store:read", "merchant:read"]);
    const page = await seam.signedInAs(narrow, "/");

    await expect.poll(() => where(page)).toBe("/merchants");
    // `Settings` alone, in the sidebar's order: `merchant:read` opens the Roles screen as well
    // as the roster (ADR-0066), so this Role reads the whole group and no other.
    await expect.poll(() => sectionGroups(page)).toEqual(["Settings"]);
    await expect.poll(() => sectionsInGroup(page, "Settings")).toEqual(SETTINGS);
    await auditAccessibility(
      page,
      "the front door on a Role that may read only the Settings",
    );
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

    expect(where(page)).toBe("/developer/api-keys");
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
      .toEqual([
        "Products",
        "Media",
        "Collections",
        "Orders",
        "Carts",
        "Merchants",
        "Roles",
        "Store",
        // #291's two, and they are here rather than beside Store's neighbours for the reason
        // the sidebar's order gives: appending moves no Role's landing.
        "Regions",
        "Channels",
        "API keys",
        "Deployment",
        "Playground",
      ]);
    // **Flat, and one heading over the lot** (#266, ADR-0079). The sidebar draws three groups
    // and the palette draws none of them: what a palette is good at is answering a typed word
    // with a destination, and one that nested would be a menu. A heading per group is exactly
    // what reading `lib/sections.ts`'s new field here would have produced.
    await expect
      .poll(() => page.locator("[cmdk-group-heading]").allInnerTexts())
      .toEqual(["Sections"]);
    await expect.poll(() => selected(page)).toEqual(["Products"]);

    await page.keyboard.press("ArrowDown");
    await expect.poll(() => selected(page)).toEqual(["Media"]);
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => selected(page)).toEqual(["Collections"]);
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => selected(page)).toEqual(["Orders"]);
    // Both directions, because a list that only walks one way is one a Merchant who overshoots
    // has to close and reopen.
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => selected(page)).toEqual(["Collections"]);

    await page.keyboard.press("Enter");

    expect(where(page)).toBe("/collections");
    await shows(page.getByText("How this catalog is grouped"), "the Collections screen");
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

/**
 * The Carts a Store is holding, which is the one list whose rows are a **credential**.
 *
 * `GET /admin/carts` exists to answer a question a Merchant genuinely cannot ask otherwise —
 * *why is that stock unavailable?* — and once a Cart can hold stock while a Shopper is at
 * their bank the answer is usually a live Cart (ADR-0070, ADR-0071). So the identifier is on
 * screen on purpose: it is the whole of the authority to act on a Cart, and a Merchant may
 * enumerate these where the public may not.
 *
 * **Read-only, all the way to the screen.** There is no route that releases a hold and there
 * must not be one, so there is nothing here to click that changes anything.
 */
describe("Carts", () => {
  /**
   * Time passed, for one Cart, by winding the row back rather than by waiting.
   *
   * A Cart's lifetime is measured in days and there is no route that shortens one — the Admin's
   * Cart surface is read-only and the store surface has no such call either — so this is the
   * arrangement `admin-carts.test.ts` and `cart.test.ts` both make, in the one place this seam
   * is allowed to reach past the API for something the API cannot express.
   */
  async function expireTheCart(id: string): Promise<void> {
    await seam.database.query(
      "update core_cart set expires_at = now() - interval '1 second' where id = $1",
      [id],
    );
  }

  it("lists the Carts a storefront is holding, and opens one at an address of its own", async () => {
    const [cart] = await seam.startCarts();
    if (!cart) throw new Error("The seam started no Cart for this case to open.");

    const page = await seam.signedIn("/carts");
    const row = page.getByRole("row", { name: new RegExp(cart.id) });
    await shows(row, "the Cart in the list");
    await auditAccessibility(page, "the Carts screen");

    await row.getByRole("link", { name: "Open" }).click();

    expect(where(page)).toBe(`/carts/${cart.id}`);
    // The identifier is the record's name here, in a way an Order's never is: an Order has a
    // number a Shopper quotes and a Cart has only this, which is also what makes it worth
    // showing (ADR-0071).
    await shows(
      page.getByRole("heading", { name: new RegExp(cart.id) }),
      "the Cart's own heading",
    );
    await shows(
      page.getByRole("row", { name: new RegExp(cart.sku) }),
      "the Cart's Line Item",
    );
    await auditAccessibility(page, "the Cart screen");
  });

  /**
   * The filter, which is the part of this screen worth making reachable (ADR-0071).
   *
   * The three states **partition** the table, so one Cart of each is the whole fixture: what is
   * asserted is that each filter shows its own and hides the other two, which no two of them
   * being right by accident can satisfy. Unfiltered is mostly history on any real Store, which
   * is why the filter exists at all.
   */
  it("narrows to the live Carts, the expired and the spent, each at an address of its own", async () => {
    const [live] = await seam.startCarts();
    const [lapsed] = await seam.startCarts();
    const [placed] = await seam.placeOrders();
    if (!live || !lapsed || !placed) throw new Error("The seam arranged no Carts.");
    await expireTheCart(lapsed.id);

    const page = await seam.signedIn("/carts");
    // All three, before anything is narrowed — so the filter below is shown to be narrowing
    // this list rather than being the only way to read it.
    await settlesOn(
      page,
      (ids) => [live.id, lapsed.id, placed.cartId].every((id) => ids.includes(id)),
      "The unfiltered list never held all three Carts.",
    );

    const only = async (name: string, shown: string, hidden: readonly string[]) => {
      await page.getByRole("link", { name, exact: true }).click();
      await settlesOn(
        page,
        (ids) => ids.includes(shown) && hidden.every((id) => !ids.includes(id)),
        `The ${name} filter never settled on the Cart it is about.`,
      );
    };

    await only("Live", live.id, [lapsed.id, placed.cartId]);
    // The address is what a Merchant can send, which is the whole reason the filter is a link
    // rather than a control with a value nothing outside this tab can see.
    expect(where(page)).toBe("/carts?state=live");
    await auditAccessibility(page, "the Carts screen filtered to the live ones");

    await only("Expired", lapsed.id, [live.id, placed.cartId]);
    expect(where(page)).toBe("/carts?state=expired");

    await only("Spent", placed.cartId, [live.id, lapsed.id]);
    expect(where(page)).toBe("/carts?state=spent");

    // And a refresh lands on the filtered list rather than on the whole table, because the
    // filter is in the address and not in this tab's memory.
    await page.reload();
    expect(where(page)).toBe("/carts?state=spent");
    await settlesOn(
      page,
      (ids) => ids.includes(placed.cartId) && !ids.includes(live.id),
      "The filtered list did not survive a refresh.",
    );
  });

  /**
   * The filter reached the way a Merchant without a mouse reaches it.
   *
   * A scanner sees none of this: `axe-core` reads the links' names and their `aria-current` and
   * has no opinion about whether the keyboard can get to one. The filter is a set of **links**
   * rather than a control with a value partly for this — Tab reaches them and Enter follows
   * them, with no widget's own key handling in between.
   */
  it("reaches the filter with the keyboard, and Enter narrows the list", async () => {
    const [live] = await seam.startCarts();
    if (!live) throw new Error("The seam started no Cart for this case to find.");

    const page = await seam.signedIn("/carts");
    const spent = page.getByRole("link", { name: "Spent", exact: true });
    await shows(spent, "the Spent filter");

    await tabTo(page, spent, "the Spent filter");
    await page.keyboard.press("Enter");

    expect(where(page)).toBe("/carts?state=spent");
    await settlesOn(
      page,
      (ids) => !ids.includes(live.id),
      "The live Cart was still listed under the spent filter.",
    );
    // What a screen reader is told about which of the four is in force — the filled recipe is
    // the visual half, and a colour on its own says nothing to anybody listening.
    await expect(spent.getAttribute("aria-current")).resolves.toBe("page");
  });

  it("says there is no such Cart, rather than reporting a refusal", async () => {
    // A UUID this Store has certainly never issued. Unlike an Order, a Cart really can stop
    // being there — the sweeper takes lapsed ones away (ADR-0057) — so the screen says that
    // rather than insisting the address was always wrong.
    const page = await seam.signedIn(`/carts/${crypto.randomUUID()}`);

    await shows(page.getByText("No such Cart"), "the no-such-Cart screen");
    await shows(
      page.getByRole("link", { name: "Go to Carts" }),
      "the way back to the Carts list",
    );
    await auditAccessibility(page, "the Cart screen for a Cart that is not there");
  });

  /**
   * An address naming a state kobai does not have, which is a filter that cannot be applied.
   *
   * The failure this rules out is the quiet one: dropping the word and answering with the whole
   * table is a *different question* answered under a heading claiming otherwise, and a Merchant
   * reading it would have no way to know. kobai refuses the word too, with `invalid` — this
   * screen is what stops a round trip being needed to find out, so the case also watches that
   * no request is made.
   */
  it("says so when the address names a state kobai has never heard of", async () => {
    // A live Cart of this case's own, so that the good filter it walks through below really
    // has a page to leave in the cache — which is the whole subject of its second half.
    await seam.startCarts();

    const page = await seam.signedIn("/carts");
    await shows(page.getByRole("link", { name: "Live", exact: true }), "the filter");

    // Attached once the good screen is up, so that what follows counts only what the bad
    // address asked for.
    const watching = watchForWrites(page);
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "GET") asked.push(new URL(request.url()).pathname);
    });

    await page.goto(`${ADMIN_PATH}/carts?state=abandoned`);

    await shows(page.getByText("No such Cart state"), "the no-such-state screen");
    // The three that do exist are still offered, because the way out of a bad address is to
    // pick a good one.
    await shows(page.getByRole("link", { name: "Spent", exact: true }), "the filter");
    // …and none of the four is announced as being in force. "All" is the one that would have
    // been, since an unknown word narrows to nothing — which would tell a screen reader a
    // filter is applied on the one screen that is saying there is none.
    await expect(
      page.getByRole("link", { name: "All", exact: true }).getAttribute("aria-current"),
    ).resolves.toBeNull();
    // Nothing was asked of kobai about a word it would only have refused — and nothing was
    // written either, which is true of every screen in this section (ADR-0071).
    await expect(watching.settled()).resolves.toEqual([]);
    // The boot asks kobai who this Merchant is whatever the address says, so an empty list here
    // would mean nothing was being watched at all rather than that nothing was asked.
    expect(
      asked,
      "no request was seen, so this case would pass against anything",
    ).not.toEqual([]);
    expect(asked.filter((path) => path === "/admin/carts")).toEqual([]);
    await auditAccessibility(page, "the Carts screen at a state that does not exist");

    // …and it is still the answer when the address is reached with a page of Carts already in
    // the cache, which is the way a Merchant actually gets here: pick a real filter, then walk
    // back. A screen that said "no such Cart state" over a table left behind by the query
    // before it would be the quiet failure above wearing the honest answer's clothes, and a
    // cold load — the only way this case reached the address until #228 was reviewed — cannot
    // see it, because there is nothing in the cache to leave behind.
    await page.getByRole("link", { name: "Live", exact: true }).click();
    await shows(listRows(page).first(), "a page of live Carts");

    await page.goBack();

    expect(where(page)).toBe("/carts?state=abandoned");
    await shows(page.getByText("No such Cart state"), "the no-such-state screen again");
    await expect(listRows(page).count()).resolves.toBe(0);
  });
});

describe("paging through the Carts", () => {
  /**
   * A page of live Carts and one more, so that there is a second page to reach **within a
   * filter**.
   *
   * That is the whole subject: a cursor and a filter are two things in one query string, and a
   * pager that carried only the cursor would answer the second page of the *unfiltered* list —
   * which looks like paging working and is a different question being answered. Nothing here
   * empties anything first; every assertion is about which Carts are on a page rather than how
   * many, so the Carts other cases left behind cannot decide it.
   */
  let aPage = 0;

  beforeAll(async () => {
    aPage = await defaultPageLimit("/admin/carts");
    await seam.startCarts(aPage + 1);
  }, BROWSER_SEAM_TIMEOUT);

  it("keeps the filter in the address while it pages through it", async () => {
    const page = await seam.signedIn("/carts?state=live");
    await shows(page.getByRole("link", { name: "Next" }), "the Next control");
    await holdsRows(page, aPage);
    const first = await firstCells(page);

    await page.getByRole("link", { name: "Next" }).click();

    // The cursor is opaque, so there is nothing to assert about its value (ADR-0064) — but the
    // filter is not, and it has to still be there.
    expect(where(page)).toMatch(/^\/carts\?/);
    expect(new URL(page.url()).searchParams.get("state")).toBe("live");
    expect(new URL(page.url()).searchParams.get("after")).toBeTruthy();

    await settlesOn(page, (ids) => ids.join() !== first.join());
    const beyond = await firstCells(page);
    expect(beyond.length).toBeGreaterThan(0);
    // Every Cart exactly once, which is the whole argument for a cursor over an offset.
    expect(beyond.filter((id) => first.includes(id))).toEqual([]);
    await auditAccessibility(page, "a second page of live Carts");

    // …and back to the first page of the same filter, rather than to the whole table.
    await page.getByRole("link", { name: "Previous" }).click();
    expect(where(page)).toBe("/carts?state=live");
    await settlesOn(page, (ids) => ids.join() === first.join());
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
    const page = await seam.signedIn("/developer/api-keys");
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
    const page = await seam.signedIn("/developer/api-keys");

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
    const page = await seam.signedIn("/developer/api-keys");

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

  it("says the Channels could not be read, and still mints the key most Merchants want", async () => {
    const page = await seam.signedIn("/developer/api-keys");
    await shows(
      page.getByRole("combobox", { name: "Channel" }),
      "the mint form's Channel picker",
    );

    // The same arrangement the Regions screen's currency case takes, one noun along, and it
    // needs a browser for the reason that one does: a Channel picker holding nothing but `In no
    // particular Channel` is what a Store with no Channels draws too, and a failed read is a
    // state no request can arrange.
    await page.route(
      (url) => url.pathname === "/admin/channels",
      async (route) => {
        await route.abort();
      },
    );
    await page.reload();

    const picker = page.getByRole("combobox", { name: "Channel" });
    await shows(picker, "the Channel picker, on a load whose Channel read failed");
    await shows(
      page.getByText("kobai did not say which Channels it has."),
      "the failed read, said under the field it emptied",
    );

    // **The half this screen does not share with the currency pickers.** `In no particular
    // Channel` is a real answer rather than an empty-set placeholder, so the failure must not
    // read as though minting were off — the field says so in as many words, and the control
    // keeps the value that makes it true.
    await shows(
      page.getByText(/A key can still be minted into no particular Channel/),
      "what a Merchant can still do in spite of the failed read",
    );
    await expect
      .poll(async () => (await picker.innerText()).trim())
      .toBe("In no particular Channel");
    await expect(picker.isDisabled()).resolves.toBe(true);
    await auditAccessibility(page, "the API keys screen whose Channel read failed");

    // And it really mints, which is the assertion the two above are only evidence for: a form
    // that explained itself perfectly and then refused to submit would be the same defect
    // wearing better prose.
    const named = `Minted with no Channels to read ${Date.now()}`;
    await page.getByLabel("Name").fill(named);
    await page.getByRole("button", { name: "Mint" }).click();

    await shows(
      page.getByText("Copy this now — it is shown once."),
      "the key minted while the Channel read was failing",
    );
    await expect
      .poll(
        async () =>
          (
            await seam.api<{
              apiKeys: { name: string; channelId: string | null }[];
            }>("GET", "/admin/api-keys?limit=100")
          ).apiKeys.find((one) => one.name === named)?.channelId,
        {
          timeout: LOCATOR_TIMEOUT,
          message: "The key minted during a failed Channel read never reached kobai.",
        },
      )
      .toBeNull();
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
    const page = await seam.signedIn("/developer/api-keys");
    await shows(page.getByRole("link", { name: "Next" }), "the Next control");
    await holdsRows(page, aPage);
    const first = await firstCells(page);

    await page.getByRole("link", { name: "Next" }).click();

    expect(where(page)).toMatch(/^\/developer\/api-keys\?after=.+/);
    await settlesOn(page, (names) => names.join() !== first.join());

    const beyond = await firstCells(page);
    expect(beyond.length).toBeGreaterThan(0);
    // The gap this closes: without a pager the keys on this page could never be revoked, and
    // the Admin mints one for itself per browser session that has none.
    expect(beyond.filter((name) => first.includes(name))).toEqual([]);
  });
});

/**
 * The Deployment screen (#267, ADR-0080), which is three reads rendered as one answer.
 *
 * Every fact on it is asserted against kobai in `packages/core/src/http/deployment.test.ts`,
 * `catalog.test.ts` and the health tests — which is where a fact belongs. What is left, and
 * what only a browser can be asked, is the **composition**: that three separate reads land on
 * one screen, that a `replaced` and an `inserted` Step are told apart from a `stock` one by
 * looking rather than by reading a JSON field, and that one read being refused leaves the
 * other two answering rather than emptying the screen.
 *
 * The deployment under it is the reference Project's own, which is why this is worth asserting
 * here at all: it replaces `select-price`, inserts `record-price-resolution` after it, replaces
 * `apply-adjustments` with a Plugin's Step, and leaves every other position alone — so all
 * three origins are on screen at once, from a `kobai.config.ts` a Developer actually wrote.
 */
describe("the Deployment screen", () => {
  type DeploymentBody = {
    readonly version: string;
    readonly payments: { readonly configured: boolean };
  };
  type HealthBody = {
    readonly migrations: {
      readonly status: string;
      readonly sets?: readonly { readonly name: string; readonly applied: number }[];
    };
  };

  /** The Strategies the screen lists, in the order kobai answered them. */
  function strategies(page: Page): Promise<string[]> {
    return page
      .getByRole("list", { name: "Strategies wired here" })
      .getByRole("listitem")
      .allInnerTexts();
  }

  it("composes the release, the payment answer, the Strategies and the migration sets", async () => {
    // Asked of kobai rather than written down, and asked over the API rather than read off the
    // screen: an expectation taken from the side under test agrees with itself (ADR-0049).
    const deployment = await seam.api<DeploymentBody>("GET", "/admin/deployment");
    const health = await seam.api<HealthBody>("GET", "/health");
    const sets = health.migrations.sets ?? [];
    expect(sets.length, "This deployment reported no migration sets.").toBeGreaterThan(0);

    const page = await seam.signedIn("/developer/deployment");

    await shows(
      page.getByText(deployment.version, { exact: true }),
      "the release of Core this deployment runs",
    );
    // The reference Project wires one whatever its environment holds — `bank` when Stripe's
    // settings are there, its own `manual` provider when they are not — so this is the
    // affirmative half. The other half is the case below it.
    await shows(page.getByText("Configured"), "the Payment Provider answer");

    await expect
      .poll(() => strategies(page))
      .toEqual(["digital", "made-to-order", "physical"]);

    for (const set of sets) {
      await shows(
        page.getByRole("row", { name: new RegExp(`${set.name}\\s+${set.applied}$`) }),
        `the ${set.name} migration set, with the number of migrations it applied`,
      );
    }

    await auditAccessibility(page, "the Deployment screen");
  });

  it("distinguishes a replaced Step and an inserted one from the stock positions", async () => {
    const page = await seam.signedIn("/developer/deployment");

    // The one question ADR-0080 says is always worth asking about a kobai deployment, and the
    // one nothing else in this repository renders. The words are on the row rather than in a
    // colour, because a badge nobody can read is not a distinction.
    await shows(
      page.getByRole("row", {
        name: /select-price\s+everything-costs-one-cent\s+Replaced/,
      }),
      "the replaced Step, named as replaced beside the slot it fills",
    );
    await shows(
      page.getByRole("row", {
        name: /record-price-resolution\s+record-price-resolution\s+Inserted/,
      }),
      "the inserted Step, which slot-and-name equality would have called stock",
    );
    await shows(
      page.getByRole("row", { name: /load-prices\s+load-prices\s+Stock/ }),
      "a position nothing has touched, said to be stock rather than left blank",
    );
    // Both Workflows, so the screen is not one Workflow's worth of the answer.
    await shows(
      page.getByText("resolve-price", { exact: true }),
      "the resolve-price Workflow",
    );
    await shows(
      page.getByText("place-order", { exact: true }),
      "the place-order Workflow",
    );
  });

  it("says a Payment Provider is not wired, rather than leaving the answer off", async () => {
    const page = await seam.signedIn("/developer/deployment");

    // **A deployment with no provider is a boot-time decision no request can make**, and the
    // reference Project always wires one (ADR-0053) — so the only honest way to see the
    // negative is to answer this one read with it. kobai's own answer is fetched and the one
    // field changed, so everything else on the screen is still this deployment's.
    await page.route(
      (url) => url.pathname === "/admin/deployment",
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as DeploymentBody;
        await route.fulfill({
          response,
          json: { ...body, payments: { configured: false } },
        });
      },
    );
    await page.reload();

    // A screen that rendered the affirmative and nothing else would leave a Developer reading
    // an empty space as "still loading" — which is exactly the question they came to answer
    // before debugging a Cart (story 7).
    await shows(page.getByText("None wired"), "the deployment that takes no money");
    await hides(page.getByText("Configured"), "the affirmative answer");
    await auditAccessibility(page, "the Deployment screen with no Payment Provider");
  });

  it("renders the reads that are in flight rather than a blank screen", async () => {
    const page = await seam.signedIn("/developer/deployment");
    await shows(page.getByText("Fulfilment Strategies"), "the Deployment screen");

    // Held long enough for the state between "asking" and "answered" to be a thing a test can
    // see at all, exactly as the Products skeleton case does it.
    await page.route(
      (url) => url.pathname === "/admin/deployment",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue();
      },
    );
    await page.reload();

    const skeleton = page.getByRole("status", { name: "Reading the deployment" });
    await shows(skeleton, "the deployment skeleton");
    // Audited while it is up: a skeleton is a screen a Merchant looks at, and this is the only
    // place it exists.
    await auditAccessibility(page, "the Deployment screen while it is loading");
    await hides(skeleton, "the deployment skeleton");
    await shows(page.getByText("Core"), "the deployment, once it arrived");
  });

  it("renders a refused read where it was attempted, with the others still answered", async () => {
    // `deployment:read` and nothing else, which is the grant ADR-0080 describes: the whole
    // shape of the API and nothing in it. `GET /admin/fulfilment-strategies` is behind
    // `catalog:read` (ADR-0067), so composing three reads means this Role is refused one of
    // them — and the screen has to say which.
    const narrow = await seam.merchantOnARole(["deployment:read"]);
    const page = await seam.signedInAs(narrow, "/");

    // The front door is the head of the narrowed list, and for this Role that is this screen.
    await expect.poll(() => where(page)).toBe("/developer/deployment");

    await shows(
      page.getByText("The Fulfilment Strategies could not be read."),
      "the refusal, in the card the read was attempted for",
    );
    // Nothing predicted it — the read was made and kobai's 403 is what came back — and the two
    // reads that worked are still on screen beside it.
    await shows(page.getByText("Core"), "the deployment, which this Role may read");
    await shows(
      page.getByText("Migration sets"),
      "the migration sets, which need no Role",
    );
    await auditAccessibility(page, "the Deployment screen with one read refused");
  });

  it("renders a refusal in place of the deployment it could not read", async () => {
    const narrow = await seam.merchantOnARole(["catalog:read"]);
    // The section is hidden from this Role, which is an affordance and never a boundary
    // (ADR-0063) — the address still resolves, and what it must not do is render an empty
    // frame that looks like a screen still loading.
    const page = await seam.signedInAs(narrow, "/developer/deployment");

    await shows(
      page.getByText("This deployment could not be read."),
      "the refusal, where the deployment would have been",
    );
    await expect
      .poll(() => strategies(page))
      .toEqual(["digital", "made-to-order", "physical"]);
    await auditAccessibility(page, "the Deployment screen refused the deployment read");
  });
});

/**
 * The Playground, which browses this deployment's own description (#268, ADR-0080, ADR-0081).
 *
 * **The one screen whose data cannot be arranged and must not be written down.** Every other
 * case in this file seeds what it asserts on; this one asserts that a screen renders the
 * *whole* of a document only the running server has — so the expectation is read from
 * `GET /admin/openapi.json` over the API and compared against what the screen drew, which is
 * ADR-0049's rule about asking the side the assertion is not reading.
 *
 * The browsing half is #268's and the sending half is #269's, and they share one `describe`
 * because the second is composed out of what the first read: the operation, its parameters and
 * its body all come off the document the screen fetched. The nested `describe` at the foot is
 * where the sending lives, and it says why only a browser can ask what it asks.
 */
describe("the Playground", () => {
  /** As much of an OpenAPI document as a case here has any business knowing about. */
  type DescriptionBody = {
    readonly paths: Record<string, Record<string, unknown>>;
    readonly components: { readonly schemas: Record<string, Record<string, unknown>> };
  };

  /**
   * The methods an OpenAPI path item may carry an operation under.
   *
   * Written out rather than "every key of the path item", because a path item may also hold
   * `parameters`, `summary` and `$ref`, none of which is an operation. It is the same list the
   * screen reads by, and that is not a tautology: this file derives its expectation from the
   * **document the server served**, and what the screen derives from is the document it
   * fetched — so a screen that dropped an operation, or invented one, disagrees here.
   */
  const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

  /** One operation of the served document, as much of it as these cases read. */
  type DescribedOperation = { readonly key: string; readonly summary: string };

  /** Every operation the document carries, in the form the screen names them by. */
  function operationsIn(description: DescriptionBody): DescribedOperation[] {
    return Object.entries(description.paths).flatMap(([path, item]) =>
      METHODS.filter((method) => method in item).map((method) => ({
        key: `${method.toUpperCase()} ${path}`,
        summary: String((item[method] as { summary?: unknown }).summary ?? ""),
      })),
    );
  }

  /** The list of operations, which is the whole of what this ticket's screen offers. */
  function operationList(page: Page) {
    return page.getByRole("navigation", {
      name: "Every operation this deployment serves",
    });
  }

  /**
   * The operations on offer, in the order the screen drew them.
   *
   * Whitespace is collapsed because the method and the path are two elements inside the link,
   * laid out beside each other — what a case is asserting is which operations are listed, not
   * how the two halves of one are spaced.
   */
  async function shownOperations(page: Page): Promise<string[]> {
    const texts = await operationList(page).getByRole("link").allInnerTexts();
    return texts.map((text) => text.replace(/\s+/g, " ").trim());
  }

  /** The one control that narrows the list. */
  function searchBox(page: Page) {
    return page.getByRole("searchbox", { name: "Search the operations" });
  }

  /** The document's own account of one operation, which is what the screen is held to. */
  function operationAt(
    description: DescriptionBody,
    key: string,
  ): Record<string, unknown> {
    const [method = "", path = ""] = key.split(" ");
    const operation = description.paths[path]?.[method.toLowerCase()];
    if (operation === undefined) {
      throw new Error(`This deployment does not serve \`${key}\`.`);
    }
    return operation as Record<string, unknown>;
  }

  /** A schema, with a `$ref` followed — the one piece of OpenAPI these cases have to know. */
  function schemaOf(
    description: DescriptionBody,
    schema: unknown,
  ): Record<string, unknown> {
    const ref = (schema as { $ref?: unknown } | undefined)?.$ref;
    if (typeof ref !== "string") return (schema ?? {}) as Record<string, unknown>;
    return description.components.schemas[ref.replace("#/components/schemas/", "")] ?? {};
  }

  /** The `application/json` schema a response carries, resolved. */
  function bodySchemaOf(
    description: DescriptionBody,
    holder: unknown,
  ): Record<string, unknown> {
    const content = (holder as { content?: Record<string, { schema?: unknown }> })
      ?.content;
    return schemaOf(description, content?.["application/json"]?.schema);
  }

  it("lists every operation this deployment's own description carries", async () => {
    // Asked of the server rather than of `packages/core/openapi.json`: the whole point of
    // ADR-0080 is that the screen reads what *this process* serves, so an expectation taken
    // from a checked-in build artifact would agree with the description this deployment might
    // not be serving.
    const description = await seam.api<DescriptionBody>("GET", "/admin/openapi.json");
    const operations = operationsIn(description);
    // The emptiness guard and deliberately not a size: **never write down how big the admin
    // surface is** (#188, ADR-0049). What this stops is the one failure a derived expectation
    // has — two empty lists comparing equal — and a number would be one more place a route
    // added to Core has to be counted.
    expect(operations.length, "This deployment described no operations.").toBeGreaterThan(
      0,
    );

    const page = await seam.signedIn("/developer/playground");
    const list = operationList(page);

    await shows(list.getByRole("link").first(), "the operations this deployment serves");
    await expect.poll(() => list.getByRole("link").count()).toBe(operations.length);

    // Named one at a time rather than counted, because a count agrees with a screen that
    // listed the same operation fifty-seven times. Gathered into one array so a failure names
    // every operation that is missing rather than the first.
    const missing: string[] = [];
    for (const operation of operations) {
      const shown = await list
        .getByRole("link", { name: operation.key, exact: true })
        .count();
      if (shown !== 1) missing.push(`${operation.key} (${shown} entries)`);
    }
    expect(missing).toEqual([]);

    await auditAccessibility(page, "the Playground");
  });

  it("finds an operation by what was typed, in its path and in its summary", async () => {
    const described = operationsIn(
      await seam.api<DescriptionBody>("GET", "/admin/openapi.json"),
    );
    const page = await seam.signedIn("/developer/playground");
    await shows(
      operationList(page).getByRole("link").first(),
      "the operations this deployment serves",
    );

    // Derived from the served document, not written down: what the screen is being held to is
    // the description's own answer to "which operations carry this word".
    const byPath = described
      .filter((one) => one.key.toLowerCase().includes("reservations"))
      .map((one) => one.key);
    expect(byPath.length, "No operation's path carried the word.").toBeGreaterThan(0);

    await searchBox(page).fill("reservations");
    await expect.poll(() => shownOperations(page)).toEqual(byPath);

    // And by summary, which is the half a path cannot answer: nothing on this surface has
    // `sign` in its path, and the two operations that sign a Merchant in and out say so in
    // their summaries. A Developer who knows what they want and not where it lives is the
    // whole case for a search box over a list of fifty-seven.
    const bySummary = described
      .filter((one) => one.summary.toLowerCase().includes("sign"))
      .map((one) => one.key);
    expect(bySummary.length, "No operation's summary carried the word.").toBeGreaterThan(
      0,
    );
    expect(bySummary.some((key) => key.toLowerCase().includes("sign"))).toBe(false);

    await searchBox(page).fill("sign");
    await expect.poll(() => shownOperations(page)).toEqual(bySummary);

    // A search matching nothing says so, rather than leaving an empty panel that reads as a
    // list still loading — the same distinction every list in this Admin draws.
    await searchBox(page).fill("nothing-in-this-api-is-called-this");
    await shows(page.getByText("No operation matches"), "the empty search state");
    await expect.poll(() => shownOperations(page)).toEqual([]);
    await auditAccessibility(page, "the Playground with a search matching nothing");
  });

  /**
   * The operation these cases open, and the reason it is this one.
   *
   * It is the only shape on the surface that carries all four halves at once — a path
   * parameter, a request body, an answer with a body of its own, and refusals from three
   * different families — so one open operation exercises the whole of what this screen renders.
   */
  const AN_OPERATION = "POST /admin/products/{id}/variants";

  function addressOf(operation: string): string {
    return `/developer/playground?operation=${encodeURIComponent(operation)}`;
  }

  /**
   * The operation the address is naming, read the way a browser reads a query string.
   *
   * Read back rather than compared as text, because the two spellings of a space in a query
   * string — `%20` and `+` — are the same address, and what a case is asserting is which
   * operation the address names rather than which of them the screen wrote.
   */
  function chosenAt(page: Page): string | null {
    return new URL(page.url()).searchParams.get("operation");
  }

  it("shows what an operation takes, and every answer and refusal it declares", async () => {
    const description = await seam.api<DescriptionBody>("GET", "/admin/openapi.json");
    const operation = operationAt(description, AN_OPERATION);
    const responses = operation.responses as Record<string, { description: string }>;

    const page = await seam.signedIn(addressOf(AN_OPERATION));
    await shows(
      page.getByRole("heading", { name: AN_OPERATION, level: 2 }),
      "the operation the address named",
    );

    // Every clause below is read off the served document. What is being asserted is that the
    // screen renders *the deployment's own answer*, so an expectation written down here would
    // be a second description that can disagree with the first (ADR-0049).
    await shows(page.getByText(String(operation.summary)), "what the operation does");

    // **The parameters, as the document declares them.** #269 turns each of these into a form
    // field; this ticket has to say what they are.
    const parameters = page.getByRole("region", { name: "Parameters" });
    const declared = operation.parameters as { name: string; description: string }[];
    expect(declared.length, "The operation declared no parameters.").toBeGreaterThan(0);
    for (const parameter of declared) {
      await shows(
        parameters.getByText(parameter.name, { exact: true }).first(),
        `the ${parameter.name} parameter`,
      );
      await shows(
        parameters.getByText(parameter.description).first(),
        `what the ${parameter.name} parameter is`,
      );
    }

    // **The request body**, down to the field names — which is what a Developer needs before
    // they send anything, and the thing that cannot be read anywhere else in this Admin.
    const body = page.getByRole("region", { name: "Request body" });
    const fields = Object.keys(
      bodySchemaOf(description, operation.requestBody).properties as object,
    );
    expect(fields.length, "The request body declared no fields.").toBeGreaterThan(0);
    for (const field of fields) {
      await shows(body.getByText(field, { exact: true }).first(), `the ${field} field`);
    }

    // **Every response it declares**, split by what a caller does about it: an answer is a
    // shape to read, a refusal is a rule to handle. Both are asserted exhaustively, because
    // "some of the responses" is what a screen that dropped the awkward ones would show.
    const answers = page.getByRole("region", { name: "Answers" });
    const refusals = page.getByRole("region", { name: "Refusals" });
    for (const [status, response] of Object.entries(responses)) {
      const region = Number(status) < 400 ? answers : refusals;
      await shows(
        region.getByText(status, { exact: true }).first(),
        `the ${status} response`,
      );
      await shows(
        region.getByText(response.description).first(),
        `what the ${status} response means`,
      );
    }

    // **And the `reason` each refusal carries** (story 12) — the part a storefront Developer
    // meets in production and can read nowhere today. The words come off the refusal families
    // the document declares, so a family gaining a reason in Core appears here by itself.
    const reasons = new Set<string>();
    for (const [status, response] of Object.entries(responses)) {
      if (Number(status) < 400) continue;
      const schema = bodySchemaOf(description, response);
      const reason = (
        schema.properties as Record<string, { enum?: string[] }> | undefined
      )?.reason;
      for (const word of reason?.enum ?? []) reasons.add(word);
    }
    expect(
      reasons.size,
      "No refusal this operation makes declared a reason.",
    ).toBeGreaterThan(0);
    for (const word of reasons) {
      await shows(
        refusals.getByText(word, { exact: true }).first(),
        `the ${word} refusal`,
      );
    }

    // Audited with the operation open, which is the most structurally complex document this
    // Admin renders — a schema tree, three regions of tables and a list of refusal words.
    await auditAccessibility(page, "the Playground with an operation open");
  });

  it("keeps the chosen operation in the address, across a refresh and the back button", async () => {
    const page = await seam.signedIn("/developer/playground");
    const chosen = page.getByRole("heading", { name: AN_OPERATION, level: 2 });
    await shows(
      operationList(page).getByRole("link").first(),
      "the operations this deployment serves",
    );
    await hides(chosen, "an operation nobody has chosen");

    await operationList(page)
      .getByRole("link", { name: AN_OPERATION, exact: true })
      .click();
    await shows(chosen, "the operation that was chosen");
    // The address is what a Developer sends a colleague, and #269 puts the parameters and the
    // body in the same place — so the operation living there is the frame's promise rather
    // than a convenience (ADR-0081).
    expect(chosenAt(page)).toBe(AN_OPERATION);
    expect(where(page).startsWith("/developer/playground?")).toBe(true);

    await page.reload();
    await shows(chosen, "the operation, after a refresh landed back on it");

    await page.goBack();
    await hides(chosen, "the operation, after the back button left it");
    expect(where(page)).toBe("/developer/playground");

    await page.goForward();
    await shows(chosen, "the operation, after the forward button returned to it");
    expect(chosenAt(page)).toBe(AN_OPERATION);
  });

  it("says so when the address names an operation this deployment does not serve", async () => {
    // Not a contrived state: a link is composed against the surface the *sender* is running,
    // and a Project upgrading Core is exactly when the two differ. A blank panel would read as
    // a screen still loading, which is the distinction every list in this Admin draws.
    const page = await seam.signedIn(addressOf("POST /admin/nothing-here"));

    await shows(
      page.getByText("No such operation"),
      "the operation kobai does not serve",
    );
    await shows(
      operationList(page).getByRole("link").first(),
      "the operations, still offered beside it",
    );
    expect(chosenAt(page)).toBe("POST /admin/nothing-here");
    await auditAccessibility(page, "the Playground on an operation that is not served");
  });

  it("says it is reading the description rather than showing an empty list", async () => {
    const page = await seam.signedIn("/developer/playground");
    await shows(
      operationList(page).getByRole("link").first(),
      "the operations this deployment serves",
    );

    // Held long enough for the state between "asking" and "answered" to be a thing a test can
    // see at all — the description is the largest thing this Admin fetches, so the state is
    // real rather than theoretical. Nothing about kobai's answer is changed.
    await page.route(
      (url) => url.pathname === "/admin/openapi.json",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue();
      },
    );
    await page.reload();

    const reading = page.getByRole("status", { name: "Reading the description" });
    await shows(reading, "the description skeleton");
    await auditAccessibility(page, "the Playground while it is reading the description");
    await hides(reading, "the description skeleton");
    await shows(
      operationList(page).getByRole("link").first(),
      "the operations, once the description arrived",
    );
  });

  it("says the description could not be read, rather than listing nothing", async () => {
    const page = await seam.signedIn("/developer/playground");
    await shows(
      operationList(page).getByRole("link").first(),
      "the operations this deployment serves",
    );

    // **The one place this file answers a route with something other than what kobai said**,
    // and the argument the harness asks for: the network being gone is not a state any request
    // can arrange, and it is the state the screen's fallback — "kobai did not answer." — was
    // written for. The *refused* read is a request-level question and is asserted where those
    // belong: `deployment:read` gates this route in Core, and a Role without it meets a 403 at
    // the HTTP seam. What only a browser can say is that the screen renders the failure where
    // the operations would have been instead of an empty list that reads as one still loading.
    await page.route(
      (url) => url.pathname === "/admin/openapi.json",
      async (route) => {
        await route.abort();
      },
    );
    await page.reload();

    await shows(
      page.getByText("This deployment's description could not be read."),
      "the failure, where the operations would have been",
    );
    await auditAccessibility(page, "the Playground that could not read the description");
  });

  it("asks kobai for nothing but the description, however much is browsed", async () => {
    const page = await seam.signedIn("/developer/playground");
    await shows(
      operationList(page).getByRole("link").first(),
      "the operations this deployment serves",
    );

    // **The claim the browsing half rests on, and only a browser can ask it.** The Playground
    // is a real client of the real API with a real cookie jar and, since #269, one that can
    // reach anything — so a screen that browsed the Cart operations and quietly started one
    // would be indistinguishable from this one on every other seam in this repository.
    // Sending happens when the send control is pressed and at no other moment, which is what
    // this case is now about: reading fifty-seven operations costs one read.
    const kobai: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (/^\/(admin|store|health)(\/|$)/.test(pathname)) {
        kobai.push(`${request.method()} ${pathname}`);
      }
    });
    const writes = watchForWrites(page);

    // Reloaded under the listener, so the description read is *on* the list rather than
    // cached out of sight of it: an assertion that a list holds nothing but two known entries
    // is worth something only when it is watching a load that really made them.
    await page.reload();
    await shows(
      operationList(page).getByRole("link").first(),
      "the operations, on a load this case is watching",
    );

    await operationList(page)
      .getByRole("link", { name: AN_OPERATION, exact: true })
      .click();
    await shows(
      page.getByRole("heading", { name: AN_OPERATION, level: 2 }),
      "the operation that was chosen",
    );
    await searchBox(page).fill("orders");
    await operationList(page)
      .getByRole("link", { name: "POST /store/orders", exact: true })
      .click();
    await shows(
      page.getByRole("heading", { name: "POST /store/orders", level: 2 }),
      "the operation that places an Order",
    );

    expect(await writes.settled()).toEqual([]);
    // Two reads and no others. `GET /admin/session` is the **frame's**, re-read on navigation
    // so a Role edited elsewhere reaches this tab (#178) and asserted here because a list
    // holding neither would satisfy an emptiness check while proving nothing; the description
    // is the screen's, and it is the whole of what this screen asks kobai for.
    expect([...new Set(kobai)].sort()).toEqual([
      "GET /admin/openapi.json",
      "GET /admin/session",
    ]);
  });

  it("reaches the search box and an operation with the keyboard alone", async () => {
    const page = await seam.signedIn("/developer/playground");
    await shows(
      operationList(page).getByRole("link").first(),
      "the operations this deployment serves",
    );

    // None of this is visible to a scanner, and a list of fifty-seven links is exactly where a
    // Developer without a mouse pays for a screen that was only ever clicked through.
    await tabTo(page, searchBox(page), "the search box");
    await page.keyboard.type("reservations");

    const remaining = operationList(page).getByRole("link").first();
    await tabTo(page, remaining, "the operation the search left");
    const chosen = (await remaining.innerText()).replace(/\s+/g, " ").trim();
    await page.keyboard.press("Enter");

    await shows(
      page.getByRole("heading", { name: chosen, level: 2 }),
      "the operation opened with the keyboard",
    );
    expect(chosenAt(page)).toBe(chosen);
  });

  /**
   * Sending a real request, on a credential chosen on the screen (#269, ADR-0081).
   *
   * **Everything here is a promise nothing else in this repository can ask about**, and the
   * reason is one line of ADR-0081: `credentials: "omit"`. The `kobai_session` cookie names no
   * `Path`, so a browser files it under `/admin` and attaches it to every request to that
   * subtree — *whatever page sent it, and whatever `Authorization` header the sender also set*
   * (ADR-0032). A request-level test has no ambient cookie to suppress, so it cannot tell a
   * screen that omits one from a screen that does not; a real Chromium with a real cookie jar
   * is the only place the difference exists at all.
   */
  describe("sending a request", () => {
    /** The card that composes and sends, named by its own heading. */
    function sendPanel(page: Page) {
      return page.getByRole("region", { name: "Send", exact: true });
    }

    /** One of the three credentials, which are links because each of them is an address. */
    function credential(page: Page, name: string) {
      return page
        .getByRole("navigation", { name: "Choose a credential" })
        .getByRole("link", { name, exact: true });
    }

    function sendButton(page: Page) {
      return page.getByRole("button", { name: "Send the request", exact: true });
    }

    /** What kobai answered, once something has been sent. */
    function answer(page: Page) {
      return page.getByRole("region", { name: "The response", exact: true });
    }

    /** Waits until the address really has put that credential in force. */
    async function inForce(page: Page, name: string): Promise<void> {
      await expect
        .poll(() => credential(page, name).getAttribute("aria-current"))
        .toBe("page");
    }

    /**
     * The write these cases send, and it is the ticket's own example of the stakes.
     *
     * **A deletion sent from here deletes**, so each case creates the Product it deletes rather
     * than reaching for the shared catalog — and the one that is *refused* asks kobai afterwards
     * whether the Product is still there, which is the difference between a request that was
     * turned back and one that was never sent.
     */
    const A_WRITE = "DELETE /admin/products/{id}";

    it("refuses a publishable key at an admin route, because the cookie is omitted", async () => {
      // **The single most important assertion in this ticket, and it has been watched
      // failing.** With the request seam's one `credentials` line pinned to `"same-origin"`,
      // this comes back **200 and a list of Products** — the browser attaching the Merchant's
      // session to a request that selected a publishable key — and a Developer learns that a
      // `kobai_pk_…` opens the admin surface. It does not. Nothing smaller than a real cookie
      // jar can tell those two screens apart, which is why this case is here and not at the
      // HTTP seam.
      const page = await seam.signedIn(addressOf("GET /admin/products"));
      await shows(sendPanel(page), "the panel that sends the request");

      // Said before anything is sent rather than discovered by deleting a Product.
      await shows(
        page.getByText("There is no sandbox. Every request here is real."),
        "the statement that these requests are real",
      );

      await credential(page, "A publishable key").click();
      await sendButton(page).click();

      await shows(answer(page), "kobai's answer");
      await shows(answer(page).getByText("401", { exact: true }), "the refused status");
      await shows(
        answer(page).getByText("session-missing", { exact: true }),
        "the reason the admin gate turned it back",
      );
      // The refusal renders as a refusal and not as an error state, so the prose kobai wrote
      // is on screen beside the word a storefront would branch on.
      await shows(answer(page).getByText(/\d+ ms/), "how long the request took");

      // Audited **with a response rendered**, which is a different document from the empty
      // one: a status, a reason and a body kobai sent are three things nothing else on this
      // screen draws.
      await auditAccessibility(page, "the Playground with a response rendered");
    });

    it("answers a store request on a publishable key exactly as a storefront would", async () => {
      const product = await seam.createProduct({
        title: `A poster the Playground prices ${Date.now()}`,
        amount: 1250,
      });
      // Published, because the store surface answers no draft (#252) — arrangement through the
      // API like everything else this seam sets up.
      await seam.api("PATCH", `/admin/products/${product.id}`, {
        status: "published",
      });

      const page = await seam.signedIn(addressOf("GET /store/variants/{id}/price"));
      await shows(sendPanel(page), "the panel that sends the request");
      await credential(page, "A publishable key").click();
      // Waited for rather than assumed: the credential is an address like everything else on
      // this screen, so what is in force is what the links say is in force.
      await inForce(page, "A publishable key");

      // A path parameter, as a real form field built from the description.
      await page
        .getByRole("textbox", { name: "id", exact: true })
        .fill(product.variantId);
      await sendButton(page).click();
      await shows(answer(page).getByText("200", { exact: true }), "the answered status");
      // This Project replaces `select-price` with `everything-costs-one-cent`, so what a
      // storefront receives here is one cent rather than the 1250 a Merchant entered — which is
      // the whole reason the fidelity matters. Asserted on the body kobai sent rather than on a
      // number this case computed.
      await shows(
        answer(page).getByText(/"amount": 1\b/),
        "the price a storefront would be told",
      );

      // **The same key, at an operation it may not perform, and it is offered rather than
      // hidden** (ADR-0055): nothing here predicts a refusal, so `POST /store/orders` is on the
      // list like everything else and comes back `secret-key-required`.
      await operationList(page)
        .getByRole("link", { name: "POST /store/orders", exact: true })
        .click();
      await shows(
        page.getByRole("heading", { name: "POST /store/orders", level: 2 }),
        "the operation that places an Order",
      );
      // The credential travelled with the operation — it is who the Developer decided to be,
      // rather than something belonging to the route they were reading.
      await inForce(page, "A publishable key");

      await sendButton(page).click();
      await shows(answer(page).getByText("403", { exact: true }), "the refused status");
      await shows(
        answer(page).getByText("secret-key-required", { exact: true }),
        "the reason a browser's key cannot place an Order",
      );
    });

    it("sends on a secret key that is never written to the address or to storage", async () => {
      const minted = await seam.api<{ key: string }>("POST", "/admin/api-keys", {
        name: `the Playground's secret ${Date.now()}`,
        kind: "secret",
      });

      const page = await seam.signedIn(addressOf("GET /store/products"));
      await shows(sendPanel(page), "the panel that sends the request");
      await credential(page, "A secret key").click();

      const field = page.getByRole("textbox", { name: "Secret key", exact: true });
      await field.fill(minted.key);
      await sendButton(page).click();
      await shows(answer(page).getByText("200", { exact: true }), "the answered status");

      // **Never in the address**, which is where the rest of the composed request lives: a
      // secret key there is a secret key in a browser history, a proxy log, and whatever the
      // colleague it was sent to does next.
      expect(page.url()).not.toContain(minted.key);
      // **And never written down.** Asked of both stores whole rather than of a named key,
      // because an assertion about one name passes against a screen that used another.
      expect(await storedInTheBrowser(page)).not.toContain(minted.key);

      // And a **non-`GET`** on it needs no arming either, which is the other half of the rule
      // the case below asserts for a publishable key: the guard sits on the credential nobody
      // had to type, and a key that was pasted is a deliberate act every time.
      await operationList(page).getByRole("link", { name: A_WRITE, exact: true }).click();
      await shows(
        page.getByRole("heading", { name: A_WRITE, level: 2 }),
        "a write, on the key that was pasted",
      );
      await hides(
        page.getByRole("button", { name: "Arm the Playground" }),
        "the arming control, on a secret key that was typed rather than inherited",
      );
      await expect.poll(() => sendButton(page).getAttribute("aria-disabled")).toBe(null);

      // Gone on reload, which is the reload teaching the distinction rather than hiding it:
      // the publishable key survives because it always did, and this one does not.
      await page.reload();
      await shows(sendPanel(page), "the panel, after the reload");
      await expect.poll(() => field.inputValue()).toBe("");
    });

    it("will not send a write on the Session until it has been armed", async () => {
      const doomed = await seam.createProduct({
        title: `A Product the armed Playground deletes ${Date.now()}`,
      });
      const page = await seam.signedIn(addressOf(A_WRITE));
      await shows(sendPanel(page), "the panel that sends the request");
      await page.getByRole("textbox", { name: "id", exact: true }).fill(doomed.id);

      // Unavailable rather than absent, and `aria-disabled` rather than `disabled`, so it can
      // still be reached and told why (ADR-0063). Arming is an affordance and never a
      // boundary — Core is what enforces — and the sentence at the control says so.
      const armed = watchForWrites(page);
      await expect
        .poll(() => sendButton(page).getAttribute("aria-disabled"))
        .toBe("true");
      // Forced past Playwright's own refusal to click something `aria-disabled`, because a
      // browser has no such refusal: `aria-disabled` does not prevent activation, which is
      // exactly why the handler has to genuinely no-op.
      await sendButton(page).click({ force: true });
      expect(await armed.settled()).toEqual([]);

      await auditAccessibility(page, "the Playground before it has been armed");

      await page.getByRole("button", { name: "Arm the Playground" }).click();
      await sendButton(page).click();
      await shows(answer(page).getByText("204", { exact: true }), "the answered status");
      // There is no sandbox, and this is what that means: the Product is gone.
      await expect(seam.api("GET", `/admin/products/${doomed.id}`)).rejects.toThrowError(
        /404/,
      );

      // **Arming lasts the session**, so a Developer who refreshed to re-read a description has
      // not changed their mind. It survives the reload because it is not this screen's state.
      await page.reload();
      await shows(sendPanel(page), "the panel, after the reload");
      await hides(
        page.getByRole("button", { name: "Arm the Playground" }),
        "the arming control, on a session that has already armed",
      );
      await expect.poll(() => sendButton(page).getAttribute("aria-disabled")).toBe(null);
    });

    it("needs no arming for a write on a credential the Developer chose", async () => {
      // The guard sits on the ambient credential and on nothing else: a key is a deliberate act
      // every time, and ceremony around the safe case is how it gets removed from the dangerous
      // one. Nothing has armed this browser context — each case gets its own.
      const spared = await seam.createProduct({
        title: `A Product the Playground may not delete ${Date.now()}`,
      });
      const page = await seam.signedIn(addressOf(A_WRITE));
      await shows(sendPanel(page), "the panel that sends the request");
      await credential(page, "A publishable key").click();
      await inForce(page, "A publishable key");
      await page.getByRole("textbox", { name: "id", exact: true }).fill(spared.id);

      await hides(
        page.getByRole("button", { name: "Arm the Playground" }),
        "the arming control, on a credential that was typed rather than inherited",
      );
      await sendButton(page).click();
      // Refused because the cookie was suppressed, which is the point twice over — what this
      // case is about is that it was *sent* with nothing asked of the Developer first, and the
      // Product it names is still there because kobai turned the request back.
      await shows(answer(page).getByText("401", { exact: true }), "the refused status");
      await expect(
        seam.api("GET", `/admin/products/${spared.id}`),
      ).resolves.toBeDefined();
    });

    it("keeps the composed request — parameters and body — in the address", async () => {
      const page = await seam.signedIn("/developer/playground");
      await shows(
        operationList(page).getByRole("link").first(),
        "the operations this deployment serves",
      );
      await operationList(page)
        .getByRole("link", { name: AN_OPERATION, exact: true })
        .click();

      const parameter = page.getByRole("textbox", { name: "id", exact: true });
      const body = page.getByRole("textbox", { name: "Request body", exact: true });
      // Seeded from the request schema rather than left empty, so a Developer starts from
      // something shaped right — and nothing here checks what they do to it.
      await expect.poll(() => body.inputValue()).toContain('"sku"');

      // **Typed a character at a time rather than filled**, because these fields are held in
      // the *address*: every keystroke is a navigation, and a field that lost the keyboard or
      // reordered what was typed would still pass a `fill`, which sets the value in one go.
      await parameter.click();
      await page.keyboard.type("a-product-somebody-was-looking-at");

      await body.fill('{ "sku": "TYPED-BY-HAND" }');

      const composed = () => new URL(page.url()).searchParams;
      await expect
        .poll(() => composed().get("path.id"))
        .toBe("a-product-somebody-was-looking-at");
      await expect.poll(() => composed().get("body")).toBe('{ "sku": "TYPED-BY-HAND" }');

      // A refresh lands back on the whole of it, which is what makes an address worth sending
      // to a colleague as the call that reproduces a problem.
      await page.reload();
      await shows(sendPanel(page), "the panel, after the refresh");
      await expect
        .poll(() => parameter.inputValue())
        .toBe("a-product-somebody-was-looking-at");
      await expect.poll(() => body.inputValue()).toBe('{ "sku": "TYPED-BY-HAND" }');

      // And the back button still leaves the operation rather than walking a history entry per
      // keystroke: every edit above replaced the entry the operation was chosen on, so there is
      // one entry to leave and not thirty.
      await page.goBack();
      await expect.poll(() => where(page)).toBe("/developer/playground");

      // Forward returns to the whole composed request and not merely to the operation, which is
      // the half a `replace` could have quietly lost.
      await page.goForward();
      await shows(sendPanel(page), "the panel, after the forward button returned to it");
      await expect
        .poll(() => parameter.inputValue())
        .toBe("a-product-somebody-was-looking-at");
      await expect.poll(() => body.inputValue()).toBe('{ "sku": "TYPED-BY-HAND" }');
    });

    it("lists the two session operations and offers neither a way to send", async () => {
      // The one exception to offering everything, and the difference is exact: Core would not
      // refuse these, it would **obey** them. They are still listed, because reading what
      // `POST /admin/session` takes costs nobody their tab — what they get is no send control
      // **and a sentence saying why**, since an operation that silently lacked a button would
      // teach a Developer nothing at all (ADR-0081, as #268 amended it).
      const page = await seam.signedIn(addressOf("DELETE /admin/session"));
      await shows(sendPanel(page), "the panel that would have sent the request");

      await shows(
        page.getByText("This one is not offered to send."),
        "the reason this operation has no send control",
      );
      await shows(
        page.getByText("would sign you out of the tab you are standing in"),
        "what sending it would do",
      );
      await hides(sendButton(page), "a send control on an operation that has none");

      // Listed, and read in full: the refusals and the answers are still there to browse.
      await shows(
        operationList(page).getByRole("link", {
          name: "DELETE /admin/session",
          exact: true,
        }),
        "the operation, still on the list",
      );
      await auditAccessibility(page, "the Playground on an operation it will not send");

      await operationList(page)
        .getByRole("link", { name: "POST /admin/session", exact: true })
        .click();
      await shows(
        page.getByText("would become whoever the body named"),
        "what sending the other one would do",
      );
      await hides(
        sendButton(page),
        "a send control on the other operation that has none",
      );
    });

    it("reaches the credential and the send control with the keyboard alone", async () => {
      const page = await seam.signedIn(addressOf("GET /admin/products"));
      await shows(sendPanel(page), "the panel that sends the request");

      // None of this is visible to a scanner, and this screen's send control is the last thing
      // on a long page — which is exactly where a keyboard-only Developer pays for a screen
      // that was only ever clicked through.
      await keyboardTo(
        page,
        "Tab",
        credential(page, "A publishable key"),
        "the publishable credential",
        200,
      );
      await page.keyboard.press("Enter");
      await expect
        .poll(() => credential(page, "A publishable key").getAttribute("aria-current"))
        .toBe("page");

      await keyboardTo(page, "Tab", sendButton(page), "the send control", 200);
      await page.keyboard.press("Enter");
      await shows(answer(page).getByText("401", { exact: true }), "the refused status");
    });
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
   *
   * **Two cases, and which surface each one used is the subject of both** (#276). A storefront
   * cannot ask about a Product that is not published, so the Admin asks over `/store` when a
   * storefront could and over `/admin` when none could — and that choice is a request rather
   * than a rendering, which is why it is asserted here.
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

    // The criterion itself (ADR-0020): for a Product a storefront can see, the Admin found out
    // what one receives by *being* one — over `/store`, with a `kobai_pk_` key — rather than by
    // asking the admin surface for a number a storefront could have asked for itself.
    expect(asked).toEqual([
      {
        path: `/store/variants/${product.variantId}/price`,
        authorization: expect.stringMatching(/^Bearer kobai_pk_/),
      },
    ]);

    await auditAccessibility(page, "the Product screen showing a resolved price");
  });

  /**
   * The other half, and the reason #276 could close the store surface without closing this
   * screen.
   *
   * A draft is invisible to a storefront — including at `GET /store/variants/{id}/price`, as of
   * that ticket — so *being* a storefront answers `variant-not-found` for the very Product a
   * Merchant is most likely to be previewing: the one they have not put on sale yet. The Admin
   * therefore asks over `/admin`, which runs the same `resolve-price` and answers the same body.
   *
   * **The assertion is that it made no store request at all**, which is the half nothing else in
   * this repository can see: a screen that asked `/store` first and quietly fell back would look
   * identical on screen and would be papering over real refusals on Products that *are* on sale.
   */
  it("asks over the admin surface for a Product no storefront may see", async () => {
    const product = await seam.createProduct({
      title: "A poster still being written",
      amount: 1250,
      status: "draft",
    });
    const page = await seam.signedIn(`/products/${product.id}`);

    const asked: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/store/")) asked.push(pathname);
    });

    await page.getByRole("button", { name: "What would a storefront receive?" }).click();

    await shows(
      page.getByText("This Project changed the price."),
      "the difference between what was entered and what a storefront would get",
    );
    await shows(
      page.getByText("This Product is not published, so no storefront can ask at all."),
      "which surface the Admin had to ask, and why",
    );

    expect(asked).toEqual([]);

    await auditAccessibility(page, "the Product screen previewing a draft's price");
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
  const CART_READ = "cart:read";
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
    // teaches nothing — so they are absent rather than present and dead (ADR-0063). Media and
    // Collections are here because both are catalog data behind `catalog:read` (ADR-0015,
    // ADR-0074): the three are what this Role can read, and a section list that named only one
    // of them would be hiding a section this Merchant may open.
    await expect.poll(() => sections(page)).toEqual(["Products", "Media", "Collections"]);

    // The palette reads the same list, which is the whole reason `lib/sections.ts` is a module:
    // two navigation affordances over one list cannot disagree about what this Admin has.
    await page.keyboard.press("Meta+k");
    await shows(
      page.getByRole("combobox", { name: "Search sections" }),
      "the command palette",
    );
    await expect
      .poll(() => page.getByRole("option").allInnerTexts())
      .toEqual(["Products", "Media", "Collections"]);

    await auditAccessibility(page, "the Admin's palette on a narrow Role");
  });

  /**
   * The Carts section, hidden and offered — the affordance ADR-0071 asks for by name.
   *
   * Both directions in one case, because either alone proves half of it: a section absent for
   * everybody would satisfy the first, and a section shown to everybody would satisfy the
   * second. `cart:read` is its own Permission precisely so that it can be granted on its own —
   * reusing `order:read` was considered and rejected, since a Cart and an Order are governed by
   * opposite rules — and the Role holding **only** it is what shows that.
   *
   * It is an affordance and never a boundary: `requirePermission` in Core is what actually
   * refuses `GET /admin/carts`, and `admin-carts.test.ts` is where that is asserted.
   */
  it("hides Carts from a Role without cart:read, and offers it to one that holds only it", async () => {
    const without = await seam.merchantOnARole([ORDER_READ]);
    const blind = await seam.signedInAs(without, "/orders");
    await shows(blind.getByText("Every Order this Store has taken"), "the Orders screen");

    await expect.poll(() => sections(blind)).toEqual(["Orders"]);
    await blind.keyboard.press("Meta+k");
    await shows(
      blind.getByRole("combobox", { name: "Search sections" }),
      "the command palette",
    );
    await expect
      .poll(() => blind.getByRole("option").allInnerTexts())
      .toEqual(["Orders"]);

    const holder = await seam.merchantOnARole([CART_READ]);
    const seeing = await seam.signedInAs(holder, "/");

    // The front door is the head of the same list, so a Role holding nothing but this one
    // lands on the Carts rather than on a Products screen it would be refused.
    await expect.poll(() => where(seeing)).toBe("/carts");
    await expect.poll(() => sections(seeing)).toEqual(["Carts"]);
    await seeing.keyboard.press("Meta+k");
    await shows(
      seeing.getByRole("combobox", { name: "Search sections" }),
      "the command palette",
    );
    await expect
      .poll(() => seeing.getByRole("option").allInnerTexts())
      .toEqual(["Carts"]);
    await auditAccessibility(
      seeing,
      "the palette on a Role that may read only the Carts",
    );
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
    const page = await seam.signedInAs(narrow, "/developer/api-keys");
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
    // Media is beside Products because both are behind `catalog:read` (ADR-0015).
    await expect
      .poll(() => sections(page))
      .toEqual(["Products", "Media", "Collections", "Orders"]);

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
    await expect
      .poll(() => sections(page))
      .toEqual(["Products", "Media", "Collections", "Orders", "API keys"]);

    // And back the other way, which is the direction that actually takes an offer away — a
    // frame that only ever grew would be wrong in the one case a Merchant is *meant* to stop
    // being able to reach something.
    await seam.api("PATCH", `/admin/roles/${narrow.roleId}`, {
      permissions: [CATALOG_READ],
    });
    await page.getByRole("link", { name: "Products" }).click();
    await expect.poll(() => sections(page)).toEqual(["Products", "Media", "Collections"]);
  });

  it("takes a Role edited elsewhere when the window is focused, with no navigation", async () => {
    const narrow = await seam.merchantOnARole([CATALOG_READ]);
    const page = await seam.signedInAs(narrow, "/products");
    await expect.poll(() => sections(page)).toEqual(["Products", "Media", "Collections"]);

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
    await expect
      .poll(() => sections(page))
      .toEqual(["Products", "Media", "Collections", "Orders"]);
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
    await page.getByRole("button", { name: "Save Product" }).click();

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

  it("offers a Price the Store's currencies, named, beside a default that is not one", async () => {
    // The third of #300's currency pickers, and the one with something in its list that is not a
    // currency at all. The other two are asserted with the Store and Region screens; what is
    // only true here is that `This Store's default` sits at the head of a named list without
    // being turned into a code — and that typing a code narrows past it, since a Merchant
    // reaching for `JPY` is not reaching for the default.
    // A second currency of its own, rather than one the settings cases happen to have enabled
    // by the time this runs — they are in a `describe` below this one.
    const enabled = await alsoPricingIn("JPY");
    const product = await seam.createProduct({
      title: `A poster to price ${Date.now()}`,
      amount: 1250,
    });
    const page = await openAProduct(product);

    const picker = page.getByRole("combobox", { name: "Currency" });
    await shows(picker, "the Price editor's currency picker");
    await picker.click();

    // The Store's enabled set and the one choice that is not in it — which is what a Merchant
    // says when they mean "whatever this Store prices in" (ADR-0074), so it is a row rather than
    // an empty field.
    await expect
      .poll(async () => (await currencyCodesOffered(page)).sort())
      .toEqual(["This", ...enabled].sort());
    await shows(
      page.getByRole("option", { name: "This Store's default", exact: true }),
      "the choice that is not a currency, in its own words",
    );
    await shows(
      page.getByRole("option", { name: /^JPY — .+/ }),
      "an enabled currency, named as the Region screens name it",
    );
    await auditAccessibility(page, "the Product screen with the currency list open");

    // Narrowed to the codes, the default filtered out with everything else — it is not a
    // currency, and `JPY` is not what it is called.
    await currencySearch(page).fill("JPY");
    await expect.poll(() => currencyCodesOffered(page)).toEqual(["JPY"]);
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

    // And nothing was deleted, which is the other half of "it was refused" — the one Variant
    // it had, still the one it has. Named rather than left as `[{}]`, which asserted only
    // the length of the list and nothing whatever about what survived (#186).
    await expect(
      seam.api<{ variants: { id: string }[] }>("GET", `/admin/products/${product.id}`),
    ).resolves.toMatchObject({ variants: [{ id: product.variantId }] });
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
 * The Collections screens, and the one promise about them a request cannot ask (#256).
 *
 * Everything a Merchant does *to* a Collection is asserted through the API, in
 * `packages/core/src/catalog/collection.test.ts` — created, renamed, deleted, and what deleting
 * one leaves behind. Two things are here instead, and neither is screen behaviour:
 *
 * - **The two new screens are audited**, which is what makes `axe-core` cover them at all: it
 *   runs on every screen a case visits, so a section nothing visits is a section nothing checks.
 * - **The Products list keeps its status narrowing when a Collection is chosen**, which is a
 *   fact about an address rather than about a table. It is also the only change this ticket made
 *   to a component two other screens already use, and the failure it guards is invisible: two
 *   filters that each clear the other look exactly like two filters that work, one click at a
 *   time (`components/list-filter.tsx`).
 *
 * **The second was watched failing** against the `ListFilter` as #252 left it — a `to` built from
 * this parameter alone — and it reddens naming the status that was cleared, which is what says
 * the case reaches the thing it is about.
 */
describe("the Collections screens", () => {
  it("makes a Collection, opens it, and reaches its Products from it", async () => {
    const named = `Summer ${Date.now()}`;
    const page = await seam.signedIn("/collections");
    await shows(
      page.getByRole("heading", { name: "Collections" }),
      "the Collections list",
    );
    await auditAccessibility(page, "the Collections list");

    await page.getByLabel("Title").fill(named);
    await page.getByRole("button", { name: "Create Collection" }).click();

    // Read back off kobai rather than patched in: there is no optimistic update anywhere in
    // this Admin (ADR-0063), so the row appearing is the list having been re-read.
    const row = page.getByRole("row").filter({ hasText: named });
    await shows(row, "the new Collection's row");

    await row.getByRole("link", { name: "Open" }).click();
    await shows(
      page.getByRole("heading", { level: 2, name: named }),
      "the Collection's title",
    );
    await auditAccessibility(page, "the Collection screen");

    // The one navigation this screen owes, and the reason there is no second paged list on it:
    // what is in a Collection is the Products list narrowed to it, cursor and all.
    await page.getByRole("link", { name: "See its Products" }).click();
    await expect
      .poll(() => where(page), {
        timeout: LOCATOR_TIMEOUT,
        message: "The Collection screen did not reach its Products.",
      })
      .toMatch(/^\/products\?collection=/);
    await auditAccessibility(page, "the Products list narrowed to one Collection");
  });

  it("keeps the status narrowing when a Collection is chosen, and the other way round", async () => {
    const named = `Autumn ${Date.now()}`;
    await seam.api("POST", "/admin/collections", { title: named });

    const page = await seam.signedIn("/products?status=published");

    // Both navs are drawn, and choosing from the second must not undo the first — a cursor is
    // dropped when either moves, and nothing else is.
    await page.getByRole("link", { name: named }).click();
    await expect
      .poll(() => new URLSearchParams(where(page).split("?")[1] ?? "").get("status"), {
        timeout: LOCATOR_TIMEOUT,
        message: "Choosing a Collection cleared the status the Merchant was already on.",
      })
      .toBe("published");

    // And back the other way, because a rule kept in one direction and not the other is the
    // same bug with one of its two symptoms fixed.
    await page.getByRole("link", { name: "Draft", exact: true }).click();
    const search = new URLSearchParams(where(page).split("?")[1] ?? "");
    expect(search.get("status")).toBe("draft");
    expect(
      search.get("collection"),
      "Choosing a status cleared the Collection the Merchant was already in.",
    ).toEqual(expect.any(String));
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
/**
 * The Media screen, and the two things about it no request-level test can ask (#254).
 *
 * Almost everything about Media is asserted through the API in `packages/core/src/media/`, and
 * that is where it belongs. What is here is what only a browser has:
 *
 * - **The one form in this Admin that is not JSON.** It uses no react-hook-form, because a file
 *   input's value is a `FileList` the browser owns and nothing may set — so the file is held
 *   beside the form and the request is built by a `bodySerializer` handing `openapi-fetch` a
 *   `FormData`. None of that shape is exercised by anything else in this repository, and a
 *   serializer that produced the wrong body would still typecheck.
 * - **That the storage kobai ships actually works on a Project that configured nothing.**
 *   `reference/kobai.config.ts` has no `media` key at all, so this really-booted Project is the
 *   default: the bytes go to a directory, the Media reports `/media/{key}`, and the assertion
 *   that the preview *decoded* is the whole of "a Store with no object store still shows its
 *   images" (ADR-0078). A `src` that resolved to the Admin's own `index.html` — which is what
 *   the dev proxy got wrong — has a `naturalWidth` of zero.
 */
describe("the Media screen", () => {
  /**
   * A **real** 2×3 PNG — signature, `IHDR`, a deflated `IDAT` and `IEND`, each with its CRC.
   *
   * Built rather than checked in as a blob, so the two numbers this case asserts are numbers
   * somebody wrote down here. It has to be a whole file rather than the header the unit tests
   * use: `naturalWidth` is the browser saying it **decoded** an image, and a truncated PNG is
   * exactly the thing that would answer zero for the wrong reason.
   */
  function pngBytes(): Buffer {
    const width = 2;
    const height = 3;

    const chunk = (tag: string, body: Buffer): Buffer => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      const tagged = Buffer.concat([Buffer.from(tag, "ascii"), body]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(tagged));
      return Buffer.concat([length, tagged, crc]);
    };

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    // Eight bits a channel, colour type 2 (truecolour), no interlacing.
    header.set([8, 2, 0, 0, 0], 8);

    // One filter byte per scanline, then three bytes a pixel. Every pixel is black, which is
    // the least this case needs an image to be.
    const raw = Buffer.alloc(height * (1 + width * 3));

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  it("uploads a file with its alt text, and shows the image kobai served back", async () => {
    const page = await seam.signedIn("/media");
    await shows(page.getByText("Everything this Store has uploaded"), "the Media screen");
    await auditAccessibility(page, "the Media screen");

    const named = `a-poster-${Date.now()}.png`;
    await page.getByLabel("File").setInputFiles({
      name: named,
      mimeType: "image/png",
      buffer: pngBytes(),
    });
    await page.getByLabel("Alt text").fill("A blue A2 poster on a white wall");
    await page.getByRole("button", { name: "Upload" }).click();

    // The row, by the two things a Merchant typed — so this is the multipart body having
    // arrived intact rather than a request merely having been answered.
    const row = page.getByRole("row").filter({ hasText: named });
    await shows(row, "the uploaded Media in the list");
    await shows(row.getByText("A blue A2 poster on a white wall"), "its alt text");

    // And the bytes came back from wherever the Project put them, which on a Project that
    // configured nothing is a directory kobai serves itself. `naturalWidth` is the browser
    // saying it decoded an image; a broken `src` answers zero.
    const preview = row.getByRole("img", { name: "A blue A2 poster on a white wall" });
    await shows(preview, "the preview kobai served");
    await expect
      .poll(
        () =>
          // Structurally typed rather than as an `HTMLImageElement`: this file compiles
          // against Node's libs, so the DOM's names are not here — `focused` in the harness
          // does the same thing to read `document.activeElement`.
          preview.evaluate((node) => (node as { naturalWidth: number }).naturalWidth),
        { timeout: LOCATOR_TIMEOUT },
      )
      .toBe(2);

    await auditAccessibility(page, "the Media screen with something on it");
  });
});

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

  it("moves a Merchant onto another Role from the roster, and that is what lifts `role-in-use`", async () => {
    // The state #202 was filed about: a Role somebody holds, which `DELETE /admin/roles/{id}`
    // refuses. Two Roles that administer nobody, deliberately — see this describe's header.
    const holder = await seam.merchantOnARole(["catalog:read"]);
    const elsewhere = await createRole({
      name: `somewhere else ${Date.now()}`,
      permissions: ["order:read"],
    });
    const target = await seam.api<{ name: string }>(
      "GET",
      `/admin/roles/${elsewhere.id}`,
    );

    const page = await seam.signedIn("/merchants");
    // Newest first (ADR-0064), so the colleague this case just made is on the first page.
    const row = page.getByRole("row").filter({ hasText: holder.email });
    await shows(row, "the colleague's row");

    // The picker is labelled per row and the label is `sr-only`: a column heading is not
    // programmatically the label of a control inside a cell, so this is the name a screen
    // reader hears and the name this case asks by.
    const picker = row.getByRole("combobox", { name: `Role for ${holder.email}` });
    await shows(picker, "the Role picker in the colleague's row");
    const move = row.getByRole("button", { name: "Move" });
    // Dead while the picker still shows the Role they hold, with a real `disabled` because
    // there is nothing to explain — `Pager`'s judgement, not `ActionButton`'s.
    await expect(move.isDisabled()).resolves.toBe(true);

    await picker.click();
    await page.getByRole("option", { name: target.name }).click();
    await expect.poll(() => move.isDisabled()).toBe(false);
    await move.click();

    // Read back off the refetched roster rather than patched in — there are no optimistic
    // updates here (ADR-0063), so this is the list kobai answered after the move.
    await shows(row.getByText("order:read"), "the Permissions of the Role they now hold");
    await auditAccessibility(page, "the Merchants roster after a move");

    // And the whole of #202: the deletion the case above is refused now goes through, because
    // nobody holds that Role any more. Asked as "it is gone" rather than as "the call did not
    // reject" — `seam.api` throws on any non-2xx, so the read is what says which of the two
    // this was.
    await seam.api("DELETE", `/admin/roles/${holder.roleId}`);
    await expect(seam.api("GET", `/admin/roles/${holder.roleId}`)).rejects.toThrow(
      /answered 404/,
    );
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

  /**
   * The currency pickers on these screens, which are two of the three (#300).
   *
   * **Only a browser can ask either of these.** What a Merchant may enable is
   * `Intl.supportedValuesOf("currency")` — the running browser's copy of ISO 4217, which no
   * request-level test has and which is deliberately neither kobai's answer nor a table in this
   * repository. What a Region may select is the Store's *enabled* set, and that a list on screen
   * was built from `GET /admin/store` rather than from anything written down is a fact about a
   * rendered popup. Both are filterable, and typing is not something a scanner sees either. The
   * third is the Price editor's, asserted with the catalog screens where that form lives, and
   * the helpers all three share are at this file's level.
   *
   * Nothing here is a boundary. `core_store_currency` still takes any three-character code and
   * every refusal it has is unchanged — `currency-not-enabled` is asserted where it lives, and
   * the picker is the affordance that stops a Merchant meeting it by typo.
   */

  /**
   * A window whose `Intl` is missing something, which is how the two fallbacks are reached.
   *
   * **This is the one arrangement in this file that changes the runtime rather than the
   * deployment**, and it is the only seam that can. Both fallbacks are about a browser older or
   * poorer than the one the gate drives — `Intl.supportedValuesOf` arrived in 2022, and a
   * runtime with no display name for a currency answers the bare code — so there is nothing
   * kobai could answer that would put the Admin in either state, and the branches would
   * otherwise be code no test can reach. It is not `page.route` inventing an answer kobai did
   * not give: nothing about the deployment changes, and every request in these cases is real.
   */
  async function anIntlWithout(
    missing: "supportedValuesOf" | "DisplayNames",
    path: string,
  ): Promise<Page> {
    const page = await seam.signedIn(path);
    await page.addInitScript(`delete Intl.${missing};`);
    await page.reload();
    return page;
  }

  it("enables a currency by typing a code and confirming, out of the browser's ISO 4217", async () => {
    const page = await seam.signedIn("/settings");
    const picker = page.getByRole("combobox", { name: "Enable another" });
    await shows(picker, "the currency picker, in place of the text box #291 shipped");
    await picker.click();

    // Typed rather than scrolled to, which is the whole reason this is a combobox and not the
    // `Select` every other picker in this Admin is: ISO 4217 is a list of a few hundred.
    await currencySearch(page).fill("SGD");
    const offered = page.getByRole("option");
    // The code **and** the name this browser has for it, which is `Intl.DisplayNames` and no
    // table of ours. A runtime with no display name falls back to the bare code, which is why
    // the code leads.
    await shows(offered, "the row a Merchant typed their way to");
    await expect
      .poll(async () => (await offered.allInnerTexts()).map((text) => text.trim()))
      .toEqual(["SGD — Singapore Dollar"]);
    // An overlay is a screen. This one is a `role="dialog"`, which is why the popup needs none
    // of `ui/select.tsx`'s portal plumbing — and what the audit is really watching here is that
    // the page behind it is still readable, since the arrangement that hid it also passed
    // every other assertion in this case.
    await auditAccessibility(page, "the Store screen with the currency list open");

    // Confirmed from the keyboard — `ArrowDown` to the match, `Enter` to take it — which is the
    // half of "filterable" a mouse never exercises.
    await currencySearch(page).press("ArrowDown");
    await currencySearch(page).press("Enter");
    await expect
      .poll(async () => (await picker.innerText()).trim())
      .toBe("SGD — Singapore Dollar");

    await page.getByRole("button", { name: "Enable currency" }).click();

    // Read back rather than predicted (ADR-0063): what this Store prices in is kobai's answer.
    await expect
      .poll(enabledCurrencies, {
        timeout: LOCATOR_TIMEOUT,
        message: "The currency chosen from the picker never reached kobai.",
      })
      .toContain("SGD");
    await shows(
      page.getByRole("button", { name: "Disable SGD" }),
      "the newly enabled currency's row",
    );

    // And it is no longer on offer, because enabling it again would send the set the Store
    // already has — an affordance, exactly like the missing Remove on the default currency's
    // row, and never a rule: kobai would have accepted it.
    await picker.click();
    await currencySearch(page).fill("SGD");
    await shows(
      page.getByText("Nothing to enable for that."),
      "a currency this Store already prices in, no longer offered",
    );
  });

  it("enables a code this browser does not list, typed, and sends it upper case", async () => {
    const page = await seam.signedIn("/settings");
    // A three-letter code the **running** browser has no row for, asked of the browser rather
    // than assumed: which codes `Intl` knows differs between a desktop Chromium and the headless
    // shell the gate drives, so a code hard-coded here would be a case that passes for the wrong
    // reason on one of them.
    const unlisted = await page.evaluate(() => {
      const listed = new Set(Intl.supportedValuesOf("currency"));
      return ["XBT", "ZWD", "CNH", "TRL"].find((code) => !listed.has(code)) ?? null;
    });
    expect(
      unlisted,
      "this browser lists every code the case had to choose from, so it cannot test one it does not list",
    ).not.toBeNull();
    if (unlisted === null) return;

    const picker = page.getByRole("combobox", { name: "Enable another" });
    await picker.click();
    // Typed the way somebody types, which is the other half of what has to survive: `core_store
    // _currency` stores upper case, and a Merchant typing a code by hand is not thinking about
    // that.
    await currencySearch(page).fill(unlisted.toLowerCase());

    // Offered as a row of its own and named for what it is, because every other row in this list
    // is a currency the browser vouched for and this one is not.
    const invented = page.getByRole("option", {
      name: `${unlisted} — not one this browser lists`,
    });
    await shows(invented, "the code this browser does not list, offered anyway");
    await auditAccessibility(
      page,
      "the Store screen offering a code the browser has no row for",
    );

    await invented.click();
    await page.getByRole("button", { name: "Enable currency" }).click();

    // The whole point of the escape hatch: this screen is the only way a Merchant reaches a
    // route that takes any three characters, so a gap in this browser's `Intl` must not become
    // a gap in kobai. Upper case, because that is how kobai stores one.
    await expect
      .poll(enabledCurrencies, {
        timeout: LOCATOR_TIMEOUT,
        message: "A code the browser does not list never reached kobai.",
      })
      .toContain(unlisted);
  });

  it("gives a browser that lists no currencies the text box it had", async () => {
    const page = await anIntlWithout("supportedValuesOf", "/settings");

    // No picker at all, and the field a Merchant had before #300 in its place — an empty menu
    // would leave a deployment unable to enable anything, on a route that would have taken it.
    const box = page.getByLabel("Enable another");
    await shows(box, "the text box a runtime with no ISO 4217 list falls back to");
    await expect(box.getAttribute("role")).resolves.toBeNull();
    await shows(
      page.getByText("This browser does not list them"),
      "what this Merchant is told about the box",
    );
    await auditAccessibility(page, "the Store screen on a browser with no currency list");

    await box.fill("bhd");
    await page.getByRole("button", { name: "Enable currency" }).click();

    await expect
      .poll(enabledCurrencies, {
        timeout: LOCATOR_TIMEOUT,
        message: "The typed code never reached kobai from the fallback box.",
      })
      .toContain("BHD");
  });

  it("labels a currency it has no name for with the bare code", async () => {
    const page = await anIntlWithout("DisplayNames", "/settings");
    // A code this browser lists and this Store has **not** enabled, since an enabled one is
    // deliberately kept off the list — and which those are depends on the cases above, the
    // deployment being shared.
    const enabled = await enabledCurrencies();
    const listed = await page.evaluate(
      (already: readonly string[]) =>
        Intl.supportedValuesOf("currency").find((code) => !already.includes(code)) ??
        null,
      enabled,
    );
    expect(
      listed,
      "this Store already prices in every currency the browser lists",
    ).not.toBeNull();
    if (listed === null) return;

    await page.getByRole("combobox", { name: "Enable another" }).click();
    await currencySearch(page).fill(listed);

    // The ticket's own line: a row reading `undefined` is worse than a menu of unlabelled codes,
    // and `Intl.DisplayNames` is a thing a runtime may not have. Asserted whole rather than by
    // containment, because `SGD — undefined` carries the code too.
    await expect
      .poll(async () =>
        (await page.getByRole("option").allInnerTexts()).map((text) => text.trim()),
      )
      .toEqual([listed]);
    await auditAccessibility(
      page,
      "the Store screen with no display names to label rows with",
    );
  });

  it("offers a Region the currencies this Store has enabled, and nothing else", async () => {
    const store = await theStore();
    const enabled = await alsoPricingIn("JPY");
    const region = await seam.api<{ id: string }>("POST", "/admin/regions", {
      name: `Somewhere with a currency ${Date.now()}`,
      currency: store.defaultCurrency,
    });

    const page = await seam.signedIn(`/regions/${region.id}`);
    const picker = page.getByRole("combobox", { name: "Currency" });
    await shows(picker, "the Region's currency picker");
    await picker.click();

    // The whole assertion, and the one nothing else in this repository can make: this list is
    // what `GET /admin/store` answered, rather than the world's currencies — which is what the
    // *other* picker offers, on the screen next door. Read off the code each row leads with,
    // because the rest of the row is the name this browser has for it.
    await expect
      .poll(async () => (await currencyCodesOffered(page)).sort())
      .toEqual([...enabled].sort());
    // And **named**, which is the half that makes all three of these screens read alike: a bare
    // code here beside `SGD — Singapore Dollar` on the Store screen would be this Admin
    // disagreeing with itself about the same currency. The name itself is the runtime's, so this
    // asks that there is one rather than what it says.
    await shows(
      page.getByRole("option", { name: /^JPY — .+/ }),
      "an enabled currency, named the way the Store screen names it",
    );
    await auditAccessibility(page, "the Region screen with the currency list open");

    // A code this Store has not enabled is not reachable by typing either, and the popup says
    // where one is enabled rather than going blank. `currency-not-enabled` is still Core's, and
    // is still what answers anything that gets past this.
    await currencySearch(page).fill("CHF");
    await shows(
      page.getByText("This Store does not price in that."),
      "what a currency this Store has not enabled is answered with",
    );

    // Typed and confirmed from the keyboard, like the Store screen's — the two controls differ
    // in what they offer and in nothing about how a Merchant reaches it.
    await currencySearch(page).fill("JPY");
    await currencySearch(page).press("ArrowDown");
    await currencySearch(page).press("Enter");
    await expect.poll(async () => (await picker.innerText()).trim()).toMatch(/^JPY\b/);
    await page.getByRole("button", { name: "Save Region" }).click();

    // Read back off kobai, which is what says the picker feeds the form it is in rather than
    // merely rendering beside it.
    await expect
      .poll(() => seam.api<{ currency: string }>("GET", `/admin/regions/${region.id}`), {
        timeout: LOCATOR_TIMEOUT,
        message: "The Region never settled on the currency that was chosen.",
      })
      .toMatchObject({ currency: "JPY" });
  });

  it("asks for a new Region's currency the way the Region screen does", async () => {
    // The same question two screens apart, which is why this case exists at all: a Merchant
    // naming a currency on the create form and a Merchant changing one on the Region screen are
    // choosing from one set, and #300 is about them reading alike rather than about either.
    const enabled = await enabledCurrencies();
    const page = await seam.signedIn("/regions");
    const form = page.locator("form").filter({ hasText: "Create Region" });

    const picker = form.getByRole("combobox", { name: "Currency" });
    await shows(picker, "the New Region form's currency picker");
    await picker.click();

    await expect
      .poll(async () => (await currencyCodesOffered(page)).sort())
      .toEqual([...enabled].sort());
    await shows(
      page.getByRole("option", { name: /^JPY — .+/ }),
      "the same named row the Region screen offers",
    );
    await auditAccessibility(page, "the Regions screen with the currency list open");

    // Filterable by the **name** as well as the code, which is what one source for both halves
    // of a label buys: the codes come from kobai and the names from `Intl`, and a Merchant who
    // knows one or the other finds the row either way.
    await currencySearch(page).fill("yen");
    await expect.poll(() => currencyCodesOffered(page)).toEqual(["JPY"]);
    await currencySearch(page).press("ArrowDown");
    await currencySearch(page).press("Enter");

    const named = `Somewhere created in a browser ${Date.now()}`;
    await form.getByLabel("Name").fill(named);
    await form.getByRole("button", { name: "Create Region" }).click();

    // Read back off the list kobai answered, like every other create on this frame (ADR-0063).
    await shows(
      page.getByRole("row").filter({ hasText: named }),
      "the Region this case created, in the list",
    );
    await expect
      .poll(
        async () =>
          (
            await seam.api<{ regions: { name: string; currency: string }[] }>(
              "GET",
              "/admin/regions?limit=100",
            )
          ).regions.find((one) => one.name === named)?.currency,
      )
      .toBe("JPY");
  });

  it("says the currencies could not be read, rather than offering an empty picker", async () => {
    const page = await seam.signedIn("/regions");
    const form = page.locator("form").filter({ hasText: "Create Region" });
    await shows(
      form.getByRole("combobox", { name: "Currency" }),
      "the New Region form's currency picker",
    );

    // **The second place this file answers a route with something other than what kobai said**,
    // and the argument is the Playground's (`page.route` delays a response; it does not invent
    // one): the network being gone is not a state any request can arrange, and it is precisely
    // the state #311 is about. A *refused* read is a request-level question and is asserted
    // where those belong — `store:read` gates this route in Core. What only a browser can say
    // is that a picker with nothing in it says **which** kind of nothing it is, because an
    // empty list is what a Store that has enabled nothing draws too.
    await page.route(
      (url) => url.pathname === "/admin/store",
      async (route) => {
        await route.abort();
      },
    );
    await page.reload();

    const picker = form.getByRole("combobox", { name: "Currency" });
    await shows(picker, "the currency picker, on a load whose Store read failed");
    await shows(
      form.getByText("kobai did not say which currencies this Store has enabled."),
      "the failed read, said under the field it emptied",
    );
    // And the sentence a Merchant must **not** be given, which is the defect rather than the
    // fix: sending somebody to enable a currency they very likely have is worse than silence.
    await hides(
      form.getByText("This Store prices in one currency."),
      "the advice that would have been wrong",
    );
    // Dead as well as explained, and the two halves are separate assertions on purpose: a
    // picker that is only disabled reads as one that has not loaded yet, and a sentence under a
    // live control invites a Merchant to open an empty list. Real `disabled` rather than
    // `aria-disabled` is right here for `Pager`'s reason — there is no explanation to host on
    // the control, because it is already under it.
    await expect(picker.isDisabled()).resolves.toBe(true);
    await auditAccessibility(page, "the Regions screen whose Store read failed");
  });
});
