import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

export function ErrorCard({ title, description, onRetry }: { title: string; description: string; onRetry?: () => void }) {
  return (
    <Card className="mx-auto max-w-md mt-8">
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-5 text-destructive" />
          <CardTitle>{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {onRetry && (
        <CardContent>
          <Button variant="outline" onClick={onRetry} className="w-full flex items-center">
            <RefreshCw className="size-4" />
            Try Again
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
