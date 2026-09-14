import { FC } from "react";
import { Link } from "wouter";
import { BowlerLayout } from "@/components/bowler-layout";

interface NoBowlerViewProps {
  userName: string | null | undefined;
  isSystemAdmin: boolean;
}

export const NoBowlerView: FC<NoBowlerViewProps> = ({ userName, isSystemAdmin }) => {
  return (
    <BowlerLayout bowlerName={userName || "Administrator"} leagueName="No Bowler Account">
      <div className="text-center space-y-4">
        <p>You don't have a bowler account linked to your user profile.</p>
        {isSystemAdmin && (
          <div className="p-4 border rounded-md bg-warning-50 max-w-md mx-auto">
            <p className="text-warning-800">As an administrator, you can view payment history by selecting a specific bowler.</p>
          </div>
        )}
        <Link href="/" className="inline-flex items-center px-4 py-2 rounded-md bg-primary text-white">
          Return to Dashboard
        </Link>
      </div>
    </BowlerLayout>
  );
};
