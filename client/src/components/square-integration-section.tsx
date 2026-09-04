import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronUp, Eye, EyeOff, Pencil } from "lucide-react";
import { SiSquare } from "react-icons/si";
import type { ApiResponse, Location } from "@shared/schema";
import { getMissingSquareFields, SQUARE_FIELD_LABELS } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { clearProviderConfigCache } from "@/hooks/use-payment-provider";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { refreshSquarePaymentConfiguration } from "@/lib/square";

interface SquareLocationConfig {
  appId: string | null;
  accessTokenConfigured: boolean;
  locationId: string | null;
}

function SquareConfigForm({ location }: { location: Location }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [appId, setAppId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [squareLocationId, setSquareLocationId] = useState("");
  const [showToken, setShowToken] = useState(false);

  const { data: configResponse, isLoading } = useQuery<ApiResponse<SquareLocationConfig>>({
    queryKey: ["/api/locations", location.id, "square-config"],
    queryFn: async () => {
      const res = await fetch(`/api/locations/${location.id}/square-config`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      return res.json();
    },
    staleTime: 1000 * 60 * 5,
  });

  const config = configResponse?.data;
  const missingFields = getMissingSquareFields(config ?? null);
  const isConfigured = missingFields.length === 0;
  const isPartial = !isConfigured && missingFields.length < 3;

  const mutation = useMutation({
    mutationFn: async (data: { appId?: string; accessToken?: string; locationId?: string }) =>
      apiRequest(`/api/locations/${location.id}/square-config`, "PATCH", data),
    onSuccess: (_response, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/locations", location.id, "square-config"] });
      clearProviderConfigCache();
      const nextAppId = variables.appId ?? config?.appId ?? null;
      const { reloadRequired } = refreshSquarePaymentConfiguration(
        location.id,
        config?.appId ?? null,
        nextAppId,
      );
      toast({ title: "Square settings saved", description: `Square credentials for ${location.name} have been updated.` });
      if (reloadRequired) {
        window.location.reload();
        return;
      }
      setAccessToken("");
      setExpanded(false);
    },
    onError: (error: Error) => {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  function handleOpen() {
    if (config) {
      setAppId(config.appId || "");
      setSquareLocationId(config.locationId || "");
    }
    setAccessToken("");
    setExpanded(true);
  }

  function handleSave() {
    mutation.mutate({
      appId: appId || undefined,
      accessToken: accessToken || undefined,
      locationId: squareLocationId || undefined,
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {isLoading ? (
          <div className="h-5 w-24 bg-muted animate-pulse rounded-full" />
        ) : isConfigured ? (
          <Badge className="bg-green-100 text-green-700 border-green-200">
            <CheckCircle2 className="size-3 mr-1" />
            Configured
          </Badge>
        ) : isPartial ? (
          <Badge className="bg-amber-100 text-amber-800 border-amber-200" data-testid="badge-square-partial">
            <AlertTriangle className="size-3 mr-1" />
            Partial setup
          </Badge>
        ) : (
          <Badge variant="outline">Not configured</Badge>
        )}

        {!expanded ? (
          <Button variant="outline" size="sm" onClick={handleOpen}>
            {(isConfigured || isPartial) && <Pencil className="size-3.5 mr-1.5" />}
            {isPartial ? "Finish setup" : isConfigured ? "Edit" : "Configure"}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)} aria-label="Collapse Square settings">
            <ChevronUp className="size-4" />
          </Button>
        )}
      </div>

      {!isLoading && isPartial && !expanded && (
        <p className="text-xs text-amber-700" data-testid="text-square-missing-fields">
          Missing: {missingFields.map((field) => SQUARE_FIELD_LABELS[field]).join(', ')}.
          Card payments will be unavailable until every field is filled in.
        </p>
      )}

      {expanded && (
        <div className="space-y-4 pt-2">
          <p className="text-sm text-muted-foreground">
            Enter the Square credentials for <strong>{location.name}</strong>.
          </p>

          {isPartial && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" data-testid="alert-square-missing-fields-form">
              <div className="flex items-start gap-2">
                <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">Square is partially configured</div>
                  <div className="text-xs mt-1">
                    Still needed: {missingFields.map((field) => SQUARE_FIELD_LABELS[field]).join(', ')}.
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor={`sq-app-id-${location.id}`}>Application ID</Label>
            <Input
              id={`sq-app-id-${location.id}`}
              placeholder={config?.appId || "sq0idp-..."}
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Found in your Square Developer Dashboard under your application.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`sq-token-${location.id}`}>Access Token</Label>
            <div className="relative">
              <Input
                id={`sq-token-${location.id}`}
                type={showToken ? "text" : "password"}
                placeholder={config?.accessTokenConfigured ? "Configured — enter a new token to replace" : "EAAAEv..."}
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowToken((visible) => !visible)}
                aria-label={showToken ? "Hide Square access token" : "Show Square access token"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">Production access token from your Square Developer Dashboard.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`sq-loc-${location.id}`}>Square Location ID</Label>
            <Input
              id={`sq-loc-${location.id}`}
              placeholder={config?.locationId || "L..."}
              value={squareLocationId}
              onChange={(event) => setSquareLocationId(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Found in your Square Dashboard under Account &amp; Settings → Locations.</p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setExpanded(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={mutation.isPending}>
              {mutation.isPending ? "Saving..." : "Save Credentials"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PaymentLocationCard({ location, highlighted }: { location: Location; highlighted: boolean }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [showRing, setShowRing] = useState(false);

  useEffect(() => {
    if (!highlighted) return;
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setShowRing(true);
    const timeout = setTimeout(() => setShowRing(false), 2500);
    return () => clearTimeout(timeout);
  }, [highlighted]);

  return (
    <Card
      ref={cardRef}
      data-testid={`payment-location-card-${location.id}`}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn('transition-shadow', showRing && 'ring-2 ring-primary ring-offset-2')}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-lg flex items-center justify-center shrink-0 bg-black">
            <SiSquare className="size-5 text-white" />
          </div>
          <CardTitle className="text-base">{location.name}</CardTitle>
        </div>
      </CardHeader>
      <Separator />
      <CardContent className="pt-4"><SquareConfigForm location={location} /></CardContent>
    </Card>
  );
}

interface SquareSectionProps {
  orgId: number;
  highlightLocationId?: number | null;
}

export function SquareSection({ orgId, highlightLocationId = null }: SquareSectionProps) {
  const { data: locationsResponse, isLoading } = useQuery<ApiResponse<Location[]>>({
    queryKey: ["/api/locations", { organizationId: orgId }],
    queryFn: async () => {
      const res = await fetch(`/api/locations?organizationId=${orgId}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch locations: ${res.status}`);
      return res.json();
    },
    staleTime: 1000 * 60 * 5,
  });

  const locations = (locationsResponse?.data ?? []).filter((location) => location.active);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 mb-1">
        <div className="size-10 rounded-lg bg-gradient-to-br from-black to-blue-600 flex items-center justify-center shrink-0">
          <SiSquare className="size-5 text-white" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">Payment Processing</h3>
          <p className="text-xs text-muted-foreground">Square, configured per location</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((item) => <Card key={item}><CardHeader className="h-20 animate-pulse" /></Card>)}
        </div>
      ) : locations.length === 0 ? (
        <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">No active locations found for this organization. Add a location first to configure payment processing.</p></CardContent></Card>
      ) : (
        <div className="space-y-3">
          {locations.map((location) => (
            <PaymentLocationCard key={location.id} location={location} highlighted={highlightLocationId === location.id} />
          ))}
        </div>
      )}
    </div>
  );
}
