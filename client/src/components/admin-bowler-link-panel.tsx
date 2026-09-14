import { useMemo, FC } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ApiResponse } from "@shared/schema";
import { BowlerSearchPicker } from "@/components/bowler-search-picker";

interface LinkRow {
  id: number;
  bowlerAId: number;
  bowlerBId: number;
  status: "pending" | "accepted";
  organizationId: number;
  bowlerAName?: string;
  bowlerBName?: string;
}

export const AdminBowlerLinkPanel: FC<{ bowlerId: number; organizationId: number | null }> = ({
  bowlerId,
  organizationId,
}) => {
  const { toast } = useToast();

  const { data } = useQuery<ApiResponse<{ links: LinkRow[] }>>({
    queryKey: ["/api/bowler-links/admin", organizationId],
    queryFn: () => {
      const adminListUrl = organizationId
        ? `/api/bowler-links/admin?organizationId=${organizationId}`
        : "/api/bowler-links/admin";
      return apiRequest<{ links: LinkRow[] }>(adminListUrl, "GET");
    },
    staleTime: 30_000,
  });
  const all = data?.data?.links ?? [];
  const mine = all.filter((l) => l.bowlerAId === bowlerId || l.bowlerBId === bowlerId);

  const excludeIds = useMemo(
    () => [bowlerId, ...mine.map((l) => (l.bowlerAId === bowlerId ? l.bowlerBId : l.bowlerAId))],
    [bowlerId, mine],
  );

  const link = useMutation({
    mutationFn: async (otherId: number) =>
      apiRequest("/api/bowler-links/admin", "POST", { bowlerAId: bowlerId, bowlerBId: otherId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-links/admin"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-links"] });
      toast({ title: "Partner linked" });
    },
    onError: (err: Error) =>
      toast({ title: "Link failed", description: err.message, variant: "destructive" }),
  });

  const unlink = useMutation({
    mutationFn: async (id: number) => apiRequest(`/api/bowler-links/${id}`, "DELETE"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-links/admin"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-links"] });
    },
    onError: (err: Error) =>
      toast({ title: "Unlink failed", description: err.message, variant: "destructive" }),
  });

  return (
    <Card data-testid="card-admin-bowler-links" className="mt-4">
      <CardHeader>
        <CardTitle size="base">Payment partners (admin)</CardTitle>
        <CardDescription>Link this bowler to another bowler in the same organization.</CardDescription>
      </CardHeader>
      <CardContent spacing="tight">
        {mine.length > 0 && (
          <div className="space-y-2">
            {mine.map((l) => {
              const otherId = l.bowlerAId === bowlerId ? l.bowlerBId : l.bowlerAId;
              const otherName =
                l.bowlerAId === bowlerId ? l.bowlerBName : l.bowlerAName;
              return (
                <div
                  key={l.id}
                  data-testid={`row-admin-link-${l.id}`}
                  className="flex items-center justify-between rounded border p-2 text-sm"
                >
                  <span>{otherName?.trim() ? otherName : `Bowler #${otherId}`}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant={l.status === "accepted" ? "secondary" : "outline"}>
                      {l.status}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`button-admin-unlink-${l.id}`}
                      onClick={() => unlink.mutate(l.id)}
                      disabled={unlink.isPending}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <BowlerSearchPicker
          onSelect={(b) => link.mutate(b.id)}
          excludeIds={excludeIds}
          organizationId={organizationId}
          placeholder="Search bowlers by name…"
          disabled={link.isPending}
          testIdPrefix="admin-link-bowler"
        />
      </CardContent>
    </Card>
  );
};
