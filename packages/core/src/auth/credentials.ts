import { hash, verify } from "@node-rs/argon2";

/**
 * Passwords, one way only.
 *
 * argon2id, through a reviewed implementation rather than anything assembled here. The
 * parameters are the library's defaults, which follow the OWASP recommendation; they are not
 * tuned, and a deployment that wants them tuned is a decision nobody has asked for yet.
 *
 * The property this module exists to hold is that a Merchant's password is never recoverable
 * from anything kobai stores. A digest is not a reversible encoding of the password, it
 * carries its own salt, and it is deliberately slow, so a stolen `core_merchant` row is not a
 * stolen credential.
 */

/**
 * Long enough that a Merchant cannot pick something a wordlist already holds, and no upper
 * bound beyond argon2's own: composition rules push people towards `Password1!`, and length
 * is the property that actually matters.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/**
 * Whether `password` produced `digest`.
 *
 * A malformed digest answers `false` rather than throwing: the caller's question is "may this
 * person in", and the answer to that is no however unreadable the stored value turns out to
 * be.
 */
export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password);
  } catch {
    return false;
  }
}

/**
 * A digest of a password nobody has. Verified against when no Merchant holds the email that
 * was offered, so an unknown address costs the same time as a wrong password — otherwise the
 * sign-in endpoint answers "does this Merchant exist" to anyone with a stopwatch.
 *
 * Computed once, lazily, because argon2 is slow on purpose and this must not delay boot.
 */
let absentMerchantDigest: Promise<string> | undefined;

export function digestOfNoMerchant(): Promise<string> {
  absentMerchantDigest ??= hashPassword("no merchant holds this address");
  return absentMerchantDigest;
}
