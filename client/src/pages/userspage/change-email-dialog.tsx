import type { UseFormReturn } from 'react-hook-form';
import type { UseMutationResult } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import type { UsersTableUser } from '@/components/users-table';
import type { EmailChangeResponse } from '@/pages/users-page';

type ChangeEmailDialogFormValues = { email: string };

interface Props {
  changeEmailUserId: number | null;
  setChangeEmailUserId: (id: number | null) => void;
  getUserToChangeEmail: UsersTableUser | undefined | null;
  changeEmailForm: UseFormReturn<ChangeEmailDialogFormValues>;
  changeEmailMutation: UseMutationResult<
    EmailChangeResponse,
    Error,
    { userId: number; email: string }
  >;
}

export function ChangeEmailDialog({
  changeEmailUserId,
  setChangeEmailUserId,
  getUserToChangeEmail,
  changeEmailForm,
  changeEmailMutation,
}: Props) {
  return (
    <Dialog
      open={!!changeEmailUserId}
      onOpenChange={(open) => !open && setChangeEmailUserId(null)}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change email</DialogTitle>
          <DialogDescription>
            Request a new sign-in email for{' '}
            <span className="font-medium">
              {getUserToChangeEmail?.name || getUserToChangeEmail?.email}
            </span>
            . Their sign-in email only changes after the new address confirms. We’ll show whether the email request was accepted.
          </DialogDescription>
        </DialogHeader>
        <Form {...changeEmailForm}>
          <form
            noValidate
            onSubmit={changeEmailForm.handleSubmit((values) => {
              if (changeEmailUserId === null) return;
              changeEmailMutation.mutate({
                userId: changeEmailUserId,
                email: values.email,
              });
            })}
            className="space-y-4"
          >
            <FormField
              control={changeEmailForm.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="off"
                      placeholder="user@example.com"
                      data-testid="input-change-email"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setChangeEmailUserId(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={changeEmailMutation.isPending}
                data-testid="button-confirm-change-email"
              >
                {changeEmailMutation.isPending ? 'Sending…' : 'Send confirmation'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
