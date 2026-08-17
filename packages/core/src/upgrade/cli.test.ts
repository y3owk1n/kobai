import { describe, expect, it } from "vitest";
import { parseUpgradeArguments } from "./cli.ts";

describe("what `kobai-upgrade` accepts", () => {
  it("takes the version to move to", () => {
    expect(parseUpgradeArguments(["--to", "1.0.0"])).toEqual({
      kind: "upgrade",
      to: "1.0.0",
      directory: undefined,
      skipInstall: false,
      dryRun: false,
    });
  });

  it("takes a Project somewhere other than here", () => {
    expect(
      parseUpgradeArguments(["--to", "1.0.0", "--project", "/tmp/store"]),
    ).toMatchObject({ directory: "/tmp/store" });
  });

  it("will not guess a version", () => {
    // The one thing a wrong answer here would do is move a Project somewhere nobody chose.
    expect(parseUpgradeArguments([])).toMatchObject({ kind: "error" });
    expect(parseUpgradeArguments(["--to"])).toMatchObject({ kind: "error" });
  });

  it("refuses a bare version, because it reads as the thing --to takes", () => {
    expect(parseUpgradeArguments(["1.0.0"])).toMatchObject({ kind: "error" });
  });

  it("takes the two ways of not doing the whole thing", () => {
    expect(
      parseUpgradeArguments(["--to", "1.0.0", "--no-install", "--dry-run"]),
    ).toMatchObject({ skipInstall: true, dryRun: true });
  });
});
