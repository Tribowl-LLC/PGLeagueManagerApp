import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SQUARE_FIELD_LABELS, type RequiredSquareField } from "@shared/schema";

interface PaymentProviderNotConfiguredAlertProps {
  missingFields: RequiredSquareField[];
  isAdmin: boolean;
  onOpenSettings: () => void;
}

export function PaymentProviderNotConfiguredAlert({
  missingFields,
  isAdmin,
  onOpenSettings,
}: PaymentProviderNotConfiguredAlertProps) {
  return (
    <Alert variant="destructive" data-testid="alert-square-not-configured">
      <AlertTriangle className="size-4" />
      <AlertTitle>Square isn't fully set up for this location</AlertTitle>
      <AlertDescription>
        <p className="text-sm">Card payments are unavailable until every required Square credential is filled in.</p>
        {missingFields.length > 0 && (
          <p className="text-xs mt-2">
            Missing: <span className="font-medium">{missingFields.map((field) => SQUARE_FIELD_LABELS[field]).join(", ")}</span>.
          </p>
        )}
        <p className="text-xs mt-2">
          {isAdmin
            ? "Finish configuring Square in Settings to enable card payments. Cash and check payments still work in the meantime."
            : "Ask your league admin to finish configuring Square in Settings, then try again. Cash and check payments still work in the meantime."}
        </p>
        {isAdmin && (
          <div className="mt-3">
            <Button type="button" variant="outline" size="sm" data-testid="button-square-not-configured-open-settings" onClick={onOpenSettings}>
              Open Settings
            </Button>
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
