import { useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAuth } from "./useAuth";
import APP_CONFIG from "../config/appIdentity.json";
import type { Workspace, WorkspaceRole } from "../types/electron";

interface UseWorkspaceResult {
  workspaces: Workspace[];
  active: Workspace | null;
  role: WorkspaceRole | null;
  loaded: boolean;
  setActive: (id: string | null) => void;
  refresh: () => Promise<void>;
}

export function useWorkspace(): UseWorkspaceResult {
  const { isSignedIn } = useAuth();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const storeLoaded = useWorkspaceStore((s) => s.loaded);
  const refresh = useWorkspaceStore((s) => s.refresh);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspaceId);

  useEffect(() => {
    // Workspaces are an OpenWhispr Cloud/teams concept; "signed in" here is
    // company SSO, so never fetch when that feature is off (see useUsage.ts
    // for the same isSignedIn-no-longer-means-OpenWhispr-account gotcha).
    if (isSignedIn && !storeLoaded && APP_CONFIG.enableTeams) {
      void refresh();
    }
  }, [isSignedIn, storeLoaded, refresh]);

  // When teams are disabled, the store's `loaded` flag never flips (nothing
  // ever calls refresh()). Report loaded immediately so callers gating on
  // workspace resolution — onboarding's "notes" step, the Spaces tree —
  // don't wait forever on a fetch that will never happen.
  const loaded = APP_CONFIG.enableTeams ? storeLoaded : true;

  const active = activeWorkspaceId
    ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? null)
    : null;

  return {
    workspaces,
    active,
    role: active?.role ?? null,
    loaded,
    setActive,
    refresh,
  };
}
