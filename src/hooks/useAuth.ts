import { useCallback, useEffect, useState } from "react";
import { _setAuthConfigured } from "../lib/auth";
import { usePolicyStore } from "../stores/policyStore";
import logger from "../utils/logger";
import type { IdentitySession, IdentityUser } from "../types/electron";

interface UseAuthResult {
  isSignedIn: boolean;
  // Always false under company SSO — kept only so existing consumers (e.g.
  // AppRouter's onboarding-completion check) that destructure it don't break.
  // Use isOfflineGrace for "signed in from cached credentials, no network yet".
  isGracePeriodOnly: boolean;
  isLoaded: boolean;
  isOfflineGrace: boolean;
  session: IdentitySession | null;
  user: IdentityUser | null;
  refetch: () => Promise<void>;
}

// There's no more OpenWhispr-hosted managed-workspace policy under company
// SSO (no workspaces, no OpenWhispr Cloud policy API) — so a signed-in user is
// always "unmanaged" (no restrictions), set locally with no network call.
// AppRouter hard-gates its loading screen on policyStore's status ever
// leaving "idle"; without this, a signed-in session stays stuck there forever
// because nothing else drives that transition anymore.
function syncPolicyForSession(session: IdentitySession | null): void {
  if (session) {
    usePolicyStore.setState({
      accountId: session.user.id,
      authGeneration: 0,
      status: "unmanaged",
      managed: false,
      policy: null,
    });
  } else {
    usePolicyStore.getState().clearPolicy();
  }
}

export function useAuth(): UseAuthResult {
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  const refetch = useCallback(async () => {
    let next: IdentitySession | null = null;
    try {
      next = (await window.electronAPI?.identityGetSession?.()) ?? null;
    } catch (error) {
      // Never leave the app stuck on a loading screen because one IPC call
      // rejected (e.g. a transient main-process error) — fail closed to guest.
      logger.error("Failed to read identity session:", error, "auth");
    }
    setSession(next);
    syncPolicyForSession(next);

    let configured = false;
    try {
      configured = Boolean(await window.electronAPI?.identityIsConfigured?.());
    } catch {
      // Leave AUTH_URL empty (not configured) on failure.
    }
    _setAuthConfigured(configured);
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    void refetch();
    const unsubscribe = window.electronAPI?.onIdentitySessionChanged?.((payload) => {
      const next = payload.session ?? null;
      setSession(next);
      syncPolicyForSession(next);
      setIsLoaded(true);
    });
    return () => unsubscribe?.();
  }, [refetch]);

  return {
    isSignedIn: Boolean(session),
    isGracePeriodOnly: false,
    isLoaded,
    isOfflineGrace: Boolean(session?.offlineGrace),
    session,
    user: session?.user ?? null,
    refetch,
  };
}
