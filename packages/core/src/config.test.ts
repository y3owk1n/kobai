import { describe, expect, it } from "vitest";
import { consoleLogger, type Logger } from "./config.ts";
import type { KobaiOptions } from "./kobai.ts";

/**
 * **What the compiler refuses to let a Project pass as a `Logger`** (#127).
 *
 * `Logger` is the oldest of Core's named interfaces and the only one that goes to
 * `createKobai` rather than into `kobai.config.ts`, so these are written against
 * {@link KobaiOptions} — the type of the call a Developer actually makes — rather than against
 * `Logger` alone, which is where `fulfilment.test.ts` writes its own against
 * `KobaiProjectConfig` and for the same reason: that is where the promise is kept.
 *
 * They are run by the `typecheck` step of the gate rather than by vitest. The `expect` below
 * each only keeps the block a test; the assertion is the `@ts-expect-error`, which fails the
 * build if the line it marks ever compiles.
 */
describe("what a Project could not have passed as a Logger", () => {
  it("rejects a logger that demands `fields` be present", () => {
    // Contravariance, and the whole reason `info` and `error` are function-valued properties
    // rather than methods. `fields` is the right type here and merely required, which is the
    // shape most likely to be written by accident — and the fix is the one character the
    // `Logger` doc comment names. Core calls `logger.info("listening")` with no second argument.
    const insistent: KobaiOptions = {
      databaseUrl: "postgres://localhost/kobai",
      logger: {
        // @ts-expect-error Core sends `fields` when it has some, and omits it when it has none.
        info: (_message: string, fields: Record<string, unknown>) => {
          console.log(Object.keys(fields).length);
        },
        error: () => {},
      },
    };

    expect(insistent).toBeDefined();
  });

  it("rejects a logger that demands a required `fields` of its own shape", () => {
    // #127's own example, and both mistakes at once: required, and naming a key inside data Core
    // treats as open. Under the method spelling this compiled and then read `.requestId` off
    // `undefined`.
    const fussy: KobaiOptions = {
      databaseUrl: "postgres://localhost/kobai",
      logger: {
        // @ts-expect-error Core promises open data, and promises nothing about what is in it.
        info: (_message: string, fields: { requestId: string }) => {
          console.log(fields.requestId);
        },
        error: () => {},
      },
    };

    expect(fussy).toBeDefined();
  });

  it("rejects a logger that demands a narrower `fields` than Core sends", () => {
    // The same mistake one step subtler: `fields` is optional here, so this one survives a call
    // with no fields at all — and then reads `.requestId` off whatever Core did send.
    const narrow: KobaiOptions = {
      databaseUrl: "postgres://localhost/kobai",
      logger: {
        // @ts-expect-error Core sends open data; a logger may not name a key inside it.
        info: (_message: string, fields?: { requestId: string }) => {
          console.log(fields?.requestId);
        },
        error: () => {},
      },
    };

    expect(narrow).toBeDefined();
  });

  it("takes every logger that accepts what Core actually sends", () => {
    // The other half of the change, and the reason it was a widening in practice rather than a
    // break (ADR-0058): nothing that was honest about what it is handed stopped compiling. A
    // logger may ignore `fields`, take it as Core declares it, or take something wider.
    const ignoresFields: Logger = { info: () => {}, error: () => {} };
    const takesFields: Logger = {
      info: (message, fields) => console.log(message, fields),
      error: (message, fields) => console.error(message, fields),
    };
    const takesWider: Logger = {
      info: (_message: string, _fields?: unknown) => {},
      error: (_message: string, _fields?: unknown) => {},
    };

    expect([ignoresFields, takesFields, takesWider, consoleLogger]).toBeDefined();
  });
});
