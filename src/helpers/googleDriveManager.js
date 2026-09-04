const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const { app, net } = require("electron");
const debugLogger = require("./debugLogger");
const secretCrypto = require("./secretCrypto");
const { openExternalUrl } = require("./externalUrlOpener");

// Drive export is a separate authorization from company SSO, even against the
// same Google identity — narrowest practical scope (drive.file): the app can
// only see/write files it creates itself, never the user's whole Drive.
// Falls back to the existing Calendar OAuth client so most deployments don't
// need a second Google Cloud OAuth client registered; set GOOGLE_DRIVE_CLIENT_ID
// explicitly to use a dedicated one instead.
const DRIVE_SCOPE = "openid email https://www.googleapis.com/auth/drive.file";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const DEFAULT_FOLDER_NAME = "Protein Transcripts";
const LOOPBACK_TIMEOUT_MS = 120000;
const HTTP_TIMEOUT_MS = 15000;

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font:15px -apple-system,Segoe UI,sans-serif;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;background:#0b0c0f;color:#eee}
.card{text-align:center;max-width:360px;padding:24px}</style></head>
<body><div class="card"><h2>Google Drive connected</h2><p>You can close this tab and return to the app.</p></div></body></html>`;

const errorHtml = (message) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Connection failed</title>
<style>body{font:15px -apple-system,Segoe UI,sans-serif;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;background:#0b0c0f;color:#eee}
.card{text-align:center;max-width:420px;padding:24px}</style></head>
<body><div class="card"><h2>Connection failed</h2><p>${message}</p><p>You can close this tab and try again in the app.</p></div></body></html>`;

class GoogleDriveError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function sanitizeFilenamePart(input, maxLen = 60) {
  const cleaned = (input || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Transcript").slice(0, maxLen);
}

function escapeDriveQueryValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

class GoogleDriveManager {
  constructor() {
    this._folderIdCache = null;
  }

  // ---- configuration -------------------------------------------------------

  _oidcIsGoogle() {
    return /^https:\/\/accounts\.google\.com\/?$/.test((process.env.OIDC_ISSUER_URL || "").trim());
  }

  // Falls back through Calendar's client, then the company-SSO OIDC client
  // (when that's configured against Google, i.e. OIDC_ISSUER_URL points at
  // accounts.google.com) — most deployments need zero extra Google Cloud
  // setup beyond enabling the Drive API on whichever project already exists.
  getClientId() {
    return (
      process.env.GOOGLE_DRIVE_CLIENT_ID ||
      process.env.GOOGLE_CALENDAR_CLIENT_ID ||
      (this._oidcIsGoogle() ? process.env.OIDC_CLIENT_ID : "") ||
      ""
    ).trim();
  }

  getClientSecret() {
    return (
      process.env.GOOGLE_DRIVE_CLIENT_SECRET ||
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET ||
      (this._oidcIsGoogle() ? process.env.OIDC_CLIENT_SECRET : "") ||
      ""
    ).trim();
  }

  isConfigured() {
    return Boolean(this.getClientId());
  }

  // ---- storage -------------------------------------------------------------

  _stateDir() {
    return path.join(app.getPath("userData"), "google-drive");
  }

  _refreshTokenPath() {
    return path.join(this._stateDir(), "refresh-token.enc");
  }

  _statePath() {
    return path.join(this._stateDir(), "state.json");
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

  async _persistState(state) {
    await fsPromises.mkdir(this._stateDir(), { recursive: true });
    if (!state) {
      await fsPromises.unlink(this._statePath()).catch(() => {});
      return;
    }
    const tmp = `${this._statePath()}.tmp`;
    await fsPromises.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fsPromises.rename(tmp, this._statePath());
  }

  _loadState() {
    try {
      return JSON.parse(fs.readFileSync(this._statePath(), "utf8"));
    } catch {
      return null;
    }
  }

  async getStatus() {
    const state = this._loadState();
    const refreshToken = await this._loadRefreshToken();
    if (!state || !refreshToken) return { connected: false };
    return {
      connected: true,
      email: state.email || null,
      folderName: state.folderName || DEFAULT_FOLDER_NAME,
    };
  }

  // ---- HTTP helpers ----------------------------------------------------------

  async _fetchJson(url, init) {
    // A service-enablement error (or any other transient failure) must never
    // be served from Chromium's HTTP cache on retry — it has to hit Google
    // fresh every time so a fix on Google's side is reflected immediately.
    const response = await net.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      useSessionCookies: false,
      cache: "no-store",
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new GoogleDriveError("INVALID_RESPONSE", `Expected JSON from ${url}`);
    }
    if (!response.ok) {
      const message = json?.error?.message || json.error_description || json.error || `HTTP ${response.status}`;
      if (response.status === 401) throw new GoogleDriveError("AUTH_EXPIRED", message);
      if (response.status === 429) throw new GoogleDriveError("QUOTA_EXCEEDED", message);
      if (response.status === 403) {
        // Google's Drive API overloads 403 for both "quota exceeded" and
        // "insufficient permission" — the message body is the only way to tell.
        const code = /quota|rate limit/i.test(message) ? "QUOTA_EXCEEDED" : "INSUFFICIENT_PERMISSIONS";
        throw new GoogleDriveError(code, message);
      }
      throw new GoogleDriveError("HTTP_ERROR", message);
    }
    return json;
  }

