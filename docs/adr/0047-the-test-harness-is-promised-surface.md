# The test harness is promised surface, and it is not a sixth Extension Point

`@kobai/core/testing` is covered by Core's semver promise. **Everything its index exports** —
the harness (`createTestKobai`), the credentials (`signInTestMerchant`, `createTestApiKey`),
the arrangement (`seedTestCatalog`), the inspectors (`inspectSchema`, `migrationSetUpTo`), and
every type, constant and default beside them — is something a Project or a Plugin author may
depend on, and a minor release may not break it. The index is the list; this ADR does not keep
a second one.

**The five Extension Points of [ADR-0003](./0003-the-extension-surface-and-what-we-promise.md)
stay five, and stay closed.** The harness is not one of them and is not becoming one: nothing
attaches to it at runtime, no Plugin registers against it, and no deployment runs a line of it.
It is a tool a Developer writes *tests* with, which is a different kind of thing from a place
Core is extended at — and saying so is cheaper than widening a list ADR-0003 calls a one-way
door.

## Why it needed saying at all

[ADR-0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md)
says semver covers those five "and nothing else", and it means it: a Core minor may freely
change any internal a Developer could technically reach. Read strictly, that put the harness
in the same bucket as an internal function — reachable, unpromised, changeable without notice.

But the harness is not reachable by accident. It is a **declared subpath export** of a
published package; `AGENTS.md` § Writing tests tells every test in this repository to reach for
it; and its own module comment says why it ships rather than staying private — "because a
Plugin author needs the same seam Core tests through". A surface that is exported, documented
and recommended is promised in every way except the one that matters when it breaks.

The immediate occasion is #52, which moved a catalog-seeding helper into it and asked for it to
be designed as public API rather than as whatever five call sites happened to share. That
request only makes sense if the answer to "may I depend on this?" is yes. So the decision was
already being taken by implication; this records it instead.

## What the promise covers, and what it does not

**Promised:** the names exported from `packages/core/src/testing/index.ts`, their signatures,
the shape of what they return, and the documented meaning of each — including defaults a test
may assert on, such as the Price `seedTestCatalog` seeds when a test names none.

**Not promised:**

- **How a helper does its work.** `seedTestCatalog` arranges through the public HTTP API today;
  the number, order and shape of the requests it makes are not part of the promise. A test that
  counted them would be asserting about the helper rather than about kobai.
- **Anything the harness merely exposes.** `TestKobai` carries `db` and `database`, which reach
  Core's schema — and the schema is explicitly unpromised (ADR-0003, ADR-0004). Reaching
  Postgres through the harness is not a way to make the reach supported.
- **The harness's own tests, or the fixtures inside them.**

## Consequences

- **Adding an export is a decision, not a convenience.** A helper that lands here must be
  designed as public API — the common case one line, the interesting case still expressible,
  and the arrangement a test is *about* never hidden. #52's `seedTestCatalog` is the worked
  example, and `AGENTS.md` § Writing tests is where the next one gets documented.
- **Renaming or removing one is a breaking change**, on the same footing as a change to a
  Workflow's declared Steps. That is a real constraint on Core's own refactoring, accepted
  because the alternative is worse: a harness that shifts under a Project between minors makes
  every upgrade unverifiable exactly when a Developer most needs to verify one.
- **"Test-only" is not "private".** Code under `packages/core/src/testing/` is shipped code and
  reviewed as such. Something genuinely internal to Core's own tests belongs beside the tests
  that use it, not in the harness's index.
- **ADR-0019's sentence now has an exception, and it is this one.** Nothing else has been
  added to what semver covers, and the next thing that wants to be needs its own ADR.

### Considered and rejected

- **Leave it unpromised and say so.** Honest, and it makes the harness useless to the audience
  it was shipped for: a Plugin author cannot write a test suite against a seam that may be
  renamed in a patch. It would also make #52's instruction — design it as public API —
  incoherent.
- **Make it a sixth Extension Point.** Tidier in one sense, and wrong in every other: ADR-0003's
  five are runtime attachment points that shape Core's architecture, and a test harness shapes
  nothing at runtime. Growing that list for this would blur what it means to be on it.
- **Publish a separate `@kobai/testing` package.** A cleaner boundary on paper. It doubles the
  release surface and the version-skew failure modes for one module that only ever moves with
  Core, and ADR-0025 already settled on one Core package with first-party Plugins as the split
  points.
