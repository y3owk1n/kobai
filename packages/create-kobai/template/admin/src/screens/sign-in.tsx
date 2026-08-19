import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormField } from "@/components/form-field";
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
import { Spinner } from "@/components/ui/spinner";
import { orThrow, problemOf, signInReasonOf } from "@/lib/refusal";
import { useKobai, useKobaiClient } from "@/lib/session";

/**
 * The way in (spec story 48).
 *
 * `POST /admin/session` answers with who you now are and sets the session as an httpOnly
 * cookie; the credential is in no response body and this screen never sees it. So there is
 * nothing here to store, and the next request the Admin makes carries the session because
 * the browser attaches it on its own (ADR-0032).
 *
 * **This screen has no URL, and that is what makes returning free.** It renders *in place of*
 * the routes rather than at a route of its own, so a Merchant whose session ran out while
 * reading an Order signs in and is looking at that Order again — with no return path stored
 * anywhere, because the address never changed (ADR-0063). `app.tsx` is where that swap is.
 *
 * **There is no "claim this deployment" here, and there must not be one.** A second button
 * used to call `POST /admin/merchants`, which answered an anonymous request exactly once —
 * so whoever reached a fresh deployment first owned the Store. kobai has no unauthenticated
 * write path now (#25): the first Merchant is seeded at boot from the deployment's own
 * configuration, and the Admin's whole job on a fresh deployment is to say so.
 */
const SignInForm = z.object({
  // The shape and only the shape (ADR-0063): that both fields were filled in. Whether this is
  // a Merchant of this Store, and whether that is their password, is Core's to answer — and it
  // answers with one refusal for both, deliberately, so that a form cannot be used to find out
  // which addresses exist.
  email: z.string().min(1, "Sign in with the email your Merchant was created with."),
  password: z.string().min(1, "A password is needed."),
});

type SignInValues = z.infer<typeof SignInForm>;

export function SignIn() {
  const client = useKobaiClient();
  const { expired, signedIn } = useKobai();

  const form = useForm<SignInValues>({
    resolver: zodResolver(SignInForm),
    defaultValues: { email: "", password: "" },
  });

  const signIn = useMutation({
    mutationFn: async (values: SignInValues) =>
      orThrow(await client.POST("/admin/session", { body: values })),
    // Which answers the gate in `app.tsx`, and the routes come back at the address that was
    // asked for all along. There is nothing to navigate to.
    onSuccess: (session) => signedIn(session),
  });

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
        <form onSubmit={form.handleSubmit((values) => signIn.mutate(values))}>
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

            <Problem problem={signIn.isError ? whyNotSignedIn(signIn.error) : null} />

            <FormField
              id="sign-in-email"
              label="Email"
              type="email"
              autoComplete="username"
              error={form.formState.errors.email}
              {...form.register("email")}
            />
            <FormField
              id="sign-in-password"
              label="Password"
              type="password"
              autoComplete="current-password"
              error={form.formState.errors.password}
              {...form.register("password")}
            />
          </CardContent>
          <CardFooter className="mt-4 flex-col items-stretch gap-2">
            <Button type="submit" disabled={signIn.isPending}>
              {signIn.isPending ? <Spinner /> : null}
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

/**
 * Why signing in did not work.
 *
 * Two families reach this form — the request hook's 400 and the handler's 401 — and every
 * `reason` either can carry has an arm here, with the `never` at the bottom to keep that true
 * (ADR-0063). **`invalid-credentials` is one refusal for two mistakes on purpose**: kobai does
 * not say whether the address exists, so neither does this, and a message naming the email as
 * the problem would undo that from the browser.
 */
function whyNotSignedIn(thrown: unknown): string {
  const reason = signInReasonOf(thrown);

  switch (reason) {
    case "invalid-credentials":
      return "That email and password do not sign in to this Store. kobai does not say which of the two was wrong.";

    case "invalid":
    case "malformed-body":
      // The form sends two strings, so this is reachable only if kobai's own idea of the body
      // moved — and kobai's prose names the field, which is more than this screen knows.
      return problemOf(thrown, "kobai would not read that request.");

    case undefined:
      // A 500, which carries no `reason` on purpose, or the network being gone. "Signing in
      // failed" is all either of them supports.
      return problemOf(thrown, "Signing in failed, and kobai did not say why.");

    default: {
      const unreached: never = reason;
      return unreached;
    }
  }
}
