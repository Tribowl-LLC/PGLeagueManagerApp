import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Layout } from '@/components/layout';
import { ErrorBoundary } from '@/components/error-boundary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import type { ApiResponse, Organization } from '@shared/schema';

type OrphanType = 'leagues' | 'teams' | 'bowlerLeagues' | 'payments' | 'users';

const TYPE_LABELS: Record<OrphanType, string> = {
  leagues: 'Leagues',
  teams: 'Teams',
  bowlerLeagues: 'Bowler-league assignments',
  payments: 'Payments',
  users: 'Users',
};

const REASSIGNABLE: Record<OrphanType, boolean> = {
  leagues: true,
  users: true,
  teams: false,
  bowlerLeagues: false,
  payments: false,
};

interface OrphanLeagueRow {
  id: number;
  name: string;
  active: boolean;
  seasonStart: string;
  seasonEnd: string;
}
interface OrphanTeamRow {
  id: number;
  name: string;
  number: number;
  leagueId: number;
  leagueName: string | null;
  parentLeagueExists: boolean;
}
interface OrphanBowlerLeagueRow {
  id: number;
  bowlerId: number;
  bowlerName: string | null;
  leagueId: number;
  leagueName: string | null;
  parentLeagueExists: boolean;
}
interface OrphanPaymentRow {
  id: number;
  amount: number;
  createdAt: string;
  bowlerId: number;
  bowlerName: string | null;
  leagueId: number;
  leagueName: string | null;
  parentLeagueExists: boolean;
}
interface OrphanUserRow {
  id: number;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

interface CleanupAuditRow {
  id: number;
  adminUserId: number;
  resourceType: OrphanType;
  resourceId: number;
  action: 'reassign' | 'delete' | 'undo_reassign';
  organizationId: number | null;
  previousOrganizationId: number | null;
  snapshot: unknown;
  undoneAt: string | null;
  undoneByAuditId: number | null;
  createdAt: string;
  adminUserName: string | null;
  adminUserEmail: string | null;
  organizationName: string | null;
}

type OrphanRow =
  | ({ _type: 'leagues' } & OrphanLeagueRow)
  | ({ _type: 'teams' } & OrphanTeamRow)
  | ({ _type: 'bowlerLeagues' } & OrphanBowlerLeagueRow)
  | ({ _type: 'payments' } & OrphanPaymentRow)
  | ({ _type: 'users' } & OrphanUserRow);

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  try { return new Date(value).toLocaleDateString(); } catch { return value; }
}

