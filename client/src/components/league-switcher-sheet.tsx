import { useEffect, useId, useRef } from "react";
import { X, Check } from "lucide-react";
import type { League, BowlerLeague, Team } from "@shared/schema";
import { formatLeagueCompetitionTime } from "@/lib/league-display";

interface Props {
  open: boolean;
  onClose: () => void;
  bowlerLeagues: BowlerLeague[];
  leagueMap: Map<number, League>;
  teamMap?: Map<number, Team>;
  selectedLeagueId: number | null | undefined;
  onSelect: (leagueId: number) => void;
}

export function LeagueSwitcherSheet({
  open,
  onClose,
  bowlerLeagues,
  leagueMap,
  teamMap,
  selectedLeagueId,
  onSelect,
}: Props) {
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
        className="fixed inset-0 bg-black/40 z-40 transition-opacity duration-300 familiar-league-switcher-backdrop"
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
          <div className="flex items-center justify-between px-5 py-4 border-b border-navigation-100 familiar-league-switcher-header">
            <h3 id={dialogTitleId} className="text-lg font-semibold text-navigation-900"><span className="familiar-league-switcher-title-mobile">Switch League</span><span className="familiar-league-switcher-title-desktop">Choose your league</span></h3>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close league switcher"
              className="size-8 rounded-full hover:bg-navigation-100 flex items-center justify-center text-navigation-400 transition-colors familiar-league-switcher-close"
            >
              <X className="size-5" />
            </button>
          </div>
          <p className="familiar-league-switcher-description">Balances and history follow the selected league.</p>
          <div className="overflow-y-auto familiar-league-switcher-options">
            {bowlerLeagues.map((bl) => {
              const l = leagueMap.get(bl.leagueId);
              const team = bl.teamId ? teamMap?.get(bl.teamId) : undefined;
              const desktopMeta = [team?.name, formatLeagueCompetitionTime(l?.competitionStartTime)].filter(Boolean).join(" · ");
              const isSelected = bl.leagueId === selectedLeagueId;
              return (
                <button type="button"
                  key={bl.leagueId}
                  onClick={() => {
                    onSelect(bl.leagueId);
                    onClose();
                  }}
                  className={`w-full text-left px-5 py-4 flex items-center justify-between transition-colors familiar-league-switcher-option ${isSelected ? 'is-selected' : ''}`}
                >
                  <div>
                    <div className={`font-medium familiar-league-switcher-name ${isSelected ? "text-brand-accent-700" : "text-navigation-900"}`}>
                      {l?.name ?? `League #${bl.leagueId}`}
                    </div>
                    {desktopMeta && <div className="familiar-league-switcher-meta-desktop">{desktopMeta}</div>}
                  </div>
                  {isSelected && (
                    <div className="size-6 rounded-full flex items-center justify-center flex-shrink-0 ml-3 familiar-league-switcher-check">
                      <Check className="size-4 text-white" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          <div className="h-8 familiar-league-switcher-bottom-space" />
        </div>
      </div>
    </>
  );
}
