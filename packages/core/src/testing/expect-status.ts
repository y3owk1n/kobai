/**
 * The status a helper's own request must have answered with, or a failure that says what did.
 *
 * Every helper here arranges through the public API, so every one of them makes requests a
 * test never sees. When one of those fails, the test fails later and somewhere else — on an
 * empty body, a missing id, a 404 for a Variant that was never created — and the arrangement
 * is the last place anybody looks. This turns that into one error naming the request, the
 * status it wanted and the body it got.
 *
 * Not exported from `index.ts`: it is how the harness talks to itself, not something a test
 * asserts with. A test asserting on a status has `expect(response.status)`.
 */
export async function expectStatus(
  response: Response,
  status: number,
  /** What was being attempted, as a phrase: "creating a Product", "pricing POSTER-A2 at 1250". */
  what: string,
): Promise<unknown> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status !== status) {
    throw new Error(
      `${what} answered ${response.status}, expected ${status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}
