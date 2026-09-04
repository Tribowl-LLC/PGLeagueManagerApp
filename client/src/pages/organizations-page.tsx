import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Edit, Trash, Archive, RotateCcw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, shouldRetryApiQuery } from '@/lib/queryClient';
import type { Organization, User } from '@shared/schema';
import { Layout } from "@/components/layout";
import { Badge } from '@/components/ui/badge';
import { OrganizationFormDialog } from '@/components/organization-form-dialog';
import { OrganizationConfirmDialogs } from '@/components/organization-confirm-dialogs';
import { ErrorBoundary } from '@/components/error-boundary';
import { PageLoadingState, PageErrorState } from "@/components/page-states";

export default function OrganizationsPage() {
  const [open, setOpen] = useState(false);
  const [editOrg, setEditOrg] = useState<Organization | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [archiveConfirmId, setArchiveConfirmId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  const { data: userData } = useQuery<{success: boolean, data: User}>({
    queryKey: ['/api/user'],
  });
  const currentUser = userData?.data;

  const switchOrgMutation = useMutation({
    mutationFn: async (orgId: number) => {
      if (!currentUser) return;
      return apiRequest(`/api/organizations/user/${currentUser.id}/set`, 'POST', { organizationId: orgId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/user'] });
      setLocation('/home');
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: `Failed to switch organization: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  const { data, isLoading, error, refetch } = useQuery<{success: boolean, data: Organization[]}>({
    queryKey: ['/api/organizations'],
    retry: shouldRetryApiQuery,
    staleTime: 60000, // 1 minute
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });


  const restoreMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest(`/api/organizations/${id}/restore`, 'PATCH');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/organizations'] });
      toast({
        title: 'Organization Restored',
        description: 'The organization has been restored and is now active again.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: `Failed to restore organization: ${error.message}`,
        variant: 'destructive',
      });
    },
  });

  const handleEditClick = (org: Organization) => {
    setEditOrg(org);
    setOpen(true);
  };

  if (isLoading) {
    return (
      <Layout>
        <PageLoadingState message="Loading organizations..." />
      </Layout>
    );
  }

  if (error) {
    const errorMessage = (error as Error).message;
    const isAuthError = errorMessage.includes('not_authenticated') || 
                        errorMessage.includes('not authenticated') ||
                        errorMessage.includes('unauthorized');
    
    return (
      <Layout>
        <div className="container mx-auto py-10">
          <h1 className="text-3xl font-bold mb-6">
            {isAuthError ? 'Authentication Required' : 'Organizations'}
          </h1>
          <PageErrorState
            message={isAuthError
              ? 'You must be logged in to view organizations. Please log in and try again.'
              : `Failed to load organizations: ${errorMessage}`
            }
            onRetry={isAuthError ? undefined : () => refetch()}
          />
          {isAuthError && (
            <div className="mt-2">
              <Button variant="default" onClick={() => window.location.href = '/login'}>
                Log In
              </Button>
            </div>
          )}
        </div>
      </Layout>
    );
  }

  const allOrganizations = data?.data || [];
  const organizations = showArchived ? allOrganizations : allOrganizations.filter(o => o.active !== false);
  const archivedCount = allOrganizations.filter(o => o.active === false).length;

  return (
    <Layout>
      <div className="container mx-auto px-4 md:px-8 py-6 md:py-10 overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6">
          <h1 className="text-2xl md:text-3xl font-bold">Organizations</h1>
          <Button onClick={() => { setEditOrg(null); setOpen(true); }} className="w-full sm:w-auto">
            <Plus className="mr-2 size-4" /> Add Organization
          </Button>
        </div>

        <ErrorBoundary level="section">
        <Card className="overflow-hidden">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Organizations</CardTitle>
                <CardDescription>Manage all organizations in the system</CardDescription>
              </div>
              {archivedCount > 0 && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="show-archived" className="text-sm text-muted-foreground cursor-pointer">
                    Show archived ({archivedCount})
                  </Label>
                  <Switch
                    id="show-archived"
                    checked={showArchived}
                    onCheckedChange={setShowArchived}
                  />
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="px-0 sm:px-6">
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Slug</TableHead>
                  <TableHead className="hidden md:table-cell">Status</TableHead>
                  <TableHead className="hidden md:table-cell">Email</TableHead>
                  <TableHead className="hidden md:table-cell">Phone</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organizations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center">
                      No organizations found
                    </TableCell>
                  </TableRow>
                ) : (
                  organizations.map((org: Organization) => (
                    <TableRow key={org.id} className={org.active === false ? 'opacity-60' : ''}>
                      <TableCell className="font-medium">
                        {org.active !== false ? (
                          <button type="button"
                            className="inline-flex items-center gap-1.5 text-left hover:text-primary hover:underline transition-colors cursor-pointer"
                            onClick={() => switchOrgMutation.mutate(org.id)}
                            disabled={switchOrgMutation.isPending}
                          >
                            {org.name}
                          </button>
                        ) : (
                          org.name
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{org.slug}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {org.active === false ? (
                          <Badge variant="secondary">Archived</Badge>
                        ) : (
                          <Badge variant="default">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{org.email || '—'}</TableCell>
                      <TableCell className="hidden md:table-cell">{org.phone || '—'}</TableCell>
                      <TableCell>
                        <div className="flex gap-x-2">
                          <Button variant="outline" size="sm" onClick={() => handleEditClick(org)}>
                            <Edit className="size-4" />
                          </Button>
                          {org.active === false ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => restoreMutation.mutate(org.id)}
                              disabled={restoreMutation.isPending}
                            >
                              <RotateCcw className="size-4" />
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setArchiveConfirmId(org.id)}
                            >
                              <Archive className="size-4" />
                            </Button>
                          )}
                          <Button 
                            variant="destructive" 
                            size="sm"
                            onClick={() => setDeleteConfirmId(org.id)}
                          >
                            <Trash className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>
        </ErrorBoundary>

        <ErrorBoundary level="section">
        <OrganizationFormDialog
          open={open}
          onClose={() => { setOpen(false); setEditOrg(null); }}
          editOrg={editOrg}
        />

        <OrganizationConfirmDialogs
          archiveConfirmId={archiveConfirmId}
          setArchiveConfirmId={setArchiveConfirmId}
          deleteConfirmId={deleteConfirmId}
          setDeleteConfirmId={setDeleteConfirmId}
          organizations={organizations}
        />
        </ErrorBoundary>
      </div>
    </Layout>
  );
}
