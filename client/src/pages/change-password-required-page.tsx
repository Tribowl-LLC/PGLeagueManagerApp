import { ErrorBoundary } from "@/components/error-boundary";
import { ChangePasswordCard } from "@/components/change-password-card";
import { PublicPageLayout } from "@/components/public-page-layout";
import { apiRequest, clearCsrfToken } from "@/lib/queryClient";
import { ShieldAlert, LogOut } from "lucide-react";

export default function ChangePasswordRequiredPage() {
  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', 'POST', {});
      clearCsrfToken();
    } catch {
      // Best-effort; the redirect below still happens so the user
      // can't be stranded on a screen they can't act on.
    } finally {
      window.location.href = '/login';
    }
  };

  return (
    <ErrorBoundary level="page">
      <PublicPageLayout>
        <section className="public-flow-card public-flow-required-password" data-testid="page-change-password-required">
          <div className="public-flow-icon"><ShieldAlert className="size-6" aria-hidden="true" /></div>
          <p className="public-flow-eyebrow">Password reset required</p>
          <h1 className="public-flow-title">Choose a new password.</h1>
          <p className="public-flow-description">An administrator reset your password. Enter the temporary password as your current password, then choose a new one.</p>
          <div className="public-flow-required-password-form"><ChangePasswordCard forced /></div>
          <button type="button" className="public-flow-link public-flow-sign-out" onClick={handleLogout} data-testid="button-change-password-required-logout"><LogOut className="size-4" aria-hidden="true" />Sign out instead</button>
        </section>
      </PublicPageLayout>
    </ErrorBoundary>
  );
}
