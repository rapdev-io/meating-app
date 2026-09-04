import React from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import AuthenticationStep from "./AuthenticationStep";

interface SignInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SignInDialog({ open, onOpenChange }: SignInDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="sr-only">{t("auth.welcomeTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("auth.welcomeSubtitle")}</DialogDescription>
        <AuthenticationStep onAuthComplete={() => onOpenChange(false)} embedded />
      </DialogContent>
    </Dialog>
  );
}
