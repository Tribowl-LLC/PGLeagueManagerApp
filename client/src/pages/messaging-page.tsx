import { useQuery, useQueries } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CreditCard, MessageSquare, Info, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import type { ApiResponse, User, Location } from "@shared/schema";

// Square location config payload (mirrors what the Integrations page reads).
interface SquareLocationConfig {
  accessTokenConfigured?: boolean;
  appIdConfigured?: boolean;
  locationId?: string | null;
}

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <Badge
      variant={connected ? "default" : "outline"}
      className={connected ? "bg-emerald-500 hover:bg-emerald-600" : ""}
      data-testid={connected ? "badge-connected" : "badge-not-connected"}
    >
      {connected ? "Connected" : "Not connected"}
    </Badge>
  );
}

function MessagingContent() {
  const { data: locationsResp } = useQuery<ApiResponse<Location[]>>({
    queryKey: ["/api/locations"],
    staleTime: 1000 * 60 * 5,
  });

  // Per-location Square credential check. `useQueries` is the rules-of-hooks-
  // safe way to fan out one request per location: the array shape is stable
  // across renders for a given location set, and React Query keys each entry
  // independently so we don't lose cache on remount.
  const locations = locationsResp?.data ?? [];
  const squareConfigQueries = useQueries({
    queries: locations.map((loc) => ({
      queryKey: ["/api/locations", loc.id, "square-config"] as const,
      // Default fetcher only uses queryKey[0] as the URL, so per-
      // location queries MUST supply their own queryFn — otherwise
      // every entry would hit `/api/locations` and `squareConnected`
      // would silently be wrong.
      queryFn: async () => {
        const res = await fetch(`/api/locations/${loc.id}/square-config`, {
          credentials: "include",
        });
        if (!res.ok) {
          throw new Error(`Failed to fetch Square config: ${res.status}`);
        }
        return res.json() as Promise<ApiResponse<SquareLocationConfig>>;
      },
      staleTime: 1000 * 60 * 5,
    })),
  });
  const squareConnected = squareConfigQueries.some(
    (q) => (q.data as ApiResponse<SquareLocationConfig> | undefined)?.data?.accessTokenConfigured === true,
  );

  const noneConnected = !squareConnected;

  return (
    <>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="size-10 rounded-lg bg-indigo-500 flex items-center justify-center">
            <MessageSquare className="text-white size-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold" data-testid="page-title">Messaging</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              Reach the right bowlers using your existing tools.
            </p>
          </div>
        </div>
      </div>

      {noneConnected && (
        <Alert className="mb-6" data-testid="alert-no-platforms">
          <Info className="size-4" />
          <AlertTitle>No messaging platforms connected yet</AlertTitle>
          <AlertDescription>
            Connect Square on the{" "}
            <Link href="/integrations" className="underline font-medium">
              Integrations page
            </Link>{" "}
            to send targeted email or SMS to your bowlers.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 max-w-2xl">
        {/* Square card — describes Smart Lists driven by custom attributes. */}
        <Card data-testid="card-square">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-lg bg-slate-900 flex items-center justify-center">
                  <CreditCard className="text-white size-5" />
                </div>
                <CardTitle className="text-base">Square Marketing</CardTitle>
              </div>
              <StatusBadge connected={squareConnected} />
            </div>
          </CardHeader>
          <CardContent className="text-sm space-y-4">
            <p className="text-muted-foreground">
              When you assign a bowler to a league, we automatically tag their
              Square customer record with two filters you can use to build
              Smart Lists in Square Marketing.
            </p>
            <div className="rounded-md border bg-slate-50 p-4 space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs bg-white border px-1.5 py-0.5 rounded">
                  League Name
                </span>
                <span className="text-muted-foreground text-xs">
                  e.g. "Tuesday Night Mixed"
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs bg-white border px-1.5 py-0.5 rounded">
                  League Season
                </span>
                <span className="text-muted-foreground text-xs">
                  e.g. "Fall '25 Season"
                </span>
              </div>
            </div>
            <div>
              <h4 className="font-medium mb-2">Send a Smart Campaign</h4>
              <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
                <li>Open Square Dashboard → Customers → Smart Lists.</li>
                <li>
                  Click <strong>Create Smart List</strong>.
                </li>
                <li>
                  Add a filter on{" "}
                  <strong>Custom Attribute → League Name</strong> (or League
                  Season) and pick the value you want to message.
                </li>
                <li>
                  Save the list, then open Square Marketing and choose this
                  list as the audience.
                </li>
              </ol>
            </div>
            {squareConnected && (
              <a
                href="https://app.squareup.com/dashboard/customers/directory"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-indigo-600 hover:text-indigo-700 font-medium"
                data-testid="link-square-dashboard"
              >
                Open Square Dashboard
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </CardContent>
        </Card>

      </div>

      <Alert className="mt-6">
        <Info className="size-4" />
        <AlertTitle>How attribute updates work</AlertTitle>
        <AlertDescription>
          Whenever a bowler joins, leaves, or moves leagues (or when a league
          is renamed, archived, or has its season dates changed), we update
          their Square customer record automatically. If a sync
          fails, it's retried in the background.
        </AlertDescription>
      </Alert>
    </>
  );
}

export default function MessagingPage() {
  const { data: userResp, isLoading } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
  });
  const orgId = userResp?.data?.organizationId;

  return (
    <Layout>
      <ErrorBoundary level="section">
        {isLoading || !orgId ? (
          <div className="space-y-6">
            <div className="h-8 w-32 bg-muted animate-pulse rounded" />
            <div className="grid gap-6 md:grid-cols-2">
              {[1, 2].map((i) => (
                <Card key={i}>
                  <CardHeader>
                    <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                  </CardHeader>
                  <CardContent>
                    <div className="h-20 bg-muted animate-pulse rounded" />
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ) : (
          <MessagingContent />
        )}
      </ErrorBoundary>
    </Layout>
  );
}
