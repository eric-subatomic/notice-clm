import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidVerifiedIdentityError,
  normalizeVerifiedDisplayName,
  normalizeVerifiedEmail,
  normalizeVerifiedSubject,
  readTrustedHeaderIdentity,
} from "../app/lib/identity";

function trustedHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    "x-notice-identity-subject": "issuer-stable-user-123",
    "x-notice-identity-email": " Legal.User@Orchid.test ",
    "x-notice-identity-name": "Orchid%20Legal%20User",
    "x-notice-identity-name-encoding": "percent-encoded-utf-8",
    ...overrides,
  });
}

function rejectsTrustedIdentity(headers: Headers): void {
  assert.throws(
    () => readTrustedHeaderIdentity(headers),
    (error) => error instanceof InvalidVerifiedIdentityError,
  );
}

test("trusted-header identity is normalized once and namespaced to the reviewed edge", () => {
  assert.deepEqual(readTrustedHeaderIdentity(trustedHeaders()), {
    subject: "issuer-stable-user-123",
    email: "legal.user@orchid.test",
    displayName: "Orchid Legal User",
  });

  const withoutName = trustedHeaders();
  withoutName.delete("x-notice-identity-name");
  withoutName.delete("x-notice-identity-name-encoding");
  assert.equal(readTrustedHeaderIdentity(withoutName)?.displayName, "legal.user@orchid.test");
  assert.equal(readTrustedHeaderIdentity(new Headers()), null);
});

test("verified identity normalizers enforce exact subject and bounded email/name fields", () => {
  assert.equal(normalizeVerifiedSubject("s".repeat(512)), "s".repeat(512));
  assert.equal(normalizeVerifiedSubject("s".repeat(513)), null);
  assert.equal(normalizeVerifiedSubject(" subject"), null);
  assert.equal(normalizeVerifiedSubject("subject suffix"), null);
  assert.equal(normalizeVerifiedSubject("subject\u0085suffix"), null);

  const longestLocal = "l".repeat(64);
  assert.equal(normalizeVerifiedEmail(`${longestLocal}@orchid.test`), `${longestLocal}@orchid.test`);
  assert.equal(normalizeVerifiedEmail(`${"l".repeat(65)}@orchid.test`), null);
  assert.equal(normalizeVerifiedEmail(`legal@${"a".repeat(64)}.test`), null);
  assert.equal(normalizeVerifiedEmail("legal\nadmin@orchid.test"), null);
  assert.equal(normalizeVerifiedEmail("\tlegal@orchid.test"), null);

  assert.equal(normalizeVerifiedDisplayName(` ${"N".repeat(200)} `), "N".repeat(200));
  assert.equal(normalizeVerifiedDisplayName("N".repeat(201)), null);
  assert.equal(normalizeVerifiedDisplayName("Alice\r\nAdministrator: Bob"), null);
  assert.equal(normalizeVerifiedDisplayName("Alice\u202eBob"), null);
});

test("trusted headers reject partial, malformed, control-bearing, and oversized identity input", () => {
  const missingSubject = trustedHeaders();
  missingSubject.delete("x-notice-identity-subject");
  rejectsTrustedIdentity(missingSubject);

  const whitespaceSubject = trustedHeaders({ "x-notice-identity-subject": "issuer subject" });
  rejectsTrustedIdentity(whitespaceSubject);

  const oversizedSubject = trustedHeaders({ "x-notice-identity-subject": "s".repeat(513) });
  rejectsTrustedIdentity(oversizedSubject);

  const oversizedEmail = trustedHeaders({ "x-notice-identity-email": `${"l".repeat(65)}@orchid.test` });
  rejectsTrustedIdentity(oversizedEmail);

  for (const encodedName of ["Alice%0D%0AAdministrator%3A%20Bob", "%", "N".repeat(201)]) {
    rejectsTrustedIdentity(trustedHeaders({ "x-notice-identity-name": encodedName }));
  }

  rejectsTrustedIdentity(trustedHeaders({ "x-notice-identity-name-encoding": "base64" }));

  const orphanedEncoding = trustedHeaders();
  orphanedEncoding.delete("x-notice-identity-name");
  rejectsTrustedIdentity(orphanedEncoding);

  const orphanedName = trustedHeaders();
  orphanedName.delete("x-notice-identity-name-encoding");
  rejectsTrustedIdentity(orphanedName);
});
