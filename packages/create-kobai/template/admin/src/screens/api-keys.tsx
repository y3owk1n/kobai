import type { ApiKeySummary, IssuedApiKey, KobaiClient } from "@kobai/client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Problem } from "@/components/problem";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { clearPreviewKey, readPreviewKey, writePreviewKey } from "@/lib/preview-key";
import { messageOf } from "@/lib/refusal";

/**
 * Every API key this deployment has issued, and the way to revoke one.
 *
 * `GET /admin/api-keys` exists because of what was missing without it: minting shows the
 * value once and the id once, so a Merchant who lost that response held a live credential
 * they could not name. Nothing in the list is presentable — only a digest of a key is
 * stored, so there is no value to show and no fragment of one is offered instead. `name` is
 * what tells two keys apart, which is why minting demands one.
 *
 * It asks for no page and shows what arrives, so it shows the first page and no more — see the
 * Orders screen for why that gap is left open here rather than closed.
 */
export function ApiKeys({ client }: { readonly client: KobaiClient }) {
  const [keys, setKeys] = useState<readonly ApiKeySummary[] | null>(null);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // `sessionStorage` is not something React re-renders for, so what is held there is mirrored
  // into state. Reading it during render instead would leave the "Forget" button on screen
  // after it had done its work.
  const [previewing, setPreviewing] = useState(readPreviewKey() !== null);

  const load = useCallback(async () => {
    const { data, error } = await client.GET("/admin/api-keys");
    if (data) {
      setKeys(data.apiKeys);
      setProblem(null);
      return;
    }
    setProblem(messageOf(error, "The API keys could not be read."));
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mint(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const { data, error } = await client.POST("/admin/api-keys", {
      body: { name, kind: "publishable" },
    });
    if (data) {
      setIssued(data);
      setName("");
    } else {
      setProblem(messageOf(error, "The key could not be minted."));
    }
    setBusy(false);
    await load();
  }

  async function revoke(id: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    const { error, response } = await client.DELETE("/admin/api-keys/{id}", {
      params: { path: { id } },
    });
    if (response.status !== 204) {
      setProblem(messageOf(error, "The key could not be revoked."));
    }
    // Revoking the key still on screen takes its value off the screen with it: offering to
    // copy a credential that has stopped working is worse than offering nothing.
    if (issued?.id === id) setIssued(null);
    setBusy(false);
    await load();
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            The credentials a storefront presents at <code>/store</code>. A key's value is
            shown once, at creation, and stored only as a digest — so this list can name a
            key and never hand one back.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Problem problem={problem} />

          {issued ? (
            <Alert>
              <AlertTitle>Copy this now — it is shown once.</AlertTitle>
              <AlertDescription className="grid gap-2">
                <code className="break-all">{issued.key}</code>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      writePreviewKey(issued.key);
                      setPreviewing(true);
                      setIssued(null);
                    }}
                  >
                    Use it for storefront previews
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          {keys === null && problem === null ? (
            <p className="text-muted-foreground text-sm">Reading the keys…</p>
          ) : null}

          {keys !== null && keys.length === 0 ? (
            <p className="text-muted-foreground text-sm">No keys have been minted.</p>
          ) : null}

          {keys !== null && keys.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">
                      {key.name}
                      <div className="text-muted-foreground text-xs">
                        <code>{key.id}</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={key.kind === "secret" ? "destructive" : "secondary"}
                      >
                        {key.kind}
                      </Badge>
                    </TableCell>
                    <TableCell>{new Date(key.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      {key.revokedAt
                        ? `revoked ${new Date(key.revokedAt).toLocaleString()}`
                        : "live"}
                    </TableCell>
                    <TableCell>
                      {key.revokedAt ? null : (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => void revoke(key.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mint a publishable key</CardTitle>
          <CardDescription>
            <code>kobai_pk_…</code> is the kind that is safe in a browser. The Admin uses
            one to ask <code>/store</code> what price a storefront would receive.
          </CardDescription>
        </CardHeader>
        <form onSubmit={mint}>
          <CardContent className="grid gap-1.5">
            <Label htmlFor="key-name">Name</Label>
            <Input
              id="key-name"
              value={name}
              placeholder="the shop's browser"
              onChange={(event) => setName(event.target.value)}
              required
            />
          </CardContent>
          <CardFooter className="mt-4 gap-2">
            <Button type="submit" disabled={busy}>
              Mint
            </Button>
            {previewing ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  clearPreviewKey();
                  setPreviewing(false);
                }}
              >
                Forget the preview key
              </Button>
            ) : null}
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