  // ---- connect / disconnect ---------------------------------------------------

  connect() {
    if (this._pendingConnect) return this._pendingConnect;
    this._pendingConnect = this._connect().finally(() => {
      this._pendingConnect = null;
    });
    return this._pendingConnect;
  }

  async _connect() {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: "Google Drive is not configured yet.",
        code: "NOT_CONFIGURED",
      };
    }

    try {
      const clientId = this.getClientId();
      const codeVerifier = crypto.randomBytes(32).toString("base64url").slice(0, 43);
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
      const state = crypto.randomBytes(16).toString("hex");

      const { code, redirectUri } = await this._runLoopback({
        state,
        buildAuthUrl: (loopbackRedirectUri) => {
          const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: loopbackRedirectUri,
            response_type: "code",
            scope: DRIVE_SCOPE,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            access_type: "offline",
            prompt: "consent",
          });
          return `${GOOGLE_AUTH_URL}?${params.toString()}`;
        },
      });

      const clientSecret = this.getClientSecret();
      const tokens = await this._fetchJson(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        }).toString(),
      });

      if (!tokens.refresh_token) {
        throw new GoogleDriveError(
          "NO_REFRESH_TOKEN",
          "Google did not return a refresh token. Disconnect any prior grant for this app in your Google Account's Security settings and try again."
        );
      }

      let email = null;
      if (tokens.id_token) {
        try {
          email = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()).email;
        } catch {
          // Non-fatal — the connection still works without a display email.
        }
      }

      await this._persistRefreshToken(tokens.refresh_token);
      this._folderIdCache = null;
      const existingState = this._loadState();
      await this._persistState({
        email,
        folderId: existingState?.folderId || null,
        folderName: existingState?.folderName || DEFAULT_FOLDER_NAME,
        connectedAt: Date.now(),
      });

      return { success: true, email };
    } catch (error) {
      debugLogger.error("Google Drive connect failed", { code: error.code, error: error.message }, "googleDrive");
      return { success: false, error: error.message, code: error.code };
    }
  }

  async disconnect() {
    const refreshToken = await this._loadRefreshToken();
    if (refreshToken) {
      try {
        await this._fetchJson(GOOGLE_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }).toString(),
        });
      } catch {
        // Best-effort — token may already be revoked or network unavailable.
      }
    }
    await Promise.all([this._persistRefreshToken(null), this._persistState(null)]);
    this._folderIdCache = null;
    return { success: true };
  }

  _runLoopback({ buildAuthUrl, state }) {
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

        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const oauthError = url.searchParams.get("error");

        if (oauthError) {
          claimed = true;
          res.writeHead(200, { "Content-Type": "text/html" }).end(errorHtml(oauthError));
          cleanup();
          reject(new GoogleDriveError("PROVIDER_ERROR", `Google returned: ${oauthError}`));
          return;
        }

        if (!code || returnedState !== state) {
          if (code) {
            claimed = true;
            res.writeHead(200, { "Content-Type": "text/html" }).end(errorHtml("Request state mismatch."));
            cleanup();
            reject(new GoogleDriveError("STATE_MISMATCH", "OAuth state did not match the request"));
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
        reject(new GoogleDriveError("LOOPBACK_FAILED", error.message));
      });

      server.listen(0, "127.0.0.1", () => {
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        openExternalUrl(buildAuthUrl(redirectUri)).catch((error) => {
          claimed = true;
          cleanup();
          reject(new GoogleDriveError("BROWSER_LAUNCH_FAILED", error.message));
        });
      });

      timeoutId = setTimeout(() => {
        if (claimed) return;
        claimed = true;
        cleanup();
        reject(new GoogleDriveError("TIMED_OUT", "Connection timed out waiting for the browser"));
      }, LOOPBACK_TIMEOUT_MS);
    });
  }

  // ---- access token refresh ---------------------------------------------------

  async _getValidAccessToken() {
    const refreshToken = await this._loadRefreshToken();
    if (!refreshToken) throw new GoogleDriveError("NOT_CONNECTED", "Google Drive is not connected.");

    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    const tokens = await this._fetchJson(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }).toString(),
    }).catch((error) => {
      if (error.code === "HTTP_ERROR" || error.code === "AUTH_EXPIRED") {
        throw new GoogleDriveError("AUTH_EXPIRED", "Google Drive access expired. Reconnect in Integrations.");
      }
      throw error;
    });

    // Google may rotate the refresh token; persist if it did.
    if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
      await this._persistRefreshToken(tokens.refresh_token);
    }
    return tokens.access_token;
  }

  // ---- destination folder -----------------------------------------------------

  async _ensureFolder(accessToken) {
    if (this._folderIdCache) return this._folderIdCache;

    const state = this._loadState() || {};
    const folderName = state.folderName || DEFAULT_FOLDER_NAME;
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    if (state.folderId) {
      // Verify it still exists (the user may have deleted it in Drive).
      try {
        const check = await this._fetchJson(
          `${DRIVE_FILES_URL}/${state.folderId}?fields=id,trashed`,
          { headers: authHeader }
        );
        if (check.id && !check.trashed) {
          this._folderIdCache = check.id;
          return check.id;
        }
      } catch {
        // Fall through to recreate.
      }
    }

    const created = await this._fetchJson(`${DRIVE_FILES_URL}?fields=id,name`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder" }),
    });

    this._folderIdCache = created.id;
    await this._persistState({ ...state, folderId: created.id, folderName });
    return created.id;
  }

  async _findExistingFile(accessToken, folderId, name) {
    const query = `name='${escapeDriveQueryValue(name)}' and '${folderId}' in parents and trashed=false`;
    const result = await this._fetchJson(
      `${DRIVE_FILES_URL}?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return result.files || [];
  }

  async _uploadFile(accessToken, { folderId, name, content }) {
    const boundary = `protein-export-${crypto.randomBytes(8).toString("hex")}`;
    const metadata = JSON.stringify({ name, parents: [folderId], mimeType: "text/markdown" });
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n` +
      `--${boundary}--`;

    return this._fetchJson(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink,name`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
  }

  // ---- export ------------------------------------------------------------

  /**
   * @param {{ text: string, timestamp: string, title?: string, source?: string }} transcript
   */
  async exportTranscript(transcript) {
    if (!(await this._loadRefreshToken())) {
      return { success: false, error: "Google Drive is not connected.", code: "NOT_CONNECTED" };
    }

    try {
      const accessToken = await this._getValidAccessToken();
      const folderId = await this._ensureFolder(accessToken);

      const created = new Date(transcript.timestamp);
      const stamp = Number.isNaN(created.getTime())
        ? new Date().toISOString().replace(/[:.]/g, "-")
        : created.toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const titlePart = sanitizeFilenamePart(transcript.title || "Transcript");
      let filename = `${titlePart} - ${stamp}.md`;

      const existing = await this._findExistingFile(accessToken, folderId, filename);
      if (existing.length > 0) {
        filename = `${titlePart} - ${stamp} (${existing.length + 1}).md`;
      }

      const heading = transcript.title || "Dictation Transcript";
      const createdLabel = Number.isNaN(created.getTime()) ? transcript.timestamp : created.toLocaleString();
      const content =
        `# ${heading}\n\n` +
        `**Created:** ${createdLabel}\n` +
        `**Source:** ${transcript.source || "Protein"}\n\n` +
        `${transcript.text}\n`;

      const uploaded = await this._uploadFile(accessToken, { folderId, name: filename, content });
      return { success: true, fileId: uploaded.id, name: uploaded.name, webViewLink: uploaded.webViewLink };
    } catch (error) {
      debugLogger.error("Google Drive export failed", { code: error.code, error: error.message }, "googleDrive");
      return { success: false, error: error.message, code: error.code };
    }
  }
}

module.exports = GoogleDriveManager;
