import { describe, expect, it } from "vitest";
import { parseUpgradeArguments } from "./cli.ts";

describe("what `kobai-upgrade` accepts", () => {
  it("takes the version to move to, and nothing else", () => {
    expect(parseUpgradeArguments(["--to", "1.0.0"])).toEqual({
      kind: "upgrade",
      to: "1.0.0",
    });
  });

  it("will not guess a version", () => {
    // The one thing a wrong answer here would do is move a Project somewhere nobody chose.
    expect(parseUpgradeArguments([])).toMatchObject({ kind: "error" });
    expect(parseUpgradeArguments(["--to"])).toMatchObject({ kind: "error" });
  });

  it("refuses a bare version, because it reads as the thing --to takes", () => {
    expect(parseUpgradeArguments(["1.0.0"])).toMatchObject({ kind: "error" });
  });

  it("refuses the flags it deliberately does not have", () => {
    // `--dry-run` and `--no-install` were both considered and both removed: no codemod can
    // run until the version being moved to is on disk, so either would be an upgrade that
    // quietly ran none. Failing on them beats accepting and ignoring them.
    expect(parseUpgradeArguments(["--to", "1.0.0", "--dry-run"])).toMatchObject({
      kind: "error",
    });
    expect(parseUpgradeArguments(["--to", "1.0.0", "--no-install"])).toMatchObject({
      kind: "error",
    });
  });
});
