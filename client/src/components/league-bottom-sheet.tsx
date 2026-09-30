import { FC, useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, ChevronDown, X } from "lucide-react";
import type { League, BowlerLeague } from "@shared/schema";
import { getSeasonYearRange } from "@shared/season-utils";

interface LeagueBottomSheetProps {
  open: boolean;
  onClose: () => void;
  activeBowlerLeagues: BowlerLeague[];
  leagueMap: Map<number, League>;
  selectedLeagueId: number | null;
  onSelectLeague: (leagueId: number) => void;
}

const DEFAULT_CLOSE_DURATION_MS = 150;

function getCloseDuration(dialog: HTMLElement | null): number {
  if (!dialog) return DEFAULT_CLOSE_DURATION_MS;
  const value = getComputedStyle(dialog).getPropertyValue("--league-picker-close-duration").trim();
  const parsedValue = Number.parseFloat(value);
  if (!Number.isFinite(parsedValue)) return DEFAULT_CLOSE_DURATION_MS;
  return value.endsWith("ms") ? parsedValue : parsedValue * 1000;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const LeagueBottomSheet: FC<LeagueBottomSheetProps> = ({
  open,
  onClose,
  activeBowlerLeagues,
  leagueMap,
  selectedLeagueId,
  onSelectLeague,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const onSelectLeagueRef = useRef(onSelectLeague);
  const [pendingSelectionId, setPendingSelectionId] = useState<number | null>(null);

  useEffect(() => {
    onSelectLeagueRef.current = onSelectLeague;
  }, [onSelectLeague]);

  useEffect(() => () => {
    if (selectionTimerRef.current !== null) {
      window.clearTimeout(selectionTimerRef.current);
    }
  }, []);

  const finishPendingSelection = () => {
    const leagueId = pendingSelectionRef.current;
    if (leagueId === null) return;

    if (selectionTimerRef.current !== null) {
      window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = null;
    }
    pendingSelectionRef.current = null;
    setPendingSelectionId(null);
    onSelectLeagueRef.current(leagueId);
  };

  const handleLeagueSelection = (leagueId: number) => {
    if (pendingSelectionRef.current !== null) return;

    if (prefersReducedMotion()) {
      onSelectLeague(leagueId);
      onClose();
      return;
    }

    pendingSelectionRef.current = leagueId;
    setPendingSelectionId(leagueId);
    const closeDuration = getCloseDuration(dialogRef.current);
    onClose();
    selectionTimerRef.current = window.setTimeout(finishPendingSelection, closeDuration);
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="familiar-league-picker-scope familiar-league-switcher-backdrop" />
        <DialogPrimitive.Content
          ref={dialogRef}
          aria-modal="true"
          inert={!open}
          className="familiar-league-picker-scope familiar-bowler-league-panel"
          onOpenAutoFocus={(event) => {
            previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
            event.preventDefault();
            closeButtonRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const previouslyFocusedElement = previouslyFocusedElementRef.current;
            if (previouslyFocusedElement?.isConnected) {
              previouslyFocusedElement.focus({ preventScroll: true });
            }
            previouslyFocusedElementRef.current = null;
          }}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === "familiar-league-picker-close") {
              finishPendingSelection();
            }
          }}
        >
          <div className="familiar-league-switcher-header">
            <DialogPrimitive.Title className="familiar-league-switcher-title">
              Choose your league
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              ref={closeButtonRef}
              type="button"
              aria-label="Close league switcher"
              className="familiar-league-switcher-close"
            >
              <X aria-hidden="true" size={20} />
            </DialogPrimitive.Close>
          </div>

          <DialogPrimitive.Description className="familiar-league-switcher-description">
            Balances and history follow the selected league.
          </DialogPrimitive.Description>

          <div className="familiar-league-switcher-options" role="group" aria-label="Available leagues">
            {activeBowlerLeagues.map((bowlerLeague) => {
              const league = leagueMap.get(bowlerLeague.leagueId);
              const isSelected = bowlerLeague.leagueId === selectedLeagueId;
              const leagueTitle = league?.seasonStart && league.seasonEnd
                ? `${league.name} ${getSeasonYearRange(league.seasonStart, league.seasonEnd)}`
                : league?.name ?? `League #${bowlerLeague.leagueId}`;

              return (
                <button
                  type="button"
                  key={bowlerLeague.leagueId}
                  aria-pressed={isSelected}
                  disabled={pendingSelectionId !== null}
                  onClick={() => handleLeagueSelection(bowlerLeague.leagueId)}
                  className={`familiar-league-switcher-option${isSelected ? " is-selected" : ""}`}
                >
                  <span className="familiar-league-switcher-name">{leagueTitle}</span>
                  <span className="familiar-league-switcher-check" aria-hidden="true">
                    {isSelected
                      ? <Check className="size-5" />
                      : <ChevronDown size={18} />}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};
