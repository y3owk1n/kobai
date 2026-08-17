import type { Session } from "@kobai/client";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { createAdminClient } from "@/lib/kobai";
import { clearPreviewKey } from "@/lib/preview-key";
import { ApiKeys } from "@/screens/api-keys";
import { ProductScreen } from "@/screens/product";
import { Products } from "@/screens/products";
import { SignIn } from "@/screens/sign-in";

/**
 * The Admin, whole.
 *
 * It holds no credential and models no session. `GET /admin/session` is the first call after
 * a page load — "who am I, and what may I do" — and the browser answers the "am I signed in"
 * part by sending the cookie or not sending it (ADR-0032). Signing out is
 * `DELETE /admin/session`, which deletes the row *and* clears the cookie, so neither half is
 * left behind.
 *
 * Being signed out by an expiry is not a timer here. Every call goes through a client that
 * watches for the admin gate's 401 and reads its `reason`; `session-expired` is a different
 * answer from `session-missing`, and the sign-in screen says which one happened.
 *
 * There is deliberately no router. Screens are a value in state, which is enough for four of
 * them and leaves nothing to unpick when a Developer replaces this with theirs — the source
 * is vendored into this Project and is theirs to change (ADR-0010, ADR-0033).
 */
type Screen =
  | { readonly name: "products" }
  | { readonly name: "product"; readonly id: string }
  | { readonly name: "api-keys" };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [expired, setExpired] = useState(false);
  const [screen, setScreen] = useState<Screen>({ name: "products" });

  const client = useMemo(
    () =>
      createAdminClient((reason) => {
        setSession(null);
        // Only an expiry is worth mentioning. `session-missing` is what an anonymous page
        // load answers, and telling somebody their session ended when they never had one
        // would be noise on the very first request the Admin makes.
        setExpired(reason === "session-expired");
      }),
    [],
  );

  useEffect(() => {
    let live = true;
    void client.GET("/admin/session").then(({ data }) => {
      if (!live) return;
      if (data) setSession(data);
      setChecking(false);
    });
    return () => {
      live = false;
    };
  }, [client]);

  async function signOut(): Promise<void> {
    await client.DELETE("/admin/session");
    clearPreviewKey();
    setSession(null);
    setExpired(false);
    setScreen({ name: "products" });
  }

  if (checking) {
    return (
      <main className="mx-auto max-w-2xl p-6 text-muted-foreground text-sm">
        Asking kobai who you are…
      </main>
    );
  }

  if (!session) {
    return (
      <SignIn
        client={client}
        expired={expired}
        onSignedIn={(signedIn) => {
          setSession(signedIn);
          setExpired(false);
        }}
      />
    );
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">kobai Admin</span>
          <Button
            size="sm"
            variant={screen.name === "api-keys" ? "ghost" : "secondary"}
            onClick={() => setScreen({ name: "products" })}
          >
            Products
          </Button>
          <Button
            size="sm"
            variant={screen.name === "api-keys" ? "secondary" : "ghost"}
            onClick={() => setScreen({ name: "api-keys" })}
          >
            API keys
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">{session.merchant.email}</span>
          <Button size="sm" variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>

      <Separator />

      {screen.name === "products" ? (
        <Products client={client} onOpen={(id) => setScreen({ name: "product", id })} />
      ) : null}
      {screen.name === "product" ? (
        <ProductScreen
          client={client}
          id={screen.id}
          onBack={() => setScreen({ name: "products" })}
        />
      ) : null}
      {screen.name === "api-keys" ? <ApiKeys client={client} /> : null}
    </div>
  );
}
