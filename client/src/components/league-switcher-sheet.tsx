import { X, Check } from "lucide-react";
import type { League, BowlerLeague } from "@shared/schema";

interface Props {
  open: boolean;
  onClose: () => void;
  bowlerLeagues: BowlerLeague[];
  leagueMap: Map<number, League>;
  selectedLeagueId: number | null | undefined;
  onSelect: (leagueId: number) => void;
}

export function LeagueSwitcherSheet({
  open,
  onClose,
  bowlerLeagues,
  leagueMap,
  selectedLeagueId,
  onSelect,
}: Props) {
  if (!open) return null;
  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 bg-black/40 z-40 transition-opacity duration-300"
        onClick={onClose}
      />
      <div className="fixed bottom-0 left-0 right-0 z-50 animate-slide-up">
        <div className="bg-white rounded-t-2xl shadow-xl max-h-sheet-viewport overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-navigation-100">
            <h3 className="text-lg font-semibold text-navigation-900">Switch League</h3>
            <button type="button"
              onClick={onClose}
              aria-label="Close league switcher"
              className="size-8 rounded-full hover:bg-navigation-100 flex items-center justify-center text-navigation-400 transition-colors"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="overflow-y-auto">
            {bowlerLeagues.map((bl) => {
              const l = leagueMap.get(bl.leagueId);
              const isSelected = bl.leagueId === selectedLeagueId;
              return (
                <button type="button"
                  key={bl.leagueId}
                  onClick={() => {
                    onSelect(bl.leagueId);
                    onClose();
                  }}
                  className={`w-full text-left px-5 py-4 flex items-center justify-between transition-colors ${
                    isSelected ? "bg-brand-accent-50" : "hover:bg-navigation-50"
                  }`}
                >
                  <div className={`font-medium ${isSelected ? "text-brand-accent-700" : "text-navigation-900"}`}>
                    {l?.name ?? `League #${bl.leagueId}`}
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
}
