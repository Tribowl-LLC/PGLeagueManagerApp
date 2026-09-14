import { FC, useState } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowRight, LogOut, Trash2 } from "lucide-react";
import { PageLoadingState } from "@/components/page-states";
import { Link } from "wouter";
import { BowlerLayout } from "@/components/bowler-layout";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, clearCsrfToken } from "@/lib/queryClient";
import { logger } from "@/lib/logger";
import { ProfileInfoCard, type CurrentUserWithSyncStatus } from "@/components/profile-info-card";
import { ChangePasswordCard } from "@/components/change-password-card";
import { SavedPaymentMethodsCard } from "@/components/saved-payment-methods-card";
import { BowlerPaymentLinksSection } from "@/components/bowler-payment-links-section";
import type { ApiResponse } from "@shared/schema";

const STALE_TIME = 1000 * 60 * 5;

const ProfileSettingsPage: FC = () => {
  const { toast } = useToast();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // The /api/user response augments the bare User row with a derived
  // `paymentSyncStatus` (#363) so ProfileInfoCard can hydrate the
  // self-serve retry button on first paint. Use the augmented type
  // here so the prop-flow stays type-correct end-to-end.
  const { data: userResponse, isLoading: isLoadingUser } = useQuery<ApiResponse<CurrentUserWithSyncStatus>>({
    queryKey: ['/api/user'],
    staleTime: STALE_TIME,
  });
  const currentUser = userResponse?.data;
  const bowlerId = currentUser?.bowlerId;

  const handleLogout = async () => {
    try {
      setIsLoggingOut(true);
      await apiRequest('/api/auth/logout', 'POST', {});
      clearCsrfToken();
      window.location.href = '/login';
    } catch (error) {
      logger.error('ProfileSettings', 'Logout failed', error);
      toast({ title: "Logout failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setIsLoggingOut(false);
    }
  };

  if (isLoadingUser) {
    return <PageLoadingState message="Loading profile..." />;
  }

  if (!currentUser) {
    return (
      <Card className="mx-auto max-w-md mt-8">
        <CardHeader>
          <CardTitle>Authentication Required</CardTitle>
          <CardDescription>Please log in to view your profile settings</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/login">Log In</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isSystemAdmin = currentUser.role === 'system_admin';

  return (
    <BowlerLayout bowlerName={currentUser.name} leagueName="">
      <ErrorBoundary level="section">
        {isSystemAdmin && (
          <div className="mb-6">
            <Button asChild variant="outline" className="flex items-center">
              <Link href="/">
                <ArrowRight className="size-4 rotate-180" />
                Back to Dashboard
              </Link>
            </Button>
          </div>
        )}

        <div className="space-y-6 max-w-2xl">
          <ProfileInfoCard currentUser={currentUser} />
          <ChangePasswordCard />
          {bowlerId && <SavedPaymentMethodsCard bowlerId={bowlerId} />}
          {bowlerId && (
            <BowlerPaymentLinksSection currentBowlerId={bowlerId} alwaysShow />
          )}

          <Separator />

          <Card>
            <CardHeader padding="standard">
              <CardTitle>Sign Out</CardTitle>
              <CardDescription className="mt-1.5">Log out of your account on this device</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="destructive"
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="flex items-center"
              >
                {isLoggingOut ? (
                  <><Loader2 className="size-4 animate-spin" />Signing out…</>
                ) : (
                  <><LogOut className="size-4" />Sign Out</>
                )}
              </Button>
            </CardContent>
          </Card>

          <Separator />

          <Card>
            <CardHeader padding="standard">
              <CardTitle iconSpacing>
                <Trash2 className="size-5 text-destructive" />
                Delete Account
              </CardTitle>
              <CardDescription className="mt-1.5">Permanently delete your account and all associated data</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="destructiveOutline" className="flex items-center">
                <Link href="/delete-account">
                  <Trash2 className="size-4" />
                  Request Account Deletion
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </ErrorBoundary>
    </BowlerLayout>
  );
};

export default ProfileSettingsPage;
