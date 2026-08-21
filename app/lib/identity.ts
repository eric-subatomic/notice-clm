const MAX_SUBJECT_LENGTH = 512;
const MAX_EMAIL_LENGTH = 254;
const MAX_EMAIL_LOCAL_PART_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_ENCODED_DISPLAY_NAME_LENGTH = 2_400;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const BIDI_CONTROL_CHARACTERS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const TRUSTED_USER_ID_HEADER = "x-notice-identity-subject";
const TRUSTED_USER_EMAIL_HEADER = "x-notice-identity-email";
const TRUSTED_USER_FULL_NAME_HEADER = "x-notice-identity-name";
const TRUSTED_USER_FULL_NAME_ENCODING_HEADER = "x-notice-identity-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";

export class InvalidVerifiedIdentityError extends Error {
  constructor() {
    super("The verified identity is incomplete or invalid.");
    this.name = "InvalidVerifiedIdentityError";
  }
}

export type TrustedHeaderIdentity = Readonly<{
  subject: string;
  email: string;
  displayName: string;
}>;

/** Normalize a stable, issuer-scoped identity subject without changing its value. */
export function normalizeVerifiedSubject(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SUBJECT_LENGTH) return null;
  if (
    value !== value.trim()
    || /\s/u.test(value)
    || CONTROL_CHARACTERS.test(value)
    || BIDI_CONTROL_CHARACTERS.test(value)
  ) return null;
  return value;
}

/** Normalize an IdP-verified email while enforcing practical RFC length limits. */
export function normalizeVerifiedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (CONTROL_CHARACTERS.test(value) || BIDI_CONTROL_CHARACTERS.test(value)) return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  const separator = email.lastIndexOf("@");
  if (separator < 1 || separator > MAX_EMAIL_LOCAL_PART_LENGTH) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

/** Normalize a human-readable identity label before persistence or audit use. */
export function normalizeVerifiedDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (CONTROL_CHARACTERS.test(value) || BIDI_CONTROL_CHARACTERS.test(value)) return null;
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_LENGTH) return null;
  return name;
}

/**
 * Parse the exact compatibility-edge header contract. A present-but-invalid
 * identity fails closed; only a completely absent identity returns null.
 */
export function readTrustedHeaderIdentity(headers: Headers): TrustedHeaderIdentity | null {
  const rawSubject = headers.get(TRUSTED_USER_ID_HEADER);
  const rawEmail = headers.get(TRUSTED_USER_EMAIL_HEADER);
  const encodedName = headers.get(TRUSTED_USER_FULL_NAME_HEADER);
  const nameEncoding = headers.get(TRUSTED_USER_FULL_NAME_ENCODING_HEADER);

  if (rawSubject === null && rawEmail === null && encodedName === null && nameEncoding === null) return null;

  const subject = normalizeVerifiedSubject(rawSubject);
  const email = normalizeVerifiedEmail(rawEmail);
  if (!subject || !email) throw new InvalidVerifiedIdentityError();

  let displayName = email;
  if (encodedName !== null || nameEncoding !== null) {
    if (
      !encodedName
      || encodedName.length > MAX_ENCODED_DISPLAY_NAME_LENGTH
      || nameEncoding !== PERCENT_ENCODED_UTF8
    ) throw new InvalidVerifiedIdentityError();
    try {
      const normalized = normalizeVerifiedDisplayName(decodeURIComponent(encodedName));
      if (!normalized) throw new InvalidVerifiedIdentityError();
      displayName = normalized;
    } catch (error) {
      if (error instanceof InvalidVerifiedIdentityError) throw error;
      throw new InvalidVerifiedIdentityError();
    }
  }

  return Object.freeze({ subject, email, displayName });
}
