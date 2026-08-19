import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { UsersTableLocation } from "@/components/users-table";

interface Props {
  open: boolean;
  onClose: () => void;
  orgLocations: UsersTableLocation[];
}

export function AddUserDialog({ open, onClose, orgLocations }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("admin");
  const [locationId, setLocationId] = useState<string>("none");

  const reset = () => {
    setFirstName("");
    setLastName("");
    setEmail("");
    setRole("admin");
    setLocationId("none");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const createUserMutation = useMutation({
    mutationFn: async (data: {
      firstName: string;
      lastName: string;
      email: string;
      role: string;
      makeOrgAdmin: boolean;
      locationId: number | null;
    }): Promise<{ emailSent?: boolean }> => {
      return apiRequest("/api/org-admin/users/create", "POST", data) as Promise<{ emailSent?: boolean }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-admin/users"] });
      handleClose();
      const emailSent = data?.emailSent !== false;
      toast({
        title: "User created",
        description: emailSent
          ? "An email has been sent to the user to set up their password."
          : "User created but the invitation email could not be sent. You can resend it from the user list.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Organization Account</DialogTitle>
          <DialogDescription>
            Invite an administrator or a location-scoped payment manager. Bowler accounts are created from league rosters or self-registration.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="firstName">First Name</Label>
              <Input
                id="firstName"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="First name"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="lastName">Last Name</Label>
              <Input
                id="lastName"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Last name"
                className="mt-1"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="email">Email Address</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="mt-1"
            />
          </div>

          <div>
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="payment_manager">Payment Manager: record assigned-location payments</SelectItem>
                <SelectItem value="admin">Organization Admin: can access all locations</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {role === "payment_manager" && (
            <div>
              <Label>Assign Location{role === "payment_manager" ? " (required)" : ""}</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select location" />
                </SelectTrigger>
                <SelectContent>
                  {orgLocations.map((loc) => (
                    <SelectItem key={loc.id} value={String(loc.id)}>{loc.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button
            disabled={!firstName.trim() || !lastName.trim() || !email.trim()
              || (role === "payment_manager" && locationId === "none")
              || createUserMutation.isPending}
            onClick={() => {
              createUserMutation.mutate({
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: email.trim(),
                role,
                makeOrgAdmin: role === "admin",
                locationId: role === "admin" ? null : parseInt(locationId),
              });
            }}
          >
            {createUserMutation.isPending ? "Creating..." : "Create User"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
