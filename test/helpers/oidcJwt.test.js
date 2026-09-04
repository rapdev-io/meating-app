const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const { verifyIdToken, OidcVerificationError } = require("../../src/helpers/oidcJwt");

const ISSUER = "https://idp.example.test/";
const AUDIENCE = "test-client-id";
const KID = "test-key-1";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signJwt(payload, { privateKey, kid = KID, alg = "RS256", header = {} } = {}) {
  const fullHeader = { alg, typ: "JWT", kid, ...header };
  const signingInput = `${base64url(JSON.stringify(fullHeader))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, jwks: { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] } };
}

function basePayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user-123",
    email: "person@company.example",
    name: "Person Example",
    nonce: "expected-nonce",
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

test("accepts a validly signed token matching issuer, audience, and nonce", () => {
  const { privateKey, jwks } = makeKeyPair();
  const token = signJwt(basePayload(), { privateKey });

  const claims = verifyIdToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "expected-nonce" });
  assert.equal(claims.sub, "user-123");
  assert.equal(claims.email, "person@company.example");
});

test("rejects a token whose signature does not match the JWKS key", () => {
  const { jwks } = makeKeyPair();
  const { privateKey: otherPrivateKey } = makeKeyPair(); // different keypair, same kid claimed
  const token = signJwt(basePayload(), { privateKey: otherPrivateKey });

  assert.throws(
    () => verifyIdToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "expected-nonce" }),
    (error) => error instanceof OidcVerificationError && error.code === "INVALID_SIGNATURE"
  );
});

test("rejects an unexpected issuer", () => {
  const { privateKey, jwks } = makeKeyPair();
  const token = signJwt(basePayload({ iss: "https://not-the-idp.example.test/" }), { privateKey });

  assert.throws(
    () => verifyIdToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "expected-nonce" }),
    (error) => error instanceof OidcVerificationError && error.code === "ISSUER_MISMATCH"
  );
});

test("rejects a token issued for a different audience/client", () => {
  const { privateKey, jwks } = makeKeyPair();
  const token = signJwt(basePayload({ aud: "some-other-client" }), { privateKey });

  assert.throws(
    () => verifyIdToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "expected-nonce" }),
    (error) => error instanceof OidcVerificationError && error.code === "AUDIENCE_MISMATCH"
  );
});

test("rejects an expired token", () => {
  const { privateKey, jwks } = makeKeyPair();
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(basePayload({ iat: now - 7200, exp: now - 3600 }), { privateKey });

  assert.throws(
    () => verifyIdToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "expected-nonce" }),
    (error) => error instanceof OidcVerificationError && error.code === "TOKEN_EXPIRED"
  );
});

test("rejects a nonce that does not match the request", () => {
  const { privateKey, jwks } = makeKeyPair();
  const token = signJwt(basePayload({ nonce: "attacker-supplied-nonce" }), { privateKey });

  assert.throws(
    () => verifyIdToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "expected-nonce" }),
    (error) => error instanceof OidcVerificationError && error.code === "NONCE_MISMATCH"
  );
});

test("enforces an allowed email domain restriction", () => {
  const { privateKey, jwks } = makeKeyPair();
  const outsideDomain = signJwt(basePayload({ email: "person@other-company.example" }), { privateKey });
  const insideDomain = signJwt(basePayload({ email: "person@company.example" }), { privateKey });

  assert.throws(
    () =>
      verifyIdToken(outsideDomain, {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
        nonce: "expected-nonce",
        allowedDomain: "company.example",
      }),
    (error) => error instanceof OidcVerificationError && error.code === "DOMAIN_NOT_ALLOWED"
  );

  assert.doesNotThrow(() =>
    verifyIdToken(insideDomain, {
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: "expected-nonce",
      allowedDomain: "company.example",
    })
  );
});

test("rejects an unverified email even if the domain matches", () => {
  const { privateKey, jwks } = makeKeyPair();
  const token = signJwt(
    basePayload({ email: "person@company.example", email_verified: false }),
    { privateKey }
  );

  assert.throws(
    () =>
      verifyIdToken(token, {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
        nonce: "expected-nonce",
        allowedDomain: "company.example",
      }),
    (error) => error instanceof OidcVerificationError && error.code === "EMAIL_NOT_VERIFIED"
  );
});

test("enforces an allowed tenant restriction on a configurable claim", () => {
  const { privateKey, jwks } = makeKeyPair();
  const wrongTenant = signJwt(basePayload({ tid: "tenant-b" }), { privateKey });
  const rightTenant = signJwt(basePayload({ tid: "tenant-a" }), { privateKey });

  assert.throws(
    () =>
      verifyIdToken(wrongTenant, {
        jwks,
        issuer: ISSUER,
        audience: AUDIENCE,
        nonce: "expected-nonce",
        allowedTenant: "tenant-a",
        tenantClaim: "tid",
      }),
    (error) => error instanceof OidcVerificationError && error.code === "TENANT_NOT_ALLOWED"
  );

  assert.doesNotThrow(() =>
    verifyIdToken(rightTenant, {
      jwks,
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: "expected-nonce",
      allowedTenant: "tenant-a",
      tenantClaim: "tid",
    })
  );
});

test("rejects an unsupported algorithm such as none/HS256", () => {
  const { jwks } = makeKeyPair();
  const header = { alg: "none", typ: "JWT", kid: KID };
  const payload = basePayload();
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const token = `${signingInput}.`;

  assert.throws(
    () => verifyIdToken(token, { jwks, issuer: ISSUER, audience: AUDIENCE, nonce: "expected-nonce" }),
    (error) => error instanceof OidcVerificationError && error.code === "UNSUPPORTED_ALG"
  );
});
