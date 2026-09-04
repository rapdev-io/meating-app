import type { JSX } from "react";
import { CompactAuthenticationFlow } from "./CompactAuthenticationFlow";
import OnboardingShell from "./onboarding/OnboardingShell";

interface ReauthenticationScreenProps {
  onAuthComplete: () => void;
}

export default function ReauthenticationScreen({
  onAuthComplete,
}: ReauthenticationScreenProps): JSX.Element {
  return (
    <OnboardingShell compact stepKey="reauthentication">
      <div className="min-h-full w-full">
        <CompactAuthenticationFlow onAuthComplete={onAuthComplete} />
      </div>
    </OnboardingShell>
  );
}
