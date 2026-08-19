import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiRequest } from '@/lib/queryClient';
import { Layout } from '@/components/layout';
import { ErrorBoundary } from '@/components/error-boundary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Plus } from 'lucide-react';
import { Link } from 'wouter';
import { UsersTable, type UsersTableUser, type UsersTableLocation } from '@/components/users-table';
import { AddUserDialog } from '@/components/add-user-dialog';
import { passwordSchema } from '@shared/password-validation';
import { parsePaymentSyncStatus, type PaymentSyncStatus } from '@shared/schema';
import { ResetPasswordDialog } from './userspage/reset-password-dialog';
import { ChangeEmailDialog } from './userspage/change-email-dialog';
import { DeleteUserDialog } from './userspage/delete-user-dialog';

const resetPasswordFormSchema = z.object({
  newPassword: passwordSchema,
});
type ResetPasswordFormValues = z.infer<typeof resetPasswordFormSchema>;

const changeEmailFormSchema = z.object({
  email: z.string().email('Please enter a valid email'),
});
type ChangeEmailFormValues = z.infer<typeof changeEmailFormSchema>;

export default function UsersPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteUserId, setDeleteUserId] = useState<number | null>(null);
  const [resetPasswordUserId, setResetPasswordUserId] = useState<number | null>(null);
  const [changeEmailUserId, setChangeEmailUserId] = useState<number | null>(null);

  const resetPasswordForm = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordFormSchema),
    defaultValues: { newPassword: '' },
  });

  const changeEmailForm = useForm<ChangeEmailFormValues>({
    resolver: zodResolver(changeEmailFormSchema),
    defaultValues: { email: '' },
  });

  useEffect(() => {
    if (resetPasswordUserId === null) {
      resetPasswordForm.reset({ newPassword: '' });
    }
  }, [resetPasswordUserId, resetPasswordForm]);

  useEffect(() => {
    if (changeEmailUserId === null) {
      changeEmailForm.reset({ email: '' });
    }
  }, [changeEmailUserId, changeEmailForm]);

  const { data: currentUserResponse } = useQuery<{ success: boolean; data: UsersTableUser }>({
    queryKey: ['/api/user'],
  });
  const currentUser = currentUserResponse?.data;
  const organizationId = currentUser?.organizationId;

  const { data: orgUsersResponse, isLoading: orgUsersLoading } = useQuery<{ success: boolean; data: UsersTableUser[] }>({
    queryKey: ['/api/org-admin/users', organizationId],
    queryFn: async () => {
      const response = await fetch(`/api/org-admin/users?organizationId=${organizationId}`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to fetch users');
      return response.json();
    },
    enabled: !!organizationId,
  });

  const { data: locationsResponse } = useQuery<{ success: boolean; data: UsersTableLocation[] }>({
    queryKey: ['/api/locations'],
  });

  const orgUsers = orgUsersResponse?.data || [];
  const locations = locationsResponse?.data || [];
  const orgLocations = locations.filter(l => l.organizationId === organizationId);

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: number) => {
      await apiRequest(`/api/org-admin/users/${userId}`, 'DELETE');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/org-admin/users'] });
      setDeleteUserId(null);
      toast({
        title: 'User deleted',
        description: 'The user account has been permanently removed.',
      });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async ({ userId, newPassword }: { userId: number; newPassword: string }) => {
      await apiRequest(`/api/org-admin/users/${userId}/reset-password`, 'POST', { newPassword });
    },
    onSuccess: () => {
      setResetPasswordUserId(null);
      toast({
        title: 'Password reset',
        description: "The user's password has been reset and they have been emailed a security notice.",
      });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  // Admin email change goes through the same PATCH /api/account/profile/:id
  // endpoint a user uses for their own profile (system_admin is allowed to
  // act on another user). The endpoint defers the actual email swap until
  // the target user clicks the confirmation link, but the response also
  // includes a `paymentSyncStatus` from any inline name/phone sync — and
  // for admin-initiated changes we want to surface the same retry notice
  // that ProfileInfoCard (#284) and the email-confirmation page (#322)
  // already show on `pending_retry` (#373).
  const changeEmailMutation = useMutation({
    mutationFn: async ({ userId, email }: { userId: number; email: string }) => {
      return apiRequest<{ paymentSyncStatus?: PaymentSyncStatus; emailChangeRequested?: boolean }>(
        `/api/account/profile/${userId}`,
        'PATCH',
        { email },
      );
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['/api/org-admin/users'] });
      setChangeEmailUserId(null);
      toast({
        title: 'Confirmation email sent',
        description:
          "We've emailed the user's new address. Their sign-in email will only change once they click the confirmation link.",
      });
      // Wording mirrors the toast in client/src/components/profile-info-card.tsx
      // and the alert in client/src/pages/confirm-email-change-page.tsx so an
      // admin who edits another user's email sees the same explanation.
      // The shared parser (task #374) collapses any unrecognized server
      // value to `not_applicable`, so an old client + future server
      // adding a fifth state silently no-ops here instead of toasting.
      const raw = response?.data?.paymentSyncStatus;
      const status: PaymentSyncStatus | null =
        raw == null ? null : parsePaymentSyncStatus(raw);
      if (status === 'pending_retry') {
        toast({
          title: 'Payment record will be retried',
          description:
            'Your payment profile is temporarily out of date and will be retried automatically. Charges or saved cards may behave oddly for the next few minutes.',
        });
      }
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  const getUserToDelete = deleteUserId ? orgUsers.find(u => u.id === deleteUserId) : null;
  const getUserToReset = resetPasswordUserId ? orgUsers.find(u => u.id === resetPasswordUserId) : null;
  const getUserToChangeEmail = changeEmailUserId ? orgUsers.find(u => u.id === changeEmailUserId) : null;

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="container py-6">
          <div className="flex items-start justify-between mb-6 gap-4">
            <div>
                <h1 className="text-4xl font-bold">Organization Accounts</h1>
                <p className="text-muted-foreground mt-1">
                Manage administrators and location-scoped payment managers for your organization. Looking for
                bowler accounts that signed up themselves?{' '}
                <Link
                  href="/admin/unclaimed-users"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  See Unclaimed Users
                </Link>
                .
              </p>
            </div>
            <Button onClick={() => setAddDialogOpen(true)}>
              <Plus className="size-4 mr-2" />
              Add Account
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Organization Accounts</CardTitle>
            </CardHeader>
            <CardContent>
              {orgUsersLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : orgUsers.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">No administrators in this organization yet.</p>
              ) : (
                <UsersTable
                  users={orgUsers}
                  currentUser={currentUser}
                  orgLocations={orgLocations}
                  onDeleteUser={setDeleteUserId}
                  onResetPassword={setResetPasswordUserId}
                  onChangeEmail={setChangeEmailUserId}
                />
              )}
            </CardContent>
          </Card>

          <AddUserDialog
            open={addDialogOpen}
            onClose={() => setAddDialogOpen(false)}
            orgLocations={orgLocations}
          />

          <ResetPasswordDialog
            resetPasswordUserId={resetPasswordUserId}
            setResetPasswordUserId={setResetPasswordUserId}
            getUserToReset={getUserToReset}
            resetPasswordForm={resetPasswordForm}
            resetPasswordMutation={resetPasswordMutation}
          />

          <ChangeEmailDialog
            changeEmailUserId={changeEmailUserId}
            setChangeEmailUserId={setChangeEmailUserId}
            getUserToChangeEmail={getUserToChangeEmail}
            changeEmailForm={changeEmailForm}
            changeEmailMutation={changeEmailMutation}
          />

          <DeleteUserDialog
            deleteUserId={deleteUserId}
            setDeleteUserId={setDeleteUserId}
            getUserToDelete={getUserToDelete}
            deleteUserMutation={deleteUserMutation}
          />
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
