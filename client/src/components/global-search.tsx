import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { useLocation } from "wouter";
import { Search, Trophy, Users, UserCircle, Loader2 } from "lucide-react";

interface SearchResults {
  leagues: { id: number; name: string; active: boolean }[];
  teams: { id: number; name: string; number: number; leagueId: number; leagueName: string | null }[];
  bowlers: { id: number; name: string; email: string | null }[];
}

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const [, setLocation] = useLocation();

  const fetchResults = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults(null);
      setIsOpen(false);
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const thisRequestId = ++requestIdRef.current;

    setIsLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      });
      const json = await res.json();
      // Last-write-wins: only apply this response if it's still the latest
      // in-flight request (a newer request would have bumped the id).
      if (thisRequestId === requestIdRef.current) {
        if (json.success) {
          setResults(json.data);
          setIsOpen(true);
        } else {
          setResults(null);
          setIsOpen(false);
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setResults(null);
      setIsOpen(false);
    } finally {
      if (thisRequestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchResults(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, fetchResults]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setIsOpen(false);
      (e.target as HTMLInputElement).blur();
    }
  }

  function navigate(path: string) {
    setIsOpen(false);
    setQuery("");
    setResults(null);
    setLocation(path);
  }

  const hasResults = results && (results.leagues.length > 0 || results.teams.length > 0 || results.bowlers.length > 0);

  return (
    <div ref={containerRef} className="relative group hidden md:block">
      <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
      {isLoading && (
        <Loader2 className="size-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 animate-spin" />
      )}
      <input
        type="text"
        aria-label="Search leagues, teams, or bowlers"
        placeholder="Search leagues, teams, or bowlers..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => { if (results && query.length >= 2) setIsOpen(true); }}
        onKeyDown={handleKeyDown}
        className="pl-9 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:bg-white transition-all w-64"
      />

      {isOpen && query.length >= 2 && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-white rounded-lg shadow-lg border border-slate-200 z-50 overflow-hidden max-h-[400px] overflow-y-auto">
          {!hasResults && !isLoading && (
            <div className="p-4 text-center text-sm text-slate-500">
              No results found for "{query}"
            </div>
          )}

          {results && results.leagues.length > 0 && (
            <div>
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Leagues</span>
              </div>
              {results.leagues.map((league) => (
                <button type="button"
                  key={`league-${league.id}`}
                  onClick={() => navigate(`/leagues/${league.id}`)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 transition-colors text-left"
                >
                  <Trophy className="size-4 text-indigo-500 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{league.name}</div>
                    {!league.active && (
                      <span className="text-xs text-slate-400">Inactive</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {results && results.teams.length > 0 && (
            <div>
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Teams</span>
              </div>
              {results.teams.map((team) => (
                <button type="button"
                  key={`team-${team.id}`}
                  onClick={() => navigate(`/teams/${team.id}`)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 transition-colors text-left"
                >
                  <Users className="size-4 text-emerald-500 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{team.name}</div>
                    <div className="text-xs text-slate-400 truncate">
                      Team #{team.number} · {team.leagueName}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {results && results.bowlers.length > 0 && (
            <div>
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Bowlers</span>
              </div>
              {results.bowlers.map((bowler) => (
                <button type="button"
                  key={`bowler-${bowler.id}`}
                  onClick={() => navigate(`/bowlers/${bowler.id}`)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 transition-colors text-left"
                >
                  <UserCircle className="size-4 text-amber-500 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{bowler.name}</div>
                    {bowler.email && (
                      <div className="text-xs text-slate-400 truncate">{bowler.email}</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
