const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const EventEmitter = require("events");
const { app, net } = require("electron");
const debugLogger = require("./debugLogger");
const secretCrypto = require("./secretCrypto");
const { openExternalUrl } = require("./externalUrlOpener");
const { verifyIdToken, OidcVerificationError } = require("./oidcJwt");

// Placeholder config: a real deployment sets these via the persisted, non-secret
// env vars below (see PERSISTED_KEYS in environment.js) or a packaged .env.
// isConfigured() stays false until every placeholder is replaced, so a build
// shipped without real values fails closed into "SSO not configured" instead
// of trying (and failing) to talk to a fake issuer.
const PLACEHOLDER_ISSUER = "https://YOUR_OIDC_ISSUER_URL/";
const PLACEHOLDER_CLIENT_ID = "YOUR_OIDC_CLIENT_ID";

const DEFAULT_SCOPES = "openid email profile offline_access";
const DEFAULT_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DISCOVERY_CACHE_MS = 60 * 60 * 1000; // 1 hour
const LOOPBACK_TIMEOUT_MS = 120000;
const HTTP_TIMEOUT_MS = 10000;
const REFRESH_SKEW_MS = 60 * 1000; // refresh a little before actual expiry

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>
<style>body{font:15px -apple-system,Segoe UI,sans-serif;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;background:#0b0c0f;color:#eee}
.card{text-align:center;max-width:360px;padding:24px}</style></head>
<body><div class="card"><h2>Signed in</h2><p>You can close this tab and return to the app.</p></div></body></html>`;

const errorHtml = (message) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title>
<style>body{font:15px -apple-system,Segoe UI,sans-serif;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;background:#0b0c0f;color:#eee}
.card{text-align:center;max-width:420px;padding:24px}</style></head>
<body><div class="card"><h2>Sign-in failed</h2><p>${message}</p><p>You can close this tab and try again in the app.</p></div></body></html>`;

function base64url(buffer) {
  return buffer.toString("base64url");
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest();
}

class OidcSignInError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Standards-based OIDC (Authorization Code + PKCE) identity provider for the
// main process. Tokens never leave this module for the renderer: only the
// derived session (user info + expiry + offline-grace flag) crosses IPC.
//
// IdentityProvider surface: signIn(), signOut(), getSession(), refreshSession().
class OidcIdentityManager extends EventEmitter {
  constructor() {
    super();
    this._discoveryCache = null; // { doc, fetchedAt }
    this._jwksCache = null; // { jwks, fetchedAt }
    this._session = null; // in-memory: { user, idTokenExpiresAt, obtainedAt }
    this._refreshToken = null; // in-memory only; persisted encrypted on disk
    this._pendingSignIn = null; // in-flight signIn() promise, so concurrent calls share one flow
  }

  // ---- configuration ----------------------------------------------------

  getConfig() {
    const issuer = (process.env.OIDC_ISSUER_URL || PLACEHOLDER_ISSUER).trim();
    const clientId = (process.env.OIDC_CLIENT_ID || PLACEHOLDER_CLIENT_ID).trim();
    return {
      issuer: issuer.replace(/\/+$/, ""),
      clientId,
      // Optional: most OIDC providers issue public/native clients with no
      // secret (PKCE alone proves possession). Google's "Desktop app" client
      // type is a known exception — it still requires client_secret at the
      // token endpoint even for a PKCE loopback flow — so this stays opt-in
      // rather than assumed. Stored encrypted (see SECRET_KEYS), never shipped
      // in source.
      clientSecret: (process.env.OIDC_CLIENT_SECRET || "").trim() || null,
      scopes: process.env.OIDC_SCOPES || DEFAULT_SCOPES,
      allowedDomain: (process.env.OIDC_ALLOWED_DOMAIN || "").trim() || null,
      allowedTenant: (process.env.OIDC_ALLOWED_TENANT || "").trim() || null,
      tenantClaim: process.env.OIDC_TENANT_CLAIM || "tid",
      redirectPort: Number(process.env.OIDC_REDIRECT_PORT || 0) || 0,
      offlineGraceMs: Number(process.env.SSO_OFFLINE_GRACE_MS || DEFAULT_OFFLINE_GRACE_MS),
    };
  }

  isConfigured() {
    const { issuer, clientId } = this.getConfig();
    return issuer !== PLACEHOLDER_ISSUER.replace(/\/+$/, "") && clientId !== PLACEHOLDER_CLIENT_ID;
  }

  // ---- storage -----------------------------------------------------------

  _stateDir() {
    return path.join(app.getPath("userData"), "sso");
  }

  _refreshTokenPath() {
    return path.join(this._stateDir(), "refresh-token.enc");
  }

  _sessionMetaPath() {
    return path.join(this._stateDir(), "session-meta.json");
  }

  async _persistRefreshToken(refreshToken) {
    await fsPromises.mkdir(this._stateDir(), { recursive: true });
    if (!refreshToken) {
      await fsPromises.unlink(this._refreshTokenPath()).catch(() => {});
      return;
    }
    const encrypted = secretCrypto.encrypt(refreshToken);
    const tmp = `${this._refreshTokenPath()}.tmp`;
    await fsPromises.writeFile(tmp, encrypted, { mode: 0o600 });
    await fsPromises.rename(tmp, this._refreshTokenPath());
  }

  async _loadRefreshToken() {
    try {
      const buffer = await fsPromises.readFile(this._refreshTokenPath());
      return secretCrypto.decrypt(buffer).value;
    } catch {
      return null;
    }
  }

  async _persistSessionMeta(meta) {
    await fsPromises.mkdir(this._stateDir(), { recursive: true });
    if (!meta) {
      await fsPromises.unlink(this._sessionMetaPath()).catch(() => {});
      return;
    }
    const tmp = `${this._sessionMetaPath()}.tmp`;
    await fsPromises.writeFile(tmp, JSON.stringify(meta), { mode: 0o600 });
    await fsPromises.rename(tmp, this._sessionMetaPath());
  }

  _loadSessionMeta() {
    try {
      return JSON.parse(fs.readFileSync(this._sessionMetaPath(), "utf8"));
    } catch {
      return null;
    }
  }

  // ---- discovery -----------------------------------------------------------

  async _fetchJson(url, init) {
    const response = await net.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      useSessionCookies: false,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new OidcSignInError("INVALID_RESPONSE", `Expected JSON from ${url}`);
    }
    if (!response.ok) {
      throw new OidcSignInError(
        "HTTP_ERROR",
        json.error_description || json.error || `Request to ${url} failed (${response.status})`
      );
    }
    return json;
  }

  async _discover() {
    if (this._discoveryCache && Date.now() - this._discoveryCache.fetchedAt < DISCOVERY_CACHE_MS) {
      return this._discoveryCache.doc;
    }
    const { issuer } = this.getConfig();
    const doc = await this._fetchJson(`${issuer}/.well-known/openid-configuration`);
    for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      if (!doc[field]) {
        throw new OidcSignInError("DISCOVERY_INCOMPLETE", `Issuer metadata is missing ${field}`);
      }
    }
    this._discoveryCache = { doc, fetchedAt: Date.now() };
    return doc;
  }

  async _jwks(jwksUri) {
    if (this._jwksCache && Date.now() - this._jwksCache.fetchedAt < DISCOVERY_CACHE_MS) {
      return this._jwksCache.jwks;
    }
    const jwks = await this._fetchJson(jwksUri);
    this._jwksCache = { jwks, fetchedAt: Date.now() };
    return jwks;
  }

  // ---- sign-in -----------------------------------------------------------

  signIn() {
    if (this._pendingSignIn) return this._pendingSignIn;
    this._pendingSignIn = this._signIn().finally(() => {
      this._pendingSignIn = null;
    });
    return this._pendingSignIn;
  }

  async _signIn() {
    if (!this.isConfigured()) {
      return { success: false, error: "Company sign-in is not configured yet.", code: "SSO_NOT_CONFIGURED" };
    }

    try {
      const config = this.getConfig();
      const discovery = await this._discover();

      const codeVerifier = base64url(crypto.randomBytes(32)).slice(0, 43);
      const codeChallenge = base64url(sha256(codeVerifier));
      const state = crypto.randomBytes(16).toString("hex");
      const nonce = crypto.randomBytes(16).toString("hex");

      const { code, redirectUri } = await this._runLoopback({
        buildAuthUrl: (loopbackRedirectUri) => {
          const params = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: loopbackRedirectUri,
            response_type: "code",
            scope: config.scopes,
            state,
            nonce,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            // access_type/prompt are Google-specific (needed to reliably get a
            // refresh_token back); hd is a Google account-chooser hint. Other
            // OIDC providers ignore unrecognized authorization params per spec.
            access_type: "offline",
            prompt: "consent",
            ...(config.allowedDomain ? { hd: config.allowedDomain } : {}),
          });
          return `${discovery.authorization_endpoint}?${params.toString()}`;
        },
        state,
        port: config.redirectPort,
      });

      const tokens = await this._exchangeCode({
        tokenEndpoint: discovery.token_endpoint,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        redirectUri,
        codeVerifier,
      });

      if (!tokens.id_token) {
        throw new OidcSignInError("NO_ID_TOKEN", "Token response did not include an id_token");
      }

      const jwks = await this._jwks(discovery.jwks_uri);
      const claims = verifyIdToken(tokens.id_token, {
        jwks,
        issuer: discovery.issuer || config.issuer,
        audience: config.clientId,
        nonce,
        allowedDomain: config.allowedDomain,
        allowedTenant: config.allowedTenant,
        tenantClaim: config.tenantClaim,
      });

      const user = {
        id: claims.sub,
        sub: claims.sub,
        email: claims.email || null,
        name: claims.name || claims.email || null,
        image: claims.picture || null,
      };
      const idTokenExpiresAt = claims.exp * 1000;

      this._session = { user, idTokenExpiresAt, obtainedAt: Date.now() };
      this._refreshToken = tokens.refresh_token || null;

      await this._persistRefreshToken(this._refreshToken);
      await this._persistSessionMeta({ user, idTokenExpiresAt, lastValidatedAt: Date.now() });

      this._emitSessionChanged();
      return { success: true, user };
    } catch (error) {
      debugLogger.error("OIDC sign-in failed", { code: error.code, error: error.message }, "oidcIdentity");
      return { success: false, error: this._userFacingError(error), code: error.code };
    }
  }

  _userFacingError(error) {
    if (error instanceof OidcVerificationError) {
      // Claim-validation failures are safe to surface verbatim — they never
      // include token material, just claim names/issuer/audience strings.
      return error.message;
    }
    if (error instanceof OidcSignInError) return error.message;
    return "Sign-in failed. Please try again.";
  }

  _runLoopback({ buildAuthUrl, state, port }) {
    return new Promise((resolve, reject) => {
      let claimed = false;
      let timeoutId;

      const server = http.createServer((req, res) => {
        if (claimed) {
          res.writeHead(400).end();
          return;
        }
        let url;
        try {
          url = new URL(req.url, "http://127.0.0.1");
        } catch {
          res.writeHead(400).end();
          return;
        }
        // Google's "Desktop app" client type validates the loopback redirect
        // URI by scheme/host/port only — matching googleCalendarOAuth.js, this
        // server doesn't require a specific path either, since the redirect_uri
        // sent in the authorization request must match exactly what's used here.

        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const oauthError = url.searchParams.get("error");

        if (oauthError) {
          claimed = true;
          res.writeHead(200, { "Content-Type": "text/html" }).end(errorHtml(oauthError));
          cleanup();
          reject(new OidcSignInError("PROVIDER_ERROR", `Identity provider returned: ${oauthError}`));
          return;
        }

        if (!code || returnedState !== state) {
          // Could be a stray request (favicon, a stale retry); only fail the
          // flow once we've seen an actual code with the wrong state.
          if (code) {
            claimed = true;
            res.writeHead(200, { "Content-Type": "text/html" }).end(errorHtml("Request state mismatch."));
            cleanup();
            reject(new OidcSignInError("STATE_MISMATCH", "OAuth state did not match the request"));
          } else {
            res.writeHead(400).end();
          }
          return;
        }

        claimed = true;
        res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_HTML);
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        cleanup();
        resolve({ code, redirectUri });
      });

      const cleanup = () => {
        clearTimeout(timeoutId);
        server.close();
      };

      server.on("error", (error) => {
        cleanup();
        reject(new OidcSignInError("LOOPBACK_FAILED", error.message));
      });

      server.listen(port, "127.0.0.1", () => {
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        openExternalUrl(buildAuthUrl(redirectUri)).catch((error) => {
          claimed = true;
          cleanup();
          reject(new OidcSignInError("BROWSER_LAUNCH_FAILED", error.message));
        });
      });

      timeoutId = setTimeout(() => {
        if (claimed) return;
        claimed = true;
        cleanup();
        reject(new OidcSignInError("TIMED_OUT", "Sign-in timed out waiting for the browser"));
      }, LOOPBACK_TIMEOUT_MS);
    });
  }

  async _exchangeCode({ tokenEndpoint, clientId, clientSecret, code, redirectUri, codeVerifier }) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }).toString();
    return this._fetchJson(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  // ---- session / refresh ---------------------------------------------------

  async getSession() {
    if (this._session && this._session.idTokenExpiresAt - REFRESH_SKEW_MS > Date.now()) {
      return { ...this._session, offlineGrace: false };
    }

    const refreshed = await this.refreshSession();
    if (refreshed.session) return refreshed.session;

    // Refresh failed (likely offline). Fall back to the last validated
    // identity for a configurable grace period rather than locking instantly.
    const meta = this._loadSessionMeta();
    if (!meta) return null;

    const { offlineGraceMs } = this.getConfig();
    const graceExpiresAt = meta.lastValidatedAt + offlineGraceMs;
    if (Date.now() >= graceExpiresAt) {
      return null;
    }

    return {
      user: meta.user,
      idTokenExpiresAt: meta.idTokenExpiresAt,
      obtainedAt: meta.lastValidatedAt,
      offlineGrace: true,
      graceExpiresAt,
    };
  }

  // Attempts a token refresh; does not apply the offline-grace fallback
  // (that's getSession()'s job) so callers can distinguish "refreshed" from
  // "no network, but still in grace".
  async refreshSession() {
    if (!this.isConfigured()) return { session: null, error: "SSO_NOT_CONFIGURED" };

    const refreshToken = this._refreshToken || (await this._loadRefreshToken());
    if (!refreshToken) return { session: null, error: "NO_REFRESH_TOKEN" };

    try {
      const config = this.getConfig();
      const discovery = await this._discover();
      const tokens = await this._fetchJson(discovery.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.clientId,
          refresh_token: refreshToken,
          ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
        }).toString(),
      });

      let user = this._session?.user || this._loadSessionMeta()?.user;
      let idTokenExpiresAt;

      if (tokens.id_token) {
        const jwks = await this._jwks(discovery.jwks_uri);
        const claims = verifyIdToken(tokens.id_token, {
          jwks,
          issuer: discovery.issuer || config.issuer,
          audience: config.clientId,
          allowedDomain: config.allowedDomain,
          allowedTenant: config.allowedTenant,
          tenantClaim: config.tenantClaim,
        });
        user = {
          id: claims.sub,
          sub: claims.sub,
          email: claims.email || null,
          name: claims.name || claims.email || null,
          image: claims.picture || null,
        };
        idTokenExpiresAt = claims.exp * 1000;
      } else if (typeof tokens.expires_in === "number") {
        idTokenExpiresAt = Date.now() + tokens.expires_in * 1000;
      } else {
        idTokenExpiresAt = Date.now() + 60 * 60 * 1000;
      }

      this._session = { user, idTokenExpiresAt, obtainedAt: Date.now() };
      this._refreshToken = tokens.refresh_token || refreshToken; // providers may rotate or keep the same one

      await this._persistRefreshToken(this._refreshToken);
      await this._persistSessionMeta({ user, idTokenExpiresAt, lastValidatedAt: Date.now() });

      this._emitSessionChanged();
      return { session: { ...this._session, offlineGrace: false } };
    } catch (error) {
      debugLogger.debug("OIDC refresh failed (may just be offline)", { error: error.message }, "oidcIdentity");
      return { session: null, error: error.message };
    }
  }

  async signOut() {
    this._session = null;
    this._refreshToken = null;
    await Promise.all([this._persistRefreshToken(null), this._persistSessionMeta(null)]);
    this._emitSessionChanged();
    return { success: true };
  }

  _emitSessionChanged() {
    this.emit("session-changed");
  }
}

module.exports = OidcIdentityManager;
