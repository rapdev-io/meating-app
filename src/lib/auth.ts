// Company SSO (OIDC, Authorization Code + PKCE) session surface for the renderer.
// All token handling lives in the main process (see oidcIdentityManager.js /
// preload.js's identity* bridge) — this module only ever sees derived session
// info (user + expiry + offline-grace flag), never a raw token.
import type { IdentitySession } from "../types/electron";

// Non-empty once the app has confirmed SSO is configured (see AuthGate /
// useAuth's initial isConfigured check). Kept as a plain string so existing
// `!AUTH_URL` truthiness checks (e.g. SettingsPage's "not configured" gate)
// keep working without changes; it carries no real URL under this flow.
export let AUTH_URL = "";

export function _setAuthConfigured(configured: boolean): void {
  AUTH_URL = configured ? "configured" : "";
}

export async function signIn(): Promise<{ success: boolean; error?: string; code?: string }> {
  const result = await window.electronAPI?.identitySignIn?.();
  if (!result) return { success: false, error: "Sign-in is not available in this build." };
  return result;
}

export async function signOut(): Promise<void> {
  try {
    await window.electronAPI?.identitySignOut?.();
  } catch {
    // Best-effort — local state is cleared by the main process regardless.
  }
}

export async function getSession(): Promise<IdentitySession | null> {
  return (await window.electronAPI?.identityGetSession?.()) ?? null;
}

function isAuthExpiredError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | undefined;
  if (err?.code === "AUTH_EXPIRED") return true;
  const message = err?.message?.toLowerCase() || "";
  return message.includes("session expired") || message.includes("auth expired");
}

// Retries an operation once after an explicit session refresh if it fails
// with an auth-expired signal. The main process is the source of truth for
// refresh/offline-grace, so this is just a thin retry, not a timer/race guard.
export async function withSessionRefresh<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isAuthExpiredError(error)) throw error;
    const refreshed = await window.electronAPI?.identityRefreshSession?.();
    if (!refreshed?.session) throw error;
    return operation();
  }
}

// ---- Compatibility stubs -----------------------------------------------
// Company SSO has no local password or admin console; these keep the settings
// UI (ProfileSection, EnterpriseConsoleRow) compiling without touching their
// email/password-account-era code paths in this pass.

export interface AuthActionError extends Error {
  code?: string;
}

export async function hasCredentialAccount(): Promise<boolean> {
  return false;
}

export async function updateDisplayName(_name: string): Promise<{ error?: AuthActionError }> {
  return { error: Object.assign(new Error("Display name is managed by your identity provider."), {}) };
}

export async function changePassword(_params: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions: boolean;
}): Promise<{ error?: AuthActionError }> {
  return { error: Object.assign(new Error("Password is managed by your identity provider."), {}) };
}

export async function openAdminConsole(): Promise<void> {
  // No hosted admin console under company SSO.
}