function OrphanCountsCard({ activeType, onPick }: { activeType: OrphanType; onPick: (t: OrphanType) => void }) {
  const { data, isLoading } = useQuery<ApiResponse<Record<OrphanType, number>>>({
    queryKey: ['/api/system-admin/orphaned-data-counts'],
  });
  const counts = data?.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Org-less record counts</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {(Object.keys(TYPE_LABELS) as OrphanType[]).map((t) => {
              const count = counts?.[t] ?? 0;
              const isActive = activeType === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => onPick(t)}
                  data-testid={`button-orphan-tab-${t}`}
                  className={`text-left rounded-lg border p-3 transition hover-elevate active-elevate-2 ${
                    isActive ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <div className="text-xs text-muted-foreground">{TYPE_LABELS[t]}</div>
                  <div className="text-2xl font-semibold mt-1">{count}</div>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface RepairDialogState {
  row: OrphanRow;
  mode: 'reassign' | 'delete';
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

function RecentActivityCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<ApiResponse<CleanupAuditRow[]>>({
    queryKey: ['/api/system-admin/orphaned-data-audits'],
  });
  const rows = data?.data ?? [];
  const [snapshot, setSnapshot] = useState<CleanupAuditRow | null>(null);

  const undoMutation = useMutation({
    mutationFn: async (auditId: number) =>
      apiRequest(`/api/system-admin/orphaned-data-audits/${auditId}/undo`, 'POST'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/orphaned-data-audits'] });
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/orphaned-data-counts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/orphaned-data'] });
      toast({ title: 'Cleanup undone', description: 'The reassign was reverted and a new audit row was recorded.' });
    },
    onError: (error: Error) => {
      toast({ title: 'Undo failed', description: error.message, variant: 'destructive' });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent cleanup activity</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">
            No cleanup actions recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Admin</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead className="text-right">Undo / snapshot</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const isUndo = row.action === 'undo_reassign';
                  const isReassign = row.action === 'reassign';
                  const isDelete = row.action === 'delete';
                  const undone = row.undoneAt !== null;
                  return (
                    <TableRow key={row.id} data-testid={`row-cleanup-audit-${row.id}`}>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(row.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.adminUserName ?? row.adminUserEmail ?? `User #${row.adminUserId}`}
                      </TableCell>
                      <TableCell>
                        {isDelete ? (
                          <Badge variant="destructive">Delete</Badge>
                        ) : isUndo ? (
                          <Badge variant="secondary">Undo reassign</Badge>
                        ) : (
                          <Badge>Reassign</Badge>
                        )}
                        {undone && (
                          <Badge variant="outline" className="ml-2" data-testid={`badge-audit-undone-${row.id}`}>Undone</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="font-medium">{TYPE_LABELS[row.resourceType] ?? row.resourceType}</span>
                        <span className="text-xs text-muted-foreground ml-1 font-mono">#{row.resourceId}</span>
                      </TableCell>
                      <TableCell className="text-sm">
                        {isDelete ? (
                          <span className="text-muted-foreground">-</span>
                        ) : (
                          row.organizationName ?? (row.organizationId !== null ? `#${row.organizationId}` : '—')
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {isReassign && !undone && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={undoMutation.isPending}
                            onClick={() => undoMutation.mutate(row.id)}
                            data-testid={`button-undo-audit-${row.id}`}
                          >
                            Undo
                          </Button>
                        )}
                        {isDelete && row.snapshot !== null && row.snapshot !== undefined && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSnapshot(row)}
                            data-testid={`button-view-snapshot-${row.id}`}
                          >
                            View snapshot
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <Dialog open={!!snapshot} onOpenChange={(open) => { if (!open) setSnapshot(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Deleted row snapshot</DialogTitle>
              <DialogDescription>
                {snapshot && (
                  <>Captured when {snapshot.adminUserName ?? snapshot.adminUserEmail ?? `user #${snapshot.adminUserId}`} deleted{' '}
                  {TYPE_LABELS[snapshot.resourceType] ?? snapshot.resourceType} #{snapshot.resourceId} on{' '}
                  {formatTimestamp(snapshot.createdAt)}. Use this to reconstruct the row by hand if the delete was a mistake.</>
                )}
              </DialogDescription>
            </DialogHeader>
            <pre
              className="bg-muted p-3 rounded text-xs overflow-auto max-h-96"
              data-testid="text-snapshot-json"
            >
              {snapshot ? JSON.stringify(snapshot.snapshot, null, 2) : ''}
            </pre>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSnapshot(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export default function DataIntegrityPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeType, setActiveType] = useState<OrphanType>('leagues');
  const [repair, setRepair] = useState<RepairDialogState | null>(null);
  const [reassignOrgId, setReassignOrgId] = useState<string>('');

  const { data: rowsResponse, isLoading: rowsLoading } = useQuery<ApiResponse<unknown[]>>({
    queryKey: ['/api/system-admin/orphaned-data', activeType],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/system-admin/orphaned-data/${activeType}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || `Failed to fetch orphaned ${activeType}`);
      }
      return response.json() as Promise<ApiResponse<unknown[]>>;
    },
  });
  const rows = (rowsResponse?.data ?? []) as unknown[];

  const { data: orgsResponse } = useQuery<ApiResponse<Organization[]>>({
    queryKey: ['/api/organizations'],
  });
  const organizations = orgsResponse?.data ?? [];

  const reassignMutation = useMutation({
    mutationFn: async (vars: { type: OrphanType; id: number; organizationId: number }) =>
      apiRequest(
        `/api/system-admin/orphaned-data/${vars.type}/${vars.id}/reassign`,
        'POST',
        { organizationId: vars.organizationId },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/orphaned-data-counts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/orphaned-data', activeType] });
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/orphaned-data-audits'] });
      setRepair(null);
      setReassignOrgId('');
      toast({ title: 'Row reassigned', description: 'The orphaned row now belongs to the selected organization.' });
    },
    onError: (error: Error) => {
      toast({ title: 'Reassign failed', description: error.message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (vars: { type: OrphanType; id: number }) =>
      apiRequest(`/api/system-admin/orphaned-data/${vars.type}/${vars.id}/delete`, 'POST'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/orphaned-data-counts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/orphaned-data', activeType] });
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/orphaned-data-audits'] });
      setRepair(null);
      toast({ title: 'Row deleted', description: 'The orphaned row was removed.' });
    },
    onError: (error: Error) => {
      toast({ title: 'Delete failed', description: error.message, variant: 'destructive' });
    },
  });

  const openReassign = (row: OrphanRow) => { setRepair({ row, mode: 'reassign' }); setReassignOrgId(''); };
  const openDelete = (row: OrphanRow) => setRepair({ row, mode: 'delete' });

  const renderRow = (raw: unknown, idx: number) => {
    const row = { ...(raw as object), _type: activeType } as OrphanRow;
    const reassignable = REASSIGNABLE[activeType];
    const actions = (
      <div className="flex gap-2 justify-end">
        {reassignable && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => openReassign(row)}
            data-testid={`button-reassign-${activeType}-${(row as { id: number }).id}`}
          >
            Reassign
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openDelete(row)}
          data-testid={`button-delete-${activeType}-${(row as { id: number }).id}`}
        >
          Delete
        </Button>
      </div>
    );

    switch (row._type) {
      case 'leagues':
        return (
          <TableRow key={`league-${row.id}`}>
            <TableCell className="font-mono text-xs">{row.id}</TableCell>
            <TableCell className="font-medium">{row.name}</TableCell>
            <TableCell>{row.active ? <Badge>Active</Badge> : <Badge variant="outline">Archived</Badge>}</TableCell>
            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
              {formatDate(row.seasonStart)} – {formatDate(row.seasonEnd)}
            </TableCell>
            <TableCell className="text-right">{actions}</TableCell>
          </TableRow>
        );
      case 'teams':
        return (
          <TableRow key={`team-${row.id}`}>
            <TableCell className="font-mono text-xs">{row.id}</TableCell>
            <TableCell className="font-medium">#{row.number} {row.name}</TableCell>
            <TableCell>
              {row.parentLeagueExists ? (
                <span className="text-sm">{row.leagueName ?? '—'} <span className="text-xs text-muted-foreground">(#{row.leagueId})</span></span>
              ) : (
                <Badge variant="destructive">Missing league #{row.leagueId}</Badge>
              )}
            </TableCell>
            <TableCell className="text-right">{actions}</TableCell>
          </TableRow>
        );
      case 'bowlerLeagues':
        return (
          <TableRow key={`bl-${row.id}`}>
            <TableCell className="font-mono text-xs">{row.id}</TableCell>
            <TableCell className="font-medium">{row.bowlerName ?? `Bowler #${row.bowlerId}`}</TableCell>
            <TableCell>
              {row.parentLeagueExists ? (
                <span className="text-sm">{row.leagueName ?? '—'} <span className="text-xs text-muted-foreground">(#{row.leagueId})</span></span>
              ) : (
                <Badge variant="destructive">Missing league #{row.leagueId}</Badge>
              )}
            </TableCell>
            <TableCell className="text-right">{actions}</TableCell>
          </TableRow>
        );
      case 'payments':
        return (
          <TableRow key={`pay-${row.id}`}>
            <TableCell className="font-mono text-xs">{row.id}</TableCell>
            <TableCell className="font-medium">{formatCents(row.amount)}</TableCell>
            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{formatDate(row.createdAt)}</TableCell>
            <TableCell>{row.bowlerName ?? `Bowler #${row.bowlerId}`}</TableCell>
            <TableCell>
              {row.parentLeagueExists ? (
                <span className="text-sm">{row.leagueName ?? '—'} <span className="text-xs text-muted-foreground">(#{row.leagueId})</span></span>
              ) : (
                <Badge variant="destructive">Missing league #{row.leagueId}</Badge>
              )}
            </TableCell>
            <TableCell className="text-right">{actions}</TableCell>
          </TableRow>
        );
      case 'users':
        return (
          <TableRow key={`user-${row.id}`}>
            <TableCell className="font-mono text-xs">{row.id}</TableCell>
            <TableCell className="font-medium">{row.name}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{row.email}</TableCell>
            <TableCell><Badge variant="outline">{row.role}</Badge></TableCell>
            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{formatDate(row.createdAt)}</TableCell>
            <TableCell className="text-right">{actions}</TableCell>
          </TableRow>
        );
    }
  };

  const headerForType = () => {
    switch (activeType) {
      case 'leagues':
        return ['ID', 'Name', 'Status', 'Season', ''];
      case 'teams':
        return ['ID', 'Team', 'Parent league', ''];
      case 'bowlerLeagues':
        return ['ID', 'Bowler', 'Parent league', ''];
      case 'payments':
        return ['ID', 'Amount', 'Collected', 'Bowler', 'Parent league', ''];
      case 'users':
        return ['ID', 'Name', 'Email', 'Role', 'Created', ''];
    }
  };

  const repairRow = repair?.row;
  const repairId = repairRow ? (repairRow as { id: number }).id : null;
  const repairLabel = repairRow ? describeRow(repairRow) : '';

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="container py-6 space-y-6">
          <div>
            <h1 className="text-4xl font-bold">Data integrity</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Surfaces records whose effective organization is missing. Regular CRUD pages hide these rows
              by policy, so this is the only place to see them or fix them.
            </p>
          </div>

          <OrphanCountsCard activeType={activeType} onPick={setActiveType} />

          <Card>
            <CardHeader>
              <CardTitle>{TYPE_LABELS[activeType]} ({rows.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {rowsLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : rows.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No org-less {TYPE_LABELS[activeType].toLowerCase()} found. Nothing to clean up here.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {headerForType().map((h, i) => (
                          <TableHead key={h} className={i === headerForType().length - 1 ? 'text-right' : ''}>{h}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map(renderRow)}
                    </TableBody>
                  </Table>
                </div>
              )}
              {!REASSIGNABLE[activeType] && rows.length > 0 && (
                <p className="text-xs text-muted-foreground mt-3">
                  These rows inherit their organization from the parent league. Reassign the parent league
                  on the Leagues tab to fix all child rows at once, or delete individual rows here.
                </p>
              )}
            </CardContent>
          </Card>

          <RecentActivityCard />

          <Dialog open={!!repair} onOpenChange={(open) => { if (!open) { setRepair(null); setReassignOrgId(''); } }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {repair?.mode === 'reassign' ? 'Reassign to organization' : 'Delete orphaned row'}
                </DialogTitle>
                <DialogDescription>
                  {repair?.mode === 'reassign'
                    ? `Move ${repairLabel} into an organization. Existing access-control rules will start applying immediately.`
                    : `Permanently delete ${repairLabel}. This cannot be undone.`}
                </DialogDescription>
              </DialogHeader>

              {repair?.mode === 'reassign' && (
                <div className="space-y-2">
                  <Label htmlFor="reassign-org">Organization</Label>
                  <Select value={reassignOrgId} onValueChange={setReassignOrgId}>
                    <SelectTrigger id="reassign-org" data-testid="select-reassign-org">
                      <SelectValue placeholder="Select an organization" />
                    </SelectTrigger>
                    <SelectContent>
                      {organizations.map((o) => (
                        <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => { setRepair(null); setReassignOrgId(''); }}>Cancel</Button>
                {repair?.mode === 'reassign' ? (
                  <Button
                    disabled={reassignMutation.isPending || !reassignOrgId}
                    onClick={() => repairId !== null && reassignMutation.mutate({
                      type: activeType,
                      id: repairId,
                      organizationId: parseInt(reassignOrgId, 10),
                    })}
                    data-testid="button-confirm-reassign"
                  >
                    {reassignMutation.isPending ? 'Saving…' : 'Reassign'}
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    disabled={deleteMutation.isPending}
                    onClick={() => repairId !== null && deleteMutation.mutate({ type: activeType, id: repairId })}
                    data-testid="button-confirm-delete"
                  >
                    {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </ErrorBoundary>
    </Layout>
  );
}

function describeRow(row: OrphanRow): string {
  switch (row._type) {
    case 'leagues': return `league "${row.name}" (#${row.id})`;
    case 'teams': return `team #${row.number} "${row.name}" (id ${row.id})`;
    case 'bowlerLeagues': return `assignment #${row.id} (${row.bowlerName ?? `bowler #${row.bowlerId}`})`;
    case 'payments': return `payment #${row.id}`;
    case 'users': return `user "${row.name}" (${row.email})`;
  }
}
