import { FC, useEffect, useId, useRef } from "react";
import { CanonicalSeasonProgress } from "./canonical-season-progress";
import { X, Check } from "lucide-react";
import type { League, BowlerLeague, Team } from "@shared/schema";
import { getSeasonYearRange } from "@shared/season-utils";

interface LeagueBottomSheetProps {
  open: boolean;
  onClose: () => void;
  activeBowlerLeagues: BowlerLeague[];
  leagueMap: Map<number, League>;
  teamMap: Map<number, Team>;
  selectedLeagueId: number | null;
  onSelectLeague: (leagueId: number) => void;
  viewerRole?: string;
}

export const LeagueBottomSheet: FC<LeagueBottomSheetProps> = ({
  open,
  onClose,
  activeBowlerLeagues,
  leagueMap,
  teamMap,
  selectedLeagueId,
  onSelectLeague,
  viewerRole,
}) => {
  const dialogTitleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusableElements = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      if (focusableElements.length === 0) {
        event.preventDefault();
        closeButtonRef.current?.focus();
        return;
      }

      const firstFocusableElement = focusableElements[0];
      const lastFocusableElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === firstFocusableElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        lastFocusableElement.focus();
      } else if (!event.shiftKey && (activeElement === lastFocusableElement || !dialog.contains(activeElement))) {
        event.preventDefault();
        firstFocusableElement.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close league switcher"
        className="fixed inset-0 bg-black/40 z-40 transition-opacity duration-300"
        onClick={onClose}
      />
      <div className="fixed bottom-0 left-0 right-0 z-50 animate-slide-up familiar-bowler-league-sheet">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={dialogTitleId}
          className="bg-white rounded-t-2xl shadow-xl max-h-sheet-viewport overflow-hidden familiar-bowler-league-panel"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-navigation-100">
            <h3 id={dialogTitleId} className="text-lg font-semibold text-navigation-900">Switch League</h3>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close league switcher"
              className="size-8 rounded-full hover:bg-navigation-100 flex items-center justify-center text-navigation-400 transition-colors"
            >
              <X className="size-5" />
            </button>
          </div>

          <div className="overflow-y-auto">
            {activeBowlerLeagues.map((bl) => {
              const league = leagueMap.get(bl.leagueId);
              const team = bl.teamId ? teamMap.get(bl.teamId) : undefined;
              const isSelected = bl.leagueId === selectedLeagueId;
              const leagueTitle = league?.seasonStart && league.seasonEnd
                ? `${league.name} ${getSeasonYearRange(league.seasonStart, league.seasonEnd)}`
                : league?.name ?? `League #${bl.leagueId}`;

              return (
                <button type="button"
                  key={bl.leagueId}
                  onClick={() => {
                    onSelectLeague(bl.leagueId);
                    onClose();
                  }}
                  className={`w-full text-left px-5 py-4 flex items-center justify-between transition-colors ${
                    isSelected ? 'bg-brand-accent-50' : 'hover:bg-navigation-50'
                  }`}
                >
                  <div>
                    <div className={`font-medium ${isSelected ? 'text-brand-accent-700' : 'text-navigation-900'}`}>
                      {leagueTitle}
                    </div>
                    <div className="text-sm text-navigation-500 mt-0.5">
                      {team?.name ?? 'No Team'}
                      {league && viewerRole && (
                        <> &bull; <CanonicalSeasonProgress leagueId={league.id} organizationId={league.organizationId} viewerRole={viewerRole} allowRetry={false} /></>
                      )}
                    </div>
                  </div>
                  {isSelected && (
                    <div className="size-6 rounded-full bg-brand-accent-600 flex items-center justify-center flex-shrink-0 ml-3">
                      <Check className="size-4 text-white" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="h-8" />
        </div>
      </div>

    </>
  );
};
