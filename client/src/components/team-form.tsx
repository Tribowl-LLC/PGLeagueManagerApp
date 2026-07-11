import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { insertTeamSchema, type InsertTeamInput, type InsertTeam } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { useTeams } from "@/hooks/use-teams";
import React from "react";

interface TeamFormProps {
  open: boolean;
  onClose: () => void;
  leagueId: number;
}

export function TeamForm({ open, onClose, leagueId }: TeamFormProps) {
  const { toast } = useToast();

  // Use the custom hook for team data
  const { nextTeamNumber, isLoading: loadingTeams } = useTeams({ 
    leagueId,
    enabled: open // Only fetch when dialog is open
  });

  const form = useForm<InsertTeamInput, unknown, InsertTeam>({
    resolver: zodResolver(insertTeamSchema),
    defaultValues: {
      name: "",
      leagueId,
      active: true,
      number: nextTeamNumber,
    },
  });

  // Update form value when teams data loads
  React.useEffect(() => {
    if (!loadingTeams) {
      form.setValue('number', nextTeamNumber);
    }
  }, [loadingTeams, nextTeamNumber, form]);

  const mutation = useMutation({
    mutationFn: async (data: InsertTeam) => {
      const response = await apiRequest("/api/teams", "POST", data);
      if (!response.success) {
        throw new Error(response.error?.message || "Failed to create team");
      }
      return response.data;
    },
    onSuccess: () => {
      // Invalidate both the teams list and the specific league's teams
      queryClient.invalidateQueries({ queryKey: ["/api/teams"] });
      queryClient.invalidateQueries({ queryKey: ["/api/teams", leagueId] });

      toast({
        title: "Success",
        description: "Team has been created successfully.",
      });
      onClose();
      form.reset();
    },
    onError: (error: Error) => {
      toast({
        title: "Error creating team",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = form.handleSubmit((data) => {
    // Ensure number is treated as a number
    mutation.mutate({
      ...data,
      number: Number(data.number)
    });
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Team</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Team Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="number"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Team Number</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min="1"
                      {...field}
                      onChange={(e) =>
                        field.onChange(parseInt(e.target.value, 10))
                      }
                      value={field.value || ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <FormLabel>Active</FormLabel>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-x-2">
              <Button 
                type="button" 
                variant="outline" 
                onClick={() => {
                  onClose();
                  form.reset();
                }}
              >
                Cancel
              </Button>
              <Button 
                type="submit" 
                disabled={mutation.isPending || loadingTeams}
              >
                {(mutation.isPending || loadingTeams) && (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                )}
                Add Team
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
