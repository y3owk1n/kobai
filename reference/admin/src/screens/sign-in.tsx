import type { KobaiClient, Session } from "@kobai/client";
import { type FormEvent, useState } from "react";
import { Problem } from "@/components/problem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { messageOf } from "@/lib/refusal";

/**
 * The way in (spec story 48).
 *
 * `POST /admin/session` answers with who you now are and sets the session as an httpOnly
 * cookie; the credential is in no response body and this screen never sees it. So there is
 * nothing here to store, and the next request the Admin makes carries the session because
 * the browser attaches it on its own (ADR-0032).
 *
 * **There is no "claim this deployment" here, and there must not be one.** A second button
 * used to call `POST /admin/merchants`, which answered an anonymous request exactly once —
 * so whoever reached a fresh deployment first owned the Store. kobai has no unauthenticated
 * write path now (#25): the first Merchant is seeded at boot from the deployment's own
 * configuration, and the Admin's whole job on a fresh deployment is to say so.
 */
export function SignIn({
  client,
  expired,
  onSignedIn,
}: {
  readonly client: KobaiClient;
  /** The last session ended by running out, rather than by never having existed. */
  readonly expired: boolean;
  readonly onSignedIn: (session: Session) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function signIn(): Promise<void> {
    const { data, error } = await client.POST("/admin/session", {
      body: { email, password },
    });
    if (data) {
      onSignedIn(data);
      return;
    }
    setProblem(messageOf(error, "Signing in failed."));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    await signIn();
    setBusy(false);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6">
      {/* This screen renders in place of the frame, so the frame's heading is not here to
          inherit — and a page with no `h1` is a page a screen reader cannot summarise. Hidden
          because the card below already says it on screen. */}
      <h1 className="sr-only">Sign in to the kobai Admin</h1>
      <Card>
        <CardHeader>
          <CardTitle>kobai Admin</CardTitle>
          <CardDescription>Sign in to change this Store.</CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent className="grid gap-3">
            {expired ? (
              <Alert>
                <AlertTitle>Your session expired.</AlertTitle>
                <AlertDescription>
                  kobai answered <code>session-expired</code>, so this is the session
                  running out rather than a wrong password. Sign in again.
                </AlertDescription>
              </Alert>
            ) : null}
            <Problem problem={problem} />
            <div className="grid gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
          </CardContent>
          <CardFooter className="mt-4 flex-col items-stretch gap-2">
            <Button type="submit" disabled={busy}>
              Sign in
            </Button>
          </CardFooter>
        </form>
      </Card>
      <p className="text-muted-foreground text-xs">
        Nothing on this screen is stored in the browser. The session comes back as an
        httpOnly cookie no script can read.
      </p>
      <p className="text-muted-foreground text-xs">
        No Merchant yet? A deployment's first one is seeded when it boots, from{" "}
        <code>KOBAI_INITIAL_MERCHANT_EMAIL</code> and{" "}
        <code>KOBAI_INITIAL_MERCHANT_PASSWORD</code>. There is deliberately no way to
        create one from here.
      </p>
    </main>
  );
}
