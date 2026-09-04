import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { AUTH_URL, signIn } from "../lib/auth";
import { Button } from "./ui/button";
import { AlertCircle, ArrowRight, Building2, Check, Loader2 } from "lucide-react";
import { CompactOnboardingFrame } from "./onboarding/OnboardingShell";

interface AuthenticationStepProps {
  onContinueWithoutAccount?: () => void;
  onAuthComplete: () => void;
  /** Rendering inside SignInDialog rather than the onboarding window. */
  embedded?: boolean;
}

export default function AuthenticationStep({
  onContinueWithoutAccount,
  onAuthComplete,
  embedded = false,
}: AuthenticationStepProps) {
  const { t } = useTranslation();
  const frameInset = (topClass: string) => (embedded ? "pt-1" : `px-5 ${topClass}`);
  const titleClass = embedded ? "text-2xl font-semibold tracking-tight" : "onboarding-display-title";
  const { isSignedIn, isLoaded, user } = useAuth();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoaded && isSignedIn) onAuthComplete();
  }, [isLoaded, isSignedIn, onAuthComplete]);

  // A failed sign-in leaves the app in the background; clear the spinner
  // once the window regains focus even if the promise never settled cleanly.
  useEffect(() => {
    if (!isSigningIn) return;
    const handleFocus = () => setTimeout(() => setIsSigningIn(false), 1000);
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isSigningIn]);

  const handleSignIn = useCallback(async () => {
    setIsSigningIn(true);
    setError(null);
    const result = await signIn();
    if (!result.success) {
      setError(result.error || t("auth.errors.generic"));
      setIsSigningIn(false);
    }
  }, [t]);

  if (!isLoaded) {
    return <CompactOnboardingFrame embedded={embedded}>{null}</CompactOnboardingFrame>;
  }

  if (!AUTH_URL) {
    return (
      <CompactOnboardingFrame embedded={embedded}>
        <div className={`${frameInset("pt-44")} text-center`}>
          <h1 className={titleClass}>{t("auth.welcomeTitle")}</h1>
          <p className="mt-3 text-base text-muted-foreground">{t("auth.welcomeSubtitle")}</p>
          <div className="mt-8 rounded-xl border border-warning/20 bg-warning/5 p-3 text-sm text-warning">
            {t("auth.cloudNotConfigured")}
          </div>
          {onContinueWithoutAccount && (
            <Button onClick={onContinueWithoutAccount} className="mt-3 h-12 w-full rounded-full">
              {t("auth.getStarted")}
              <ArrowRight className="size-4" />
            </Button>
          )}
        </div>
      </CompactOnboardingFrame>
    );
  }

  if (isLoaded && isSignedIn) {
    return (
      <CompactOnboardingFrame embedded={embedded}>
        <div className={`${frameInset("pt-48")} text-center`}>
          <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-border bg-card shadow-sm">
            <Check className="size-5 text-success" />
          </div>
          <p className="mt-6 text-2xl font-medium leading-tight tracking-tight">
            {user?.name
              ? t("auth.signedIn.welcomeBackName", { name: user.name })
              : t("auth.signedIn.welcomeBack")}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">{t("auth.signedIn.ready")}</p>
          <Button onClick={onAuthComplete} className="mt-7 h-12 w-full rounded-full">
            {t("auth.common.continue")}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </CompactOnboardingFrame>
    );
  }

  return (
    <CompactOnboardingFrame embedded={embedded}>
      <div className={`${frameInset("pt-38")} text-center`}>
        <h1 className={titleClass}>{t("auth.welcomeTitle")}</h1>
        <p className="mt-2 text-base text-[var(--onboarding-text-secondary)]">
          {t("auth.welcomeSubtitle")}
        </p>

        <Button
          type="button"
          onClick={handleSignIn}
          disabled={isSigningIn}
          className="mt-6 h-12 w-full rounded-full"
        >
          {isSigningIn ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              <span>{t("auth.social.completeInBrowser")}</span>
            </>
          ) : (
            <>
              <Building2 className="size-4" />
              <span>{t("auth.sso.continueWithSSO")}</span>
            </>
          )}
        </Button>

        {error && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-left">
            <AlertCircle className="size-3.5 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {onContinueWithoutAccount && (
          <div className="pt-5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onContinueWithoutAccount}
              className="w-full rounded-full text-base font-normal text-[var(--onboarding-text-secondary)] hover:bg-[var(--onboarding-surface-hover)] hover:text-[var(--onboarding-text-primary)]"
              disabled={isSigningIn}
            >
              {t("auth.emailStep.continueWithoutAccount")}
            </Button>
          </div>
        )}
      </div>
    </CompactOnboardingFrame>
  );
}
