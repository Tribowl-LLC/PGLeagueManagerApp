import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import type { Organization } from '@shared/schema';

interface OrganizationConfirmDialogsProps {
  archiveConfirmId: number | null;
  setArchiveConfirmId: (id: number | null) => void;
  deleteConfirmId: number | null;
  setDeleteConfirmId: (id: number | null) => void;
  organizations: Organization[];
}

export function OrganizationConfirmDialogs({
  archiveConfirmId,
  setArchiveConfirmId,
  deleteConfirmId,
  setDeleteConfirmId,
  organizations,
}: OrganizationConfirmDialogsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  const archiveMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest(`/api/organizations/${id}/archive`, 'PATCH');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/organizations'] });
      toast({ title: 'Organization Archived', description: 'The organization has been archived and hidden from normal views.' });
      setArchiveConfirmId(null);
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: `Failed to archive organization: ${error.message}`, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest(`/api/organizations/${id}`, 'DELETE');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/organizations'] });
      toast({ title: 'Organization Deleted', description: 'The organization and all its data have been permanently deleted.' });
      setDeleteConfirmId(null);
      setDeleteConfirmName('');
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: `Failed to delete organization: ${error.message}`, variant: 'destructive' });
    },
  });

  return (
    <>
      <AlertDialog open={!!archiveConfirmId} onOpenChange={(open) => { if (!open) setArchiveConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Organization</AlertDialogTitle>
            <AlertDialogDescription>
              This will hide the organization from normal views. The organization and all its data will be preserved and can be restored at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => archiveConfirmId && archiveMutation.mutate(archiveConfirmId)}
              disabled={archiveMutation.isPending}
            >
              {archiveMutation.isPending ? 'Archiving...' : 'Archive Organization'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) { setDeleteConfirmId(null); setDeleteConfirmName(''); } }}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-5" />
              Permanently Delete Organization
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p className="font-semibold text-destructive">
                  This action is irreversible and cannot be undone.
                </p>
                <p>Permanently deleting this organization will also delete:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>All leagues belonging to this organization</li>
                  <li>All teams within those leagues</li>
                  <li>All bowler-league memberships</li>
                  <li>All payment records</li>
                  <li>All game and score history</li>
                  <li>All payment schedules</li>
                  <li>All non-system-administrator user accounts belonging to this organization</li>
                  <li>System administrators will be detached from this organization, not deleted</li>
                  <li>Organization-specific administrative audit history</li>
                </ul>
                <p className="text-sm">Consider archiving instead if you may need this data in the future.</p>
                <div className="pt-2">
                  <Label htmlFor="confirm-name" className="text-sm font-medium">
                    Type the organization name to confirm: <span className="font-bold">{organizations.find(o => o.id === deleteConfirmId)?.name}</span>
                  </Label>
                  <Input
                    id="confirm-name"
                    className="mt-1.5"
                    placeholder="Type organization name here"
                    value={deleteConfirmName}
                    onChange={(e) => setDeleteConfirmName(e.target.value)}
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteConfirmName('')}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteConfirmId && deleteMutation.mutate(deleteConfirmId)}
              disabled={
                deleteMutation.isPending ||
                deleteConfirmName !== organizations.find(o => o.id === deleteConfirmId)?.name
              }
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Permanently Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
