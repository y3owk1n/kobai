import { readFile } from "node:fs/promises";

/**
 * The Admin, served by this Project's own process, from this Project's own files.
 *
 * ADR-0010 gives a Project one container: the Admin is not a second service, not a second
 * origin, and not a CDN — it is a directory of built files this process hands out at a path.
 * That is what removes CORS from the setup path entirely, and there is no CORS configuration
 * anywhere in this repository as a result. It is also why serving them is the *Project's*
 * job and not Core's: Core chooses no path for the Admin, and this file is the whole of what
 * choosing one costs.
 *
 * **The path sits outside `/admin` on purpose.** A session cookie scoped to kobai's admin
 * surface (ADR-0032) matches a request path only at a `/` boundary, so `/admin-ui/…` never
 * carries the credential and no asset request can log one. It is also the boundary that
 * keeps the two apart in the other direction: `claims()` is the only thing that diverts a
 * request away from Core, and `/admin/products` is not a path it claims.
 */
export const ADMIN_PATH = "/admin-ui";

/** Where `vite build` writes the Admin, as a URL ending in `/`. */
export type AdminAssetsOptions = {
  readonly root?: URL;
};

export type AdminAssets = {
  /**
   * Whether this request is the Admin's rather than kobai's.
   *
   * A path, not a prefix match on a bare string: `/admin-ui` and everything under
   * `/admin-ui/`, and nothing else. `/admin`, `/store` and `/health` are Core's and are not
   * claimed — which is the single line that decides there is no second router in front of
   * the API.
   */
  claims(pathname: string): boolean;
  fetch(request: Request): Promise<Response>;
};

/**
 * Where the built Admin is, found the way Node finds anything.
 *
 * Not by counting `..` segments from this module: this file runs from `src/` under
 * `--watch` and from `dist/src/` in the container, which are different depths, and a
 * relative path that is right in one is quietly wrong in the other. Resolving the Admin
 * package's own `package.json` through the module resolver is right in both, and in the
 * Docker image, because it is the same lookup an `import` would do.
 */
function defaultRoot(): URL {
  return new URL("dist/", import.meta.resolve("kobai-project-admin/package.json"));
}

export function createAdminAssets(options: AdminAssetsOptions = {}): AdminAssets {
  const root = options.root ?? defaultRoot();

  return {
    claims(pathname) {
      return pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`);
    },

    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return refuse(405, "method-not-allowed", "The Admin is served, not written to.");
      }

      const { pathname } = new URL(request.url);
      if (pathname === ADMIN_PATH) {
        // Without the trailing slash a relative asset URL in the page would resolve against
        // `/`, so the redirect is what makes the bare path work at all.
        return new Response(null, {
          status: 308,
          headers: { location: `${ADMIN_PATH}/` },
        });
      }

      const index = await read(new URL("index.html", root));
      if (!index) {
        // The one failure worth explaining rather than 404ing: a process started without the
        // Admin ever having been built. Every command that starts one builds first, so this
        // is reachable mainly by running the entrypoint by hand — and then the useful answer
        // is which command to run, not "not found".
        return refuse(
          503,
          "admin-not-built",
          "The Admin has not been built. Run `pnpm run build` (or `pnpm run dev`, which builds), or `pnpm run admin:dev` to serve it from Vite with a reload loop while editing it.",
        );
      }

      const relative = pathname.slice(`${ADMIN_PATH}/`.length);
      const file = relative === "" ? undefined : resolveWithin(root, relative);
      const content = file ? await read(file) : undefined;

      if (content && file) {
        return new Response(content, {
          headers: {
            "content-type": contentType(file.pathname),
            // Vite fingerprints everything under `assets/`, so those may be cached forever
            // and the entry point may not — the whole deploy hinges on `index.html` being
            // re-fetched.
            "cache-control": relative.startsWith("assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
          },
        });
      }

      // A fingerprinted asset that is missing is missing, and saying so is the difference
      // between a stale deploy and a page that renders HTML into a `<script>` tag.
      if (relative.startsWith("assets/")) {
        return refuse(404, "not-found", "No such Admin asset exists.");
      }

      // Everything else is a route inside the Admin, which is one page: hand back the page
      // and let it read the URL.
      return new Response(index, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    },
  };
}

/**
 * The refusal shape kobai's store surface uses, because a Project serving two things from
 * one origin should not answer in two shapes.
 */
function refuse(status: number, reason: string, error: string): Response {
  return new Response(JSON.stringify({ error, reason }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function read(file: URL): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch {
    return undefined;
  }
}

/**
 * A path under `root`, or nothing.
 *
 * `new URL` normalises `..` before this sees it, so the check is on the result rather than on
 * the input — which is the only place it can be made honestly. A request for
 * `/admin-ui/../../.env` therefore resolves somewhere outside `root` and is answered as a
 * miss, not as a file.
 */
function resolveWithin(root: URL, relative: string): URL | undefined {
  const resolved = new URL(relative, root);
  return resolved.href.startsWith(root.href) ? resolved : undefined;
}

/**
 * Enough of a MIME table for what `vite build` emits.
 *
 * Deliberately a closed list rather than a dependency: an unknown extension is served as
 * bytes, which is the safe answer, and a browser never has to guess about the ones that
 * matter.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function contentType(pathname: string): string {
  const dot = pathname.lastIndexOf(".");
  const extension = dot === -1 ? "" : pathname.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}
