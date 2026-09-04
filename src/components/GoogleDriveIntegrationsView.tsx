import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, Loader2, ExternalLink, Unlink } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useToast } from "./ui/useToast";
import type { GoogleDriveStatus } from "../types/electron";

const ERROR_KEY_BY_CODE: Record<string, string> = {
  NOT_CONFIGURED: "integrations.googleDrive.errors.notConfigured",
  STATE_MISMATCH: "integrations.googleDrive.errors.generic",
  TIMED_OUT: "integrations.googleDrive.errors.timedOut",
  BROWSER_LAUNCH_FAILED: "integrations.googleDrive.errors.browserLaunchFailed",
  NO_REFRESH_TOKEN: "integrations.googleDrive.errors.noRefreshToken",
  PROVIDER_ERROR: "integrations.googleDrive.errors.generic",
};

/**
 * Minimal internal (Protein/RapDev) replacement for the full IntegrationsView —
 * only Google Drive export, none of the calendar/API-keys/CLI/MCP surface.
 */
export default function GoogleDriveIntegrationsView() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const [status, setStatus] = useState<GoogleDriveStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const refresh = useCallback(async () => {
    const next = await window.electronAPI?.googleDriveGetStatus?.();
    setStatus(next ?? { connected: false });
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleConnect = useCallback(async () => {
    setIsConnecting(true);
    try {
      const result = await window.electronAPI?.googleDriveConnect?.();
      if (result?.success) {
        await refresh();
      } else if (result?.code !== "PROVIDER_ERROR" || result.error !== "access_denied") {
        showAlertDialog({
          title: t("integrations.googleDrive.connectFailedTitle"),
          description: result?.code && ERROR_KEY_BY_CODE[result.code]
            ? t(ERROR_KEY_BY_CODE[result.code])
            : result?.error || t("integrations.googleDrive.errors.generic"),
        });
      }
    } catch {
      // A rejected IPC call (e.g. no handler registered) must still surface —
      // never leave the button looking like the click did nothing.
      showAlertDialog({
        title: t("integrations.googleDrive.connectFailedTitle"),
        description: t("integrations.googleDrive.errors.generic"),
      });
    } finally {
      setIsConnecting(false);
    }
  }, [refresh, showAlertDialog, t]);

  const handleDisconnect = useCallback(async () => {
    setIsDisconnecting(true);
    try {
      await window.electronAPI?.googleDriveDisconnect?.();
      await refresh();
      toast({ title: t("integrations.googleDrive.disconnected") });
    } finally {
      setIsDisconnecting(false);
      setConfirmDisconnect(false);
    }
  }, [refresh, toast, t]);

  const connected = status?.connected ?? false;

  return (
    <div className="space-y-3">
      <SettingsPanel>
        <SettingsPanelRow>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
              <HardDrive className="w-4.5 h-4.5 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-foreground">
                {t("integrations.googleDrive.title")}
              </p>
              <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                {connected && status?.email
                  ? t("integrations.googleDrive.connectedDescription", {
                      email: status.email,
                      folder: status.folderName || "Protein Transcripts",
                    })
                  : t("integrations.googleDrive.description")}
              </p>
            </div>
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
            ) : connected ? (
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="success">{t("integrations.googleDrive.connected")}</Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={isDisconnecting}
                >
                  {isDisconnecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Unlink className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={handleConnect} disabled={isConnecting} className="shrink-0">
                {isConnecting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t("integrations.googleDrive.connect")
                )}
              </Button>
            )}
          </div>
        </SettingsPanelRow>
      </SettingsPanel>

      <p className="text-[11px] text-muted-foreground/60 leading-relaxed px-1 flex items-start gap-1">
        <ExternalLink className="h-3 w-3 shrink-0 mt-0.5" />
        {t("integrations.googleDrive.hint")}
      </p>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={t("integrations.googleDrive.disconnectTitle")}
        description={t("integrations.googleDrive.disconnectDescription")}
        onConfirm={handleDisconnect}
        variant="destructive"
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />
    </div>
  );
}
