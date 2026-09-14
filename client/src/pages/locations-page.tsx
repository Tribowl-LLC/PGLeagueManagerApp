import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/error-boundary";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Plus, Edit, Trash, Archive, RotateCcw } from "lucide-react";
import { PageLoadingState } from "@/components/page-states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Location } from "@shared/schema";
import { Layout } from "@/components/layout";
import { LocationFormDialog } from "@/components/location-form-dialog";
import { ConfirmArchiveDialog } from "@/components/confirm-archive-dialog";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";

export default function LocationsPage() {
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [archiveConfirmId, setArchiveConfirmId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ success: boolean; data: Location[] }>({
    queryKey: ["/api/locations"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest(`/api/locations/${id}`, "DELETE"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      toast({ title: "Location Deleted", description: "The location and all its data have been permanently deleted." });
      setDeleteConfirmId(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: `Failed to delete location: ${error.message}`, variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: number) => apiRequest(`/api/locations/${id}/archive`, "PATCH"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      toast({ title: "Location Archived", description: "The location has been archived and hidden from normal views." });
      setArchiveConfirmId(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: `Failed to archive location: ${error.message}`, variant: "destructive" });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (id: number) => apiRequest(`/api/locations/${id}/restore`, "PATCH"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      toast({ title: "Location Restored", description: "The location has been restored and is now active again." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: `Failed to restore location: ${error.message}`, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <Layout>
        <PageLoadingState />
      </Layout>
    );
  }

  const allLocations = data?.data || [];
  const locations = showArchived ? allLocations : allLocations.filter((l) => l.active !== false);
  const archivedCount = allLocations.filter((l) => l.active === false).length;
  const deleteTargetName = allLocations.find((l) => l.id === deleteConfirmId)?.name;

  const handleEditClick = (loc: Location) => {
    setEditingLocation(loc);
    setFormOpen(true);
  };

  const handleAddClick = () => {
    setEditingLocation(null);
    setFormOpen(true);
  };

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Locations</h1>
          <Button onClick={handleAddClick}>
            <Plus className="size-4 mr-2" />
            Add Location
          </Button>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Locations</CardTitle>
                <CardDescription>Manage bowling locations for your organization</CardDescription>
              </div>
              {archivedCount > 0 && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="show-archived-locations" size="sm" tone="muted" className="cursor-pointer">
                    Show archived ({archivedCount})
                  </Label>
                  <Switch
                    id="show-archived-locations"
                    checked={showArchived}
                    onCheckedChange={setShowArchived}
                  />
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center">No locations found</TableCell>
                  </TableRow>
                ) : (
                  locations.map((loc) => (
                    <TableRow key={loc.id} state={loc.active === false ? "muted" : "default"}>
                      <TableCell weight="medium">{loc.name}</TableCell>
                      <TableCell>{loc.address || "—"}</TableCell>
                      <TableCell>{loc.city || "—"}</TableCell>
                      <TableCell>{loc.state || "—"}</TableCell>
                      <TableCell>{loc.phone || "—"}</TableCell>
                      <TableCell>
                        <Badge variant={loc.active === false ? "secondary" : "default"}>
                          {loc.active === false ? "Archived" : "Active"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-x-2">
                          <Button variant="outline" size="sm" onClick={() => handleEditClick(loc)}>
                            <Edit className="size-4" />
                          </Button>
                          {loc.active === false ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => restoreMutation.mutate(loc.id)}
                              disabled={restoreMutation.isPending}
                            >
                              <RotateCcw className="size-4" />
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setArchiveConfirmId(loc.id)}
                            >
                              <Archive className="size-4" />
                            </Button>
                          )}
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setDeleteConfirmId(loc.id)}
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
          </CardContent>
        </Card>

        <LocationFormDialog
          open={formOpen}
          onClose={() => setFormOpen(false)}
          location={editingLocation}
        />

        <ConfirmArchiveDialog
          open={!!archiveConfirmId}
          onOpenChange={(open) => { if (!open) setArchiveConfirmId(null); }}
          title="Archive Location"
          description="This will hide the location from normal views. The location and all its data will be preserved and can be restored at any time."
          actionLabel="Archive Location"
          pendingLabel="Archiving..."
          isPending={archiveMutation.isPending}
          onConfirm={() => archiveConfirmId && archiveMutation.mutate(archiveConfirmId)}
        />

        <ConfirmDeleteDialog
          open={!!deleteConfirmId}
          onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}
          title="Permanently Delete Location"
          itemLabel="location"
          itemName={deleteTargetName}
          consequencesIntro="Permanently deleting this location will:"
          consequences={[
            "Remove the location from all associated leagues",
            "Permanently delete the location record",
          ]}
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteConfirmId && deleteMutation.mutate(deleteConfirmId)}
        />
      </ErrorBoundary>
    </Layout>
  );
}
