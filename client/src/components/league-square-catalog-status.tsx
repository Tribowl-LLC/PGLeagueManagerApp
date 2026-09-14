import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

type CatalogLoadState = 'loading' | 'empty' | 'hasItems';

interface LeagueSquareCatalogStatusProps {
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  loadState: CatalogLoadState;
  isCatalogTruncated: boolean;
}

export function LeagueSquareCatalogStatus({
  hasActiveFilters,
  onClearFilters,
  loadState,
  isCatalogTruncated,
}: LeagueSquareCatalogStatusProps) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Square Catalog Items</div>
        {hasActiveFilters && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onClearFilters}
            data-testid="button-clear-catalog-filters"
          >
            Clear filters
          </Button>
        )}
      </div>

      {loadState === 'loading' && (
        <p className="text-sm text-muted-foreground">Loading catalog items&hellip;</p>
      )}

      {loadState === 'empty' && (
        <p className="text-sm text-muted-foreground">No Square catalog items found for this location. Make sure Square credentials are configured in the integrations settings.</p>
      )}

      {/* Task #623: when the server's pagination safety cap fires
          (5,000 items / 20 pages — see `paginateCatalogObjects` in
          server/services/square-provider.ts) the visible list is a
          truncated prefix of the real catalog. Pre-#623 the admin
          had no signal at all — surface it here so they understand
          why some items are missing. */}
      {isCatalogTruncated && (
        <Alert variant="destructive" data-testid="alert-catalog-truncated">
          <AlertTriangle className="size-4" />
          <AlertTitle>This catalog is too large to fully load</AlertTitle>
          <AlertDescription>
            We stopped loading after a safety limit (5,000 items) was reached, so some
            Square items aren't shown below. If you expected to see more, please contact
            support.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
