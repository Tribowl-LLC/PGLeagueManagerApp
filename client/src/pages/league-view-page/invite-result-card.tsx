import { Card, CardContent } from "@/components/ui/card";
import { Mail } from "lucide-react";

export function InviteResultCard({ inviteResult }: { inviteResult: { sent: number; alreadyRegistered: number; noEmail: number } }) {
  return (
    <Card>
      <CardContent padding="topComfortable">
        <div className="flex items-center gap-2 mb-2">
          <Mail className="size-5 text-primary" />
          <h3 className="font-semibold">Invite Results</h3>
        </div>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold text-primary">{inviteResult.sent}</p>
            <p className="text-sm text-muted-foreground">Invites Sent</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{inviteResult.alreadyRegistered}</p>
            <p className="text-sm text-muted-foreground">Already Registered</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{inviteResult.noEmail}</p>
            <p className="text-sm text-muted-foreground">No Email on File</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
