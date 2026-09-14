import { FormControl, FormItem, FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, X } from "lucide-react";

interface CatalogCategory {
  id: string;
  name: string;
}

interface LeagueSquareCatalogFilterFieldsProps {
  searchInput: string;
  onSearchChange: (value: string) => void;
  hasCatalogItems: boolean;
  isSearching: boolean;
  visibleItemCount: number;
  totalItemCount: number;
  categories: CatalogCategory[];
  selectedCategoryId: string | null;
  onCategorySelect: (value: string) => void;
}

export function LeagueSquareCatalogFilterFields({
  searchInput,
  onSearchChange,
  hasCatalogItems,
  isSearching,
  visibleItemCount,
  totalItemCount,
  categories,
  selectedCategoryId,
  onCategorySelect,
}: LeagueSquareCatalogFilterFieldsProps) {
  return (
    <>
      <FormItem>
        <FormLabel>Search Items</FormLabel>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Search by item name…"
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
            disabled={!hasCatalogItems}
            leading="sm"
            trailing="sm"
            data-testid="input-catalog-search"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
              data-testid="button-clear-catalog-search"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {isSearching && (
          <p className="text-xs text-muted-foreground" data-testid="text-catalog-search-count">
            {visibleItemCount === 0
              ? 'No items match your search'
              : `${visibleItemCount} of ${totalItemCount} item${totalItemCount === 1 ? '' : 's'} match`}
          </p>
        )}
      </FormItem>

      <FormItem>
        <FormLabel>Filter by Category</FormLabel>
        <Select
          value={
            !hasCatalogItems
              ? undefined
              : (selectedCategoryId || 'all')
          }
          onValueChange={onCategorySelect}
          disabled={!hasCatalogItems}
        >
          <FormControl>
            <SelectTrigger>
              <SelectValue placeholder={!hasCatalogItems ? "No Square items configured for this location" : "All Categories"} />
            </SelectTrigger>
          </FormControl>
          <SelectContent>
            {!hasCatalogItems && (
              <SelectItem value="__no-items" disabled>No Square items configured for this location</SelectItem>
            )}
            {hasCatalogItems && (
              <>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                ))}
              </>
            )}
          </SelectContent>
        </Select>
      </FormItem>
    </>
  );
}
