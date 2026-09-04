import type { JSX } from "react";
import AuthenticationStep from "./AuthenticationStep";

interface CompactAuthenticationFlowProps {
  onAuthComplete: () => void;
}

export function CompactAuthenticationFlow({
  onAuthComplete,
}: CompactAuthenticationFlowProps): JSX.Element {
  return <AuthenticationStep onAuthComplete={onAuthComplete} />;
}
