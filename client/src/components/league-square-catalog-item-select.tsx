import { FormControl, FormItem, FormLabel } from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle } from "lucide-react";

interface CatalogItemVariation {
  id: string;
  name: string;
  price: number | null;
  currency: string;
}

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  variations: CatalogItemVariation[];
}

interface LeagueSquareCatalogItemSelectProps {
  label: string;
  missingFromCatalog: boolean;
  missingTestId: string;
  fallbackTestId: string;
  currentVariationId: string | null | undefined;
  hasCatalogItems: boolean;
  visibleCatalogItems: CatalogItem[];
  originalVariationId: string | null;
  originalName: string | null;
  onValueChange: (value: string) => void;
}

export function LeagueSquareCatalogItemSelect({
  label,
  missingFromCatalog,
  missingTestId,
  fallbackTestId,
  currentVariationId,
  hasCatalogItems,
  visibleCatalogItems,
  originalVariationId,
  originalName,
  onValueChange,
}: LeagueSquareCatalogItemSelectProps) {
  return (
    <FormItem>
      <FormLabel>
        <span className="flex items-center gap-2">
          <span>{label}</span>
          {missingFromCatalog && (
            <output
              className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive"
              title="This item is no longer in your Square catalog. Re-pick a live item before bowlers check out."
              data-testid={missingTestId}
            >
              <AlertTriangle className="size-3" aria-hidden="true" />
              Not in Square catalog
            </output>
          )}
        </span>
      </FormLabel>
      <Select
        value={
          !hasCatalogItems
            ? undefined
            : (currentVariationId || 'none')
        }
        onValueChange={onValueChange}
        disabled={!hasCatalogItems}
      >
        <FormControl>
          <SelectTrigger>
            <SelectValue placeholder={!hasCatalogItems ? "No Square items configured for this location" : "None"} />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          {!hasCatalogItems && (
            <SelectItem value="__no-items" disabled>No Square items configured for this location</SelectItem>
          )}
          {hasCatalogItems && (
            <>
              <SelectItem value="none">None</SelectItem>
              {(() => {
                const savedId = originalVariationId;
                const savedName = originalName;
                const isInList = savedId && visibleCatalogItems.some(item => item.variations.some(v => v.id === savedId));
                if (savedId && savedName && !isInList) {
                  return <SelectItem key={savedId} value={savedId} data-testid={fallbackTestId}>{savedName}</SelectItem>;
                }
                return null;
              })()}
              {visibleCatalogItems.map((item) =>
                item.variations.map((variation) => (
                  <SelectItem key={variation.id} value={variation.id}>
                    {item.name}{variation.name !== 'Regular' && variation.name !== 'Default' ? ` - ${variation.name}` : ''}
                    {variation.price !== null ? ` ($${(variation.price / 100).toFixed(2)})` : ''}
                  </SelectItem>
                ))
              )}
            </>
          )}
        </SelectContent>
      </Select>
    </FormItem>
  );
}
