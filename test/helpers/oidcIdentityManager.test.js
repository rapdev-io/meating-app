const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/oidcIdentityManager.js");
const originalLoad = Module._load;

function withElectronMock(userDataDir, fn) {
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => userDataDir,
          isPackaged: false,
          isReady: () => false,
          getVersion: () => "0.0.0-test",
          getAppPath: () => userDataDir,
        },
        net: { fetch: async () => ({ ok: true, text: async () => "{}" }) },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (s) => Buffer.from(`enc:${s}`),
          decryptString: (b) => b.toString().replace(/^enc:/, ""),
        },
      };
    }
    // Real secretCrypto reaches into the OS keychain (@napi-rs/keyring) —
    // never exercise that from a test. A trivial reversible encoding is
    // enough to verify oidcIdentityManager persists/reads through it.
    if (request === "./secretCrypto") {
      return {
        isAvailable: () => true,
        encrypt: (plaintext) => Buffer.from(Buffer.from(plaintext, "utf8").toString("base64")),
        decrypt: (blob) => ({
          value: Buffer.from(blob.toString(), "base64").toString("utf8"),
          needsReencrypt: false,
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[managerModulePath];
    const OidcIdentityManager = require(managerModulePath);
    return fn(OidcIdentityManager);
  } finally {
    Module._load = originalLoad;
    delete require.cache[managerModulePath];
  }
}

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, jwks: { keys: [{ ...jwk, kid: "k1", use: "sig", alg: "RS256" }] } };
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signIdToken(payload, privateKey) {
  const header = { alg: "RS256", typ: "JWT", kid: "k1" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function withTempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oidc-identity-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(t, vars) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    process.env[key] = vars[key];
  }
  t.after(() => {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("isConfigured() is false until both issuer and client id are set", (t) => {
  const dir = withTempUserData(t);
  withEnv(t, { OIDC_ISSUER_URL: "", OIDC_CLIENT_ID: "" });
  withElectronMock(dir, (OidcIdentityManager) => {
    const manager = new OidcIdentityManager();
    assert.equal(manager.isConfigured(), false);
  });
});

test("isConfigured() is true once both are set to real values", (t) => {
  const dir = withTempUserData(t);
  withEnv(t, { OIDC_ISSUER_URL: "https://idp.example.test", OIDC_CLIENT_ID: "abc123" });
  withElectronMock(dir, (OidcIdentityManager) => {
    const manager = new OidcIdentityManager();
    assert.equal(manager.isConfigured(), true);
  });
});

test("signIn() verifies the id_token and persists a session across the class's own storage", async (t) => {
  const dir = withTempUserData(t);
  withEnv(t, { OIDC_ISSUER_URL: "https://idp.example.test", OIDC_CLIENT_ID: "abc123" });
  await withElectronMock(dir, async (OidcIdentityManager) => {
    const manager = new OidcIdentityManager();
    const { privateKey, jwks } = makeKeyPair();

    manager._discover = async () => ({
      issuer: "https://idp.example.test",
      authorization_endpoint: "https://idp.example.test/authorize",
      token_endpoint: "https://idp.example.test/token",
      jwks_uri: "https://idp.example.test/jwks",
    });
    manager._jwks = async () => jwks;

    let capturedNonce;
    manager._runLoopback = async ({ buildAuthUrl }) => {
      const url = new URL(buildAuthUrl("http://127.0.0.1:0/callback"));
      capturedNonce = url.searchParams.get("nonce");
      return { code: "test-code", redirectUri: "http://127.0.0.1:0/callback" };
    };
    manager._exchangeCode = async () => {
      const now = Math.floor(Date.now() / 1000);
      return {
        access_token: "at",
        refresh_token: "rt-1",
        id_token: signIdToken(
          {
            iss: "https://idp.example.test",
            aud: "abc123",
            sub: "user-1",
            email: "person@company.example",
            name: "Person",
            nonce: capturedNonce,
            iat: now,
            exp: now + 3600,
          },
          privateKey
        ),
      };
    };

    let sessionChangedCount = 0;
    manager.on("session-changed", () => (sessionChangedCount += 1));

    const result = await manager.signIn();
    assert.equal(result.success, true);
    assert.equal(result.user.email, "person@company.example");
    assert.equal(sessionChangedCount, 1);

    // Refresh token is persisted encrypted on disk, not held as plaintext.
    const refreshTokenPath = path.join(dir, "sso", "refresh-token.enc");
    assert.ok(fs.existsSync(refreshTokenPath));
    const onDisk = fs.readFileSync(refreshTokenPath, "utf8");
    assert.ok(!onDisk.includes("rt-1"), "raw refresh token must not appear in the persisted file");

    const session = await manager.getSession();
    assert.equal(session.user.email, "person@company.example");
    assert.equal(session.offlineGrace, false);
  });
});

test("getSession() falls back to the offline grace window when refresh fails, then locks after it expires", async (t) => {
  const dir = withTempUserData(t);
  withEnv(t, {
    OIDC_ISSUER_URL: "https://idp.example.test",
    OIDC_CLIENT_ID: "abc123",
    SSO_OFFLINE_GRACE_MS: "1000",
  });
  await withElectronMock(dir, async (OidcIdentityManager) => {
    const manager = new OidcIdentityManager();

    // Seed persisted state as if a previous run signed in and then went offline
    // (no in-memory session, no live refresh token — only what's on disk).
    await manager._persistRefreshToken("rt-1");
    const lastValidatedAt = Date.now() - 500; // 500ms ago, within the 1000ms grace window
    await manager._persistSessionMeta({
      user: { id: "user-1", sub: "user-1", email: "person@company.example", name: "Person" },
      idTokenExpiresAt: lastValidatedAt + 60 * 1000,
      lastValidatedAt,
    });

    // Refresh attempts fail outright (offline).
    manager._discover = async () => {
      throw new Error("network unreachable");
    };

    const withinGrace = await manager.getSession();
    assert.ok(withinGrace, "session should be reconstructed from cache while within the grace period");
    assert.equal(withinGrace.offlineGrace, true);
    assert.equal(withinGrace.user.email, "person@company.example");

    // Move the clock forward past the configured grace window by rewriting
    // the persisted lastValidatedAt further into the past.
    await manager._persistSessionMeta({
      user: { id: "user-1", sub: "user-1", email: "person@company.example", name: "Person" },
      idTokenExpiresAt: lastValidatedAt,
      lastValidatedAt: Date.now() - 5000,
    });

    const afterGrace = await manager.getSession();
    assert.equal(afterGrace, null);
  });
});

test("signOut() clears the persisted refresh token and session metadata", async (t) => {
  const dir = withTempUserData(t);
  withEnv(t, { OIDC_ISSUER_URL: "https://idp.example.test", OIDC_CLIENT_ID: "abc123" });
  await withElectronMock(dir, async (OidcIdentityManager) => {
    const manager = new OidcIdentityManager();
    await manager._persistRefreshToken("rt-1");
    await manager._persistSessionMeta({
      user: { id: "u", sub: "u", email: "a@b.com", name: "A" },
      idTokenExpiresAt: Date.now() + 60000,
      lastValidatedAt: Date.now(),
    });

    await manager.signOut();

    assert.equal(fs.existsSync(path.join(dir, "sso", "refresh-token.enc")), false);
    assert.equal(fs.existsSync(path.join(dir, "sso", "session-meta.json")), false);
    assert.equal(await manager.getSession(), null);
  });
});
