import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useState,
} from "react";

/**
 * Light, dark, or whatever the machine says — and the class on `<html>` that makes it true.
 *
 * `src/index.css` has carried a complete `.dark` palette since the first commit, and every
 * vendored component carries `dark:` variants, and **nothing in this source had ever put the
 * class on the document** (ADR-0063). So the Admin shipped a full second theme that could not
 * be reached. This module is the missing half of it, and it is deliberately small: a class, a
 * string in `localStorage`, and a listener for the one case that changes underneath us.
 *
 * Three choices rather than two. "Dark" and "light" are a Merchant overriding their machine;
 * `system` is the absence of an override, and it has to be a value of its own — a Merchant who
 * picks dark at night and wants their machine to decide again in the morning has nothing to
 * click if the toggle only flips between two states.
 */
export type Theme = "light" | "dark" | "system";

/**
 * Where the choice is kept.
 *
 * `localStorage` rather than a cookie: it is the browser's own preference and no request
 * needs it, so sending it to kobai on every call would be a value the server has no use for
 * and would then be free to log. `sessionStorage` would forget it when the tab closed, which
 * is not what "persists" means to somebody who set it once.
 */
const STORED = "kobai.admin.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

type ThemeChoice = {
  /** What the Merchant chose, `system` included. */
  readonly theme: Theme;
  /** What is on the document right now — `system` resolved against the machine. */
  readonly resolved: "light" | "dark";
  readonly setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeChoice | null>(null);

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function storedTheme(): Theme {
  // A browser with storage disabled throws on read rather than answering null, and a Merchant
  // whose Admin refused to start because of a preference would be a bad trade for one.
  try {
    const stored = window.localStorage.getItem(STORED);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [theme, setChoice] = useState<Theme>(storedTheme);
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia(DARK_QUERY).matches,
  );

  // The machine's preference is not a value that is read once. A Merchant whose desktop
  // switches at sunset while the Admin is open is the ordinary case for this listener, and
  // without it `system` would mean "whatever the machine said when this tab opened".
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved = theme === "system" ? (systemIsDark ? "dark" : "light") : theme;

  useEffect(() => {
    // `.dark` is what `@custom-variant dark` in `src/index.css` matches on, so this one line
    // is the whole of what switches every token and every `dark:` utility in the Admin.
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setTheme = useCallback((next: Theme) => {
    setChoice(next);
    try {
      window.localStorage.setItem(STORED, next);
    } catch {
      // Storage being unavailable costs the *persistence*, not the choice — the class is
      // already on the document by the time this runs.
    }
  }, []);

  return <ThemeContext value={{ theme, resolved, setTheme }}>{children}</ThemeContext>;
}

export function useTheme(): ThemeChoice {
  const choice = use(ThemeContext);
  if (!choice) throw new Error("useTheme is only usable inside a ThemeProvider.");
  return choice;
}
