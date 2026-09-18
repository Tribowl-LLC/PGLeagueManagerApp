import { FC, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Loader2, Search } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { ApiResponse } from "@shared/schema";
import { cn } from "@/lib/utils";

interface BowlerSearchResult {
  id: number;
  name: string;
  organizationId: number;
  secondaryLabel: string | null;
}

export interface BowlerSearchPickerProps {
  onSelect: (bowler: BowlerSearchResult) => void;
  excludeIds?: number[];
  organizationId?: number | null;
  placeholder?: string;
  disabled?: boolean;
  /** data-testid prefix for the input + result rows */
  testIdPrefix?: string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * Task #702: shared bowler name-search input. Wraps a debounced
 * `GET /api/bowlers/search?q=&excludeIds=` and
 * renders an inline result list. Selecting a row calls `onSelect`
 * and clears the field.
 */
export const BowlerSearchPicker: FC<BowlerSearchPickerProps> = ({
  onSelect,
  excludeIds,
  organizationId,
  placeholder = "Search by name…",
  disabled,
  testIdPrefix = "bowler-search",
}) => {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const debounced = useDebounced(query.trim(), 250);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const excludeKey = useMemo(
    () => (excludeIds ? excludeIds.toSorted((a, b) => a - b).join(",") : ""),
    [excludeIds],
  );

  const { data, isFetching } = useQuery<ApiResponse<BowlerSearchResult[]>>({
    queryKey: ["/api/bowlers/search", debounced, organizationId ?? null, excludeKey],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("q", debounced);
      if (excludeKey) params.set("excludeIds", excludeKey);
      return apiRequest<BowlerSearchResult[]>(`/api/bowlers/search?${params.toString()}`, "GET");
    },
    enabled: debounced.length >= 2 && !disabled,
    staleTime: 10_000,
  });
  const results = data?.data ?? [];

  // Click-outside to dismiss
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const handlePick = (b: BowlerSearchResult) => {
    onSelect(b);
    setQuery("");
    setOpen(false);
    setHighlight(0);
  };

  // Reset highlight whenever the result set changes so we never index
  // past the end of the list.
  useEffect(() => {
    setHighlight(0);
  }, [debounced, results.length]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!showPanel || results.length === 0) {
      if (e.key === "Escape") setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      const pick = results[highlight];
      if (pick) {
        e.preventDefault();
        handlePick(pick);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  const showPanel = open && debounced.length >= 2;

  return (
    <div className="relative w-full" ref={containerRef}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          leading="sm"
          data-testid={`${testIdPrefix}-input`}
          autoComplete="off"
        />
      </div>
      {showPanel && (
        <div
          className={cn(
            "absolute z-20 mt-1 w-full rounded-md border bg-popover p-1 shadow-md",
          )}
          data-testid={`${testIdPrefix}-panel`}
        >
          {isFetching && results.length === 0 && (
            <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Searching…
            </div>
          )}
          {!isFetching && results.length === 0 && (
            <div
              className="p-2 text-sm text-muted-foreground"
              data-testid={`${testIdPrefix}-empty`}
            >
              No bowlers found
            </div>
          )}
          {results.map((b, i) => (
            <button
              type="button"
              key={b.id}
              onClick={() => handlePick(b)}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                i === highlight && "bg-accent",
              )}
              aria-pressed={i === highlight}
              data-testid={`${testIdPrefix}-result-${b.id}`}
            >
              <span className="font-medium">{b.name}</span>
              {b.secondaryLabel && (
                <span className="text-xs text-muted-foreground">{b.secondaryLabel}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
