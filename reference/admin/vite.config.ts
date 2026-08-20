import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The Admin's build, and the dev loop that keeps it to one origin.
 *
 * `base` is the path the Project serves this from (ADR-0033). It is baked into every asset
 * URL the built `index.html` refers to, so it has to agree with `ADMIN_PATH` in
 * `reference/src/admin-assets.ts` — `reference/src/app.test.ts` asserts that it does.
 *
 * It deliberately sits *outside* `/admin`. The session cookie is scoped to kobai's admin
 * surface (ADR-0032), and a cookie path matches a request path only at a `/` boundary, so
 * `/admin-ui/…` never carries the credential. Assets have no use for it, and a value that
 * never reaches a handler is a value that handler cannot log.
 */
const ADMIN_BASE = "/admin-ui/";

/**
 * Where the API is while a Developer is editing the Admin.
 *
 * `pnpm run dev` runs the reference Project on whatever `PORT` says, and this dev server
 * proxies kobai's surfaces to it — so **the browser only ever sees one origin**, this
 * one, exactly as it sees only one in production. That is the whole reason the proxy exists:
 * a second origin would need CORS, and ADR-0010 spends the single container to not have any.
 */
const api = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;

/**
 * Proxied by **regular expression**, not by prefix, and that is load-bearing.
 *
 * Vite matches a plain string key as a prefix, and `/admin` is a prefix of `/admin-ui`: the
 * string form would send this dev server's own modules to the API and serve nothing at all.
 * A key beginning with `^` is compiled as a RegExp instead, so the boundary is explicit.
 */
const proxy = {
  "^/admin/": { target: api, changeOrigin: false },
  "^/store/": { target: api, changeOrigin: false },
  "^/health$": { target: api, changeOrigin: false },
  // Media's bytes, which are kobai's on a deployment using the storage it ships: a Media
  // reports `/media/{key}` and an `<img>` asks this server for it. Without the line the dev
  // loop answers that request with the Admin's own `index.html` and every preview is a broken
  // image — which the single-origin container never shows, because there is no dev server in
  // it. A deployment whose storage answers absolute URLs never reaches here at all.
  "^/media/": { target: api, changeOrigin: false },
};

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: ADMIN_BASE,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // `reference/admin/dist`, which `reference/src/admin-assets.ts` resolves through Node's
    // own module resolution rather than by counting `..` segments — see the comment there.
    outDir: "dist",
    emptyOutDir: true,
  },
  server: { proxy },
});
