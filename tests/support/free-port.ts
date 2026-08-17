import { createServer } from "node:net";

/**
 * A port the OS says is free, by asking it for one and letting go.
 *
 * There is a race between closing this and something else binding it, and it is the right
 * trade: a *fixed* port would make two checkouts running `devbox run ci` at once fight over
 * one registry or one container, which is the failure #21 spent a whole ticket removing for
 * Postgres. The Postgres port is derived from the checkout's path instead of being ephemeral
 * because a container outlives its run and has to be findable again; nothing here outlives
 * its test, so there is nothing to find.
 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("The OS gave no free port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
