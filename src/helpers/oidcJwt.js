const crypto = require("crypto");

// Minimal, dependency-free JWT/JWKS verification for OIDC ID tokens.
// Deliberately narrow: only what a company OIDC sign-in needs (RS256/PS256/ES256
// signature verification against a JWKS document, plus the standard OIDC claim
// checks). No JWE/encryption support, no HS256 (a public desktop client never
// holds a shared secret, so an HMAC-signed token can't be trusted anyway).

const SUPPORTED_ALGS = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"]);

const ES_CURVE_BY_ALG = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };

class OidcVerificationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function base64urlToBuffer(input) {
  return Buffer.from(input, "base64url");
}

function decodeJwt(token) {
  if (typeof token !== "string" || !token) {
    throw new OidcVerificationError("MALFORMED_TOKEN", "Token is empty or not a string");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new OidcVerificationError("MALFORMED_TOKEN", "Token does not have three segments");
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  let header, payload;
  try {
    header = JSON.parse(base64urlToBuffer(headerB64).toString("utf8"));
    payload = JSON.parse(base64urlToBuffer(payloadB64).toString("utf8"));
  } catch {
    throw new OidcVerificationError("MALFORMED_TOKEN", "Token header/payload is not valid JSON");
  }
  return {
    header,
    payload,
    signingInput: `${headerB64}.${payloadB64}`,
    signature: base64urlToBuffer(signatureB64),
  };
}

function findJwk(jwks, header) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  if (header.kid) {
    const byKid = keys.find((k) => k.kid === header.kid);
    if (byKid) return byKid;
  }
  // Fall back to a single matching-use key when the provider omits kid
  // (some minimal test IdPs do); never guess across multiple candidates.
  const candidates = keys.filter((k) => !k.use || k.use === "sig");
  return candidates.length === 1 ? candidates[0] : null;
}

function verifySignature(token, jwks) {
  const { header, signingInput, signature } = decodeJwt(token);
  if (!SUPPORTED_ALGS.has(header.alg)) {
    throw new OidcVerificationError("UNSUPPORTED_ALG", `Unsupported ID token algorithm: ${header.alg}`);
  }
  const jwk = findJwk(jwks, header);
  if (!jwk) {
    throw new OidcVerificationError("KEY_NOT_FOUND", `No JWKS key found for kid=${header.kid}`);
  }
  if (header.alg.startsWith("ES") && jwk.crv !== ES_CURVE_BY_ALG[header.alg]) {
    throw new OidcVerificationError("KEY_MISMATCH", "JWKS key curve does not match token algorithm");
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  } catch (error) {
    throw new OidcVerificationError("KEY_IMPORT_FAILED", `Failed to import JWKS key: ${error.message}`);
  }

  const digest = `sha${header.alg.slice(2)}`;
  const signingBuffer = Buffer.from(signingInput, "utf8");
  let ok;
  try {
    if (header.alg.startsWith("ES")) {
      ok = crypto.verify(digest, signingBuffer, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    } else if (header.alg.startsWith("PS")) {
      ok = crypto.verify(
        digest,
        signingBuffer,
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        signature
      );
    } else {
      ok = crypto.verify(digest, signingBuffer, publicKey, signature);
    }
  } catch (error) {
    throw new OidcVerificationError("SIGNATURE_CHECK_FAILED", error.message);
  }

  if (!ok) {
    throw new OidcVerificationError("INVALID_SIGNATURE", "ID token signature verification failed");
  }
}

// clockToleranceSec absorbs small drift between this machine's clock and the
// IdP's; 60s is generous enough for real-world skew without weakening exp checks.
function validateClaims(payload, { issuer, audience, nonce, clockToleranceSec = 60 } = {}) {
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.iss !== "string" || payload.iss !== issuer) {
    throw new OidcVerificationError("ISSUER_MISMATCH", `Unexpected issuer: ${payload.iss}`);
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) {
    throw new OidcVerificationError("AUDIENCE_MISMATCH", `Token audience does not include ${audience}`);
  }

  if (typeof payload.exp !== "number" || now > payload.exp + clockToleranceSec) {
    throw new OidcVerificationError("TOKEN_EXPIRED", "ID token has expired");
  }

  if (typeof payload.nbf === "number" && now + clockToleranceSec < payload.nbf) {
    throw new OidcVerificationError("TOKEN_NOT_YET_VALID", "ID token is not yet valid");
  }

  if (typeof payload.iat === "number" && payload.iat > now + clockToleranceSec) {
    throw new OidcVerificationError("TOKEN_ISSUED_IN_FUTURE", "ID token iat is in the future");
  }

  if (nonce && payload.nonce !== nonce) {
    throw new OidcVerificationError("NONCE_MISMATCH", "ID token nonce does not match the request");
  }
}

// Enforces the configured tenant/domain restriction. tenantClaim (e.g. "tid" for
// Entra ID) is checked verbatim; domainClaim (default "email") is checked by
// splitting on "@" — both are optional and skipped when unconfigured.
function validateOrgRestriction(payload, { allowedTenant, tenantClaim, allowedDomain, domainClaim } = {}) {
  if (allowedTenant) {
    const claimName = tenantClaim || "tid";
    if (payload[claimName] !== allowedTenant) {
      throw new OidcVerificationError(
        "TENANT_NOT_ALLOWED",
        `Token ${claimName} (${payload[claimName]}) does not match the configured tenant`
      );
    }
  }

  if (allowedDomain) {
    // Google (and others) mark an unverified email address with
    // email_verified: false — an unverified address can't be trusted to
    // prove domain membership. Providers that omit the claim entirely aren't
    // penalized; only an explicit false fails closed.
    if (payload.email_verified === false) {
      throw new OidcVerificationError(
        "EMAIL_NOT_VERIFIED",
        "Account email is not verified by the identity provider"
      );
    }

    const claimName = domainClaim || "email";
    const claimValue = typeof payload[claimName] === "string" ? payload[claimName] : "";
    const domain = claimValue.split("@")[1]?.toLowerCase();
    if (domain !== allowedDomain.toLowerCase()) {
      throw new OidcVerificationError(
        "DOMAIN_NOT_ALLOWED",
        `Account domain (${domain || "unknown"}) is not in the allowed organization`
      );
    }
  }
}

function verifyIdToken(idToken, options) {
  const { jwks, issuer, audience, nonce, clockToleranceSec, allowedTenant, tenantClaim, allowedDomain, domainClaim } =
    options || {};
  verifySignature(idToken, jwks);
  const { payload } = decodeJwt(idToken);
  validateClaims(payload, { issuer, audience, nonce, clockToleranceSec });
  validateOrgRestriction(payload, { allowedTenant, tenantClaim, allowedDomain, domainClaim });
  return payload;
}

module.exports = {
  OidcVerificationError,
  decodeJwt,
  verifySignature,
  validateClaims,
  validateOrgRestriction,
  verifyIdToken,
};
