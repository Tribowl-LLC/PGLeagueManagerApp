import { MapPin, Shield, Send, Trash2, KeyRound, Mail } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { invalidateOrgAdminUsers } from "@/lib/query-keys";
import { apiRequest } from "@/lib/queryClient";

interface UsersTableLinkedBowler {
  id: number;
  name: string;
  leagueName: string | null;
  teamName: string | null;
}

/** Public invitation lifecycle state returned by the organization users API. */
export interface UsersTableInvitation {
  id: number;
  action: "account_invite" | "password_reset";
  status: "pending" | "consumed" | "superseded" | "revoked" | "expired";
  deliveryStatus: "not_attempted" | "sent" | "failed";
  expiresAt: string;
  deliveryAttemptedAt: string | null;
  deliveredAt: string | null;
  expiredAt: string | null;
  createdAt: string;
}

export interface UsersTableUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
  organizationId: number | null;
  locationId: number | null;
  bowlerId: number | null;
  invitation: UsersTableInvitation | null;
  createdAt: string;
  linkedBowler: UsersTableLinkedBowler | null;
}

export interface UsersTableLocation {
  id: number;
  name: string;
  organizationId: number;
}

interface Props {
  users: UsersTableUser[];
  currentUser: UsersTableUser | undefined;
  orgLocations: UsersTableLocation[];
  onDeleteUser: (id: number) => void;
  onResetPassword: (id: number) => void;
  onChangeEmail: (id: number) => void;
}

const hasPendingInvite = (user: UsersTableUser) => user.invitation?.status === "pending";
const canResendInvite = (user: UsersTableUser) =>
  user.invitation?.status === "pending"
  || user.invitation?.status === "expired"
  || user.invitation?.status === "revoked";

const invitationStatusLabel = (user: UsersTableUser) => {
  if (user.invitation?.status === "expired") return "Invite expired";
  if (user.invitation?.status === "revoked") return "Invite revoked";
  if (!hasPendingInvite(user)) return "Active";
  return user.invitation?.deliveryStatus === "failed" ? "Invite failed" : "Pending";
};

export function UsersTable({ users, currentUser, orgLocations, onDeleteUser, onResetPassword, onChangeEmail }: Props) {
  const { toast } = useToast();

  // NOTE (react-doctor audit): react-doctor reports the role/location
  // mutations below as missing cache invalidation. False positive —
  // invalidation is delegated to the shared invalidateOrgAdminUsers() helper
  // in each onSuccess. Audited; leave as-is.
  const updateRoleMutation = useMutation({
    mutationFn: async ({ userId, role, makeOrgAdmin }: { userId: number; role: string; makeOrgAdmin: boolean }) => {
      // `makeOrgAdmin` remains for the current endpoint contract; `role` is
      // sent alongside it so the server can persist payment_manager without
      // requiring a second client contract during rollout.
      return apiRequest(`/api/org-admin/users/${userId}/admin-status`, "PATCH", { role, makeOrgAdmin });
    },
    onSuccess: () => {
      invalidateOrgAdminUsers();
      toast({ title: "Role updated", description: "User role has been updated." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateLocationMutation = useMutation({
    mutationFn: async ({ userId, locationId }: { userId: number; locationId: number | null }) => {
      return apiRequest(`/api/org-admin/users/${userId}/location`, "PATCH", { locationId });
    },
    onSuccess: () => {
      invalidateOrgAdminUsers();
      toast({ title: "Location updated", description: "User location assignment has been updated." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const resendInviteMutation = useMutation({
    mutationFn: async (userId: number) => {
      return apiRequest<{ emailSent: boolean }>(`/api/org-admin/users/${userId}/resend-invite`, "POST");
    },
    onSuccess: (response) => {
      invalidateOrgAdminUsers();
      const emailSent = response?.data?.emailSent !== false;
      toast({
        title: emailSent ? "Invite sent" : "Invite delivery failed",
        description: emailSent
          ? "A new invitation email has been sent."
          : "A new invitation is active, but email delivery failed. You can retry safely.",
        variant: emailSent ? "default" : "destructive",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Location</TableHead>
          <TableHead className="w-[120px]"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="font-medium">{user.name || "—"}</TableCell>
            <TableCell>{user.email}</TableCell>
            <TableCell>
              {user.invitation && user.invitation.status !== "consumed" && user.invitation.status !== "superseded" ? (
                <Badge variant="outline" className="text-amber-600 border-amber-300">{invitationStatusLabel(user)}</Badge>
              ) : (
                <Badge variant="outline" className="text-green-600 border-green-300">Active</Badge>
              )}
            </TableCell>
            <TableCell>
              <Select
                value={user.role === "org_admin" || user.role === "system_admin" ? "admin" : user.role === "payment_manager" ? "payment_manager" : "user"}
                onValueChange={(value) => {
                  if (user.id === currentUser?.id) {
                    toast({ title: "Error", description: "You cannot change your own role.", variant: "destructive" });
                    return;
                  }
                  if (value === "payment_manager" && user.locationId === null) {
                    toast({ title: "Location required", description: "Assign a location before making this user a payment manager.", variant: "destructive" });
                    return;
                  }
                  updateRoleMutation.mutate({ userId: user.id, role: value, makeOrgAdmin: value === "admin" });
                }}
                disabled={user.id === currentUser?.id}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">
                    <span className="flex items-center gap-1.5">
                      <MapPin className="size-3.5" />
                      Bowler Account
                    </span>
                  </SelectItem>
                  <SelectItem value="admin">
                    <span className="flex items-center gap-1.5">
                      <Shield className="size-3.5" />
                      Admin
                    </span>
                  </SelectItem>
                  <SelectItem value="payment_manager">
                    <span className="flex items-center gap-1.5">
                      <MapPin className="size-3.5" />
                      Payment Manager
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </TableCell>
            <TableCell>
              {user.role === "org_admin" || user.role === "system_admin" ? (
                <Badge variant="secondary">All Locations</Badge>
              ) : (
                <Select
                  value={user.locationId ? String(user.locationId) : "none"}
                  onValueChange={(value) => {
                    updateLocationMutation.mutate({
                      userId: user.id,
                      locationId: value === "none" ? null : parseInt(value),
                    });
                  }}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Select location" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No location</SelectItem>
                    {orgLocations.map((loc) => (
                      <SelectItem key={loc.id} value={String(loc.id)}>{loc.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1">
                {canResendInvite(user) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => resendInviteMutation.mutate(user.id)}
                    disabled={resendInviteMutation.isPending}
                    title="Resend invite email"
                  >
                    <Send className="size-4" />
                  </Button>
                )}
                {user.id !== currentUser?.id
                  && user.role !== "system_admin"
                  && (currentUser?.role !== "org_admin"
                    || user.organizationId === currentUser?.organizationId) && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onChangeEmail(user.id)}
                      title="Change email"
                      aria-label={`Change email for ${user.name || user.email}`}
                      data-testid={`button-change-email-${user.id}`}
                    >
                      <Mail className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onResetPassword(user.id)}
                      title="Reset password"
                      aria-label={`Reset password for ${user.name || user.email}`}
                      data-testid={`button-reset-password-${user.id}`}
                    >
                      <KeyRound className="size-4" />
                    </Button>
                  </>
                )}
                {user.id !== currentUser?.id && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDeleteUser(user.id)}
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
