import type { JSX } from "react";
import AuthenticationStep from "./AuthenticationStep";

interface CompactAuthenticationFlowProps {
  onContinueWithoutAccount?: () => void;
  onAuthComplete: () => void;
}

export function CompactAuthenticationFlow({
  onContinueWithoutAccount,
  onAuthComplete,
}: CompactAuthenticationFlowProps): JSX.Element {
  return (
    <AuthenticationStep
      onContinueWithoutAccount={onContinueWithoutAccount}
      onAuthComplete={onAuthComplete}
    />
  );
}
