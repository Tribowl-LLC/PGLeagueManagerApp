import { FC } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

export const BackToDashboardButton: FC = () => {
  return (
    <div className="mb-6">
      <Button asChild variant="outline" className="flex items-center">
        <Link href="/">
          <ArrowRight className="size-4 rotate-180" />
          Back to Dashboard
        </Link>
      </Button>
    </div>
  );
};
