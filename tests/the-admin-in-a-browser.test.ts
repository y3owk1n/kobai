import type { Page } from "playwright";
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
  shows,
  startAdminSeam,
  tabTo,
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

/** The rows of the Products table, which is what a page of a list looks like. */
function productRows(page: Page) {
  return page.getByRole("row").filter({ has: page.getByRole("link", { name: "Open" }) });
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
    .poll(() => productRows(page).count(), {
      timeout: LOCATOR_TIMEOUT,
      message: `The Products list never settled at ${rows} rows.`,
    })
    .toBe(rows);
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
    await shows(productRows(page).first(), "the first page of Products");
    await holdsRows(page, aPage);

    await page.getByRole("link", { name: "Next" }).click();

    // Opaque, so there is nothing to assert about the value — only that it is there, which is
    // what makes the page a URL somebody can send (ADR-0064).
    expect(where(page)).toMatch(/^\/products\?after=.+/);
    await holdsRows(page, theRest);
    const second = where(page);

    await page.reload();
    expect(where(page)).toBe(second);
    await shows(productRows(page).first(), "the second page after a refresh");
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
    await shows(productRows(page).first(), "a page of Products");

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
    await shows(productRows(page).first(), "the Products, once they arrived");
  });

  it("says there are none, rather than showing an empty table", async () => {
    await seam.emptyTheCatalog();
    const page = await seam.signedIn("/products");

    await shows(page.getByText("No Products yet"), "the empty state");
    await expect(productRows(page).count()).resolves.toBe(0);
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
