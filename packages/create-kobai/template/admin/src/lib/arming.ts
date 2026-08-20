/**
 * Whether the Playground has been armed to send something other than a `GET` on the Session.
 *
 * **An affordance and never a boundary** (ADR-0081, ADR-0063). Nothing here decides what a
 * Merchant may do — `requirePermission` in Core does, and the Playground sends real requests at
 * a real deployment whatever this says. What arming stops is an *experiment* becoming a
 * mutation by accident: the Session is the credential nobody had to type, carrying the Role the
 * Merchant actually works with, against the real Store. A key a Developer pasted or the Admin's
 * own publishable one needs no guard at all — reaching for one is a deliberate act every time,
 * and ceremony around the safe case is how a safety feature gets removed from the dangerous one.
 *
 * It lasts the **session** rather than the render, which is why it is `sessionStorage` and not a
 * `useState`: a Developer who armed the Playground and then refreshed to re-read a description
 * has not changed their mind. `lib/session.tsx` forgets it on the way out, beside the preview
 * key, because arming was granted on a Merchant's session and the next person to sign in at
 * this browser is not necessarily that Merchant.
 *
 * Nothing secret is stored here and nothing could be: the value is a flag.
 */
const ARMED = "kobai.admin.playground-armed";

export function isArmed(): boolean {
  return window.sessionStorage.getItem(ARMED) !== null;
}

export function arm(): void {
  window.sessionStorage.setItem(ARMED, "yes");
}

export function disarm(): void {
  window.sessionStorage.removeItem(ARMED);
}
