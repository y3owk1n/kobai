import { describe, expect, it } from "vitest";
import {
  CODEMOD_SET_FORMAT,
  type Codemod,
  codemods,
  type ProjectUnderUpgrade,
} from "./codemods.ts";
import { CodemodSetMissing, codemodsCrossing, readCodemodSet } from "./set.ts";

/**
 * The resolution mechanism, which is the part of the upgrade path that is expensive to get
 * wrong.
 *
 * The set kobai ships today is empty, so nothing here can be proved by running the real one.
 * These fixtures are how the mechanism is tested without inventing a breaking change for it
 * to migrate — and they are *not* a substitute for the gate: `tests/the-upgrade-gate.test.ts`
 * runs the shipped command against a real Project across a real version bump, and what it
 * proves is that the command finds and reports the shipped set. What it cannot prove, until
 * a real codemod exists, is that a codemod runs. This file is where that is nailed down.
 */

function fake(id: string, introducedIn: string): Codemod {
  return {
    id,
    title: `Does ${id}`,
    introducedIn,
    apply: async () => [`${id}.txt`],
  };
}

describe("the codemods a version bump has to run", () => {
  it("takes everything introduced after where the Project is and up to where it is going", () => {
    const set = [fake("a", "1.0.0"), fake("b", "2.0.0"), fake("c", "3.0.0")];

    expect(codemodsCrossing(set, "1.0.0", "2.0.0").map((c) => c.id)).toEqual(["b"]);
  });

  it("runs several majors' worth in one hop, in release order", () => {
    // The reason a codemod is keyed to the version that introduced it rather than to a
    // `from → to` pair: nobody enumerated 0.1.0 → 3.0.0, and it works anyway.
    const set = [fake("third", "3.0.0"), fake("first", "1.0.0"), fake("second", "2.0.0")];

    expect(codemodsCrossing(set, "0.1.0", "3.0.0").map((c) => c.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("excludes where the Project already is and includes where it is going", () => {
    // A Project on 1.0.0 has already run 1.0.0's codemods; one arriving at 2.0.0 has not.
    const set = [fake("at-from", "1.0.0"), fake("at-to", "2.0.0")];

    expect(codemodsCrossing(set, "1.0.0", "2.0.0").map((c) => c.id)).toEqual(["at-to"]);
  });

  it("orders two codemods introduced by the same version by id, so a run is repeatable", () => {
    const set = [fake("b", "2.0.0"), fake("a", "2.0.0")];

    expect(codemodsCrossing(set, "1.0.0", "2.0.0").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("finds nothing when a Project is already where it is going", () => {
    const set = [fake("a", "1.0.0")];

    expect(codemodsCrossing(set, "1.0.0", "1.0.0")).toEqual([]);
  });

  it("refuses a version it cannot order rather than silently skipping a codemod", () => {
    expect(() => codemodsCrossing([], "1.0.0", "2.0.0-rc.1")).toThrow(/prerelease/);
  });
});

describe("the set this version of Core ships", () => {
  it("is empty, which is the honest state at 0.1.0", () => {
    // If this ever fails, kobai has shipped its first codemod and the gate stops being a
    // test of an empty boundary. That is a good day, and this line is where it is noticed.
    expect(codemods).toEqual([]);
  });
});

describe("reading a set that a newer version shipped", () => {
  it("accepts one written to the format this runner understands", () => {
    const set = [fake("a", "1.0.0")];

    expect(
      readCodemodSet({ CODEMOD_SET_FORMAT, codemods: set }, "@kobai/core@1.0.0"),
    ).toEqual(set);
  });

  it("accepts an empty one, because empty and missing are different answers", () => {
    expect(readCodemodSet({ CODEMOD_SET_FORMAT, codemods: [] }, "x")).toEqual([]);
  });

  it("refuses a format it does not understand rather than reporting no codemods", () => {
    // The bootstrap failure worth naming: an old runner meeting a new contract must not
    // report success having applied nothing.
    expect(() =>
      readCodemodSet({ CODEMOD_SET_FORMAT: 99, codemods: [] }, "@kobai/core@9.0.0"),
    ).toThrow(/format 99/);
  });

  it("refuses a module that exports no set at all", () => {
    expect(() => readCodemodSet({ CODEMOD_SET_FORMAT }, "@kobai/core@1.0.0")).toThrow(
      /no `codemods` array/,
    );
  });

  it("refuses a codemod whose version cannot be ordered, naming it", () => {
    expect(() =>
      readCodemodSet(
        { CODEMOD_SET_FORMAT, codemods: [fake("bad-one", "one-point-oh")] },
        "x",
      ),
    ).toThrow(/bad-one/);
  });

  it("refuses with an error the command must not survive", () => {
    // `CodemodSetMissing` is the only load failure `upgradeProject` may report and continue
    // from. Everything here is a set that exists and is wrong about itself, and reporting
    // "no codemods" for one of those would be indistinguishable from the ordinary answer.
    for (const wrong of [
      { CODEMOD_SET_FORMAT: 99, codemods: [] },
      { CODEMOD_SET_FORMAT },
      { CODEMOD_SET_FORMAT, codemods: [fake("bad-one", "one-point-oh")] },
    ]) {
      let thrown: unknown;
      try {
        readCodemodSet(wrong, "x");
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CodemodSetMissing);
    }
  });
});

/**
 * **What the compiler refuses to accept as a codemod** (#127).
 *
 * `apply` is a property holding a function rather than a method, so a codemod that demands more
 * than the runner hands it does not compile. Nothing outside Core declares a `Codemod` today, so
 * this is the pin that keeps the shape safe until something does. The assertion is the
 * `@ts-expect-error`, run by the `typecheck` step of the gate rather than by vitest; the `expect`
 * only keeps the block a test.
 */
describe("what could not have been a codemod", () => {
  it("rejects one that demands more of the Project than the runner hands it", () => {
    // The intersection is the honest probe. Bivariance rescues an implementation only when one
    // direction is assignable, so a parameter type that overlapped `ProjectUnderUpgrade` in
    // neither direction would be refused under either spelling and prove nothing.
    const nosy: Codemod = {
      id: "1.0.0-nosy",
      title: "Reads where the Project came from",
      introducedIn: "1.0.0",
      // @ts-expect-error the runner hands over a directory, and `introducedIn` is the whole of
      // what a codemod may know about the boundary it is crossing.
      apply: async (project: ProjectUnderUpgrade & { kobaiVersion: string }) => [
        `${project.directory}/${project.kobaiVersion}.txt`,
      ],
    };

    expect(nosy).toBeDefined();
  });
});
