import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-neutral-surface-50">
      <Card className="w-full max-w-md mx-4">
        <CardContent padding="topComfortable">
          <div className="flex mb-4 gap-2">
            <AlertCircle className="size-8 text-danger-500" />
            <h1 className="text-2xl font-bold text-neutral-surface-900">404 Page Not Found</h1>
          </div>

          <p className="mt-4 text-sm text-neutral-surface-600">
            Did you forget to add the page to the router?
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
