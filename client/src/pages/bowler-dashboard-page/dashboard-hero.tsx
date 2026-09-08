import { FC } from "react";
import { CanonicalSeasonProgress } from "@/components/canonical-season-progress";
import { Calendar, ChevronDown } from "lucide-react";

interface DashboardHeroProps {
  bowlerName: string;
  isSystemAdmin: boolean;
  hasMultipleLeagues: boolean;
  leagueName: string;
  teamName: string;
  leagueId: number;
  organizationId: number | null;
  viewerRole: string;
  onOpenLeagueSheet: () => void;
}

export const DashboardHero: FC<DashboardHeroProps> = ({
  bowlerName,
  isSystemAdmin,
  hasMultipleLeagues,
  leagueName,
  teamName,
  leagueId,
  organizationId,
  viewerRole,
  onOpenLeagueSheet,
}) => {
  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
      <h2 className="text-2xl font-bold text-slate-900 mb-1">Hi, {bowlerName}</h2>
      {isSystemAdmin && (
        <p className="text-sm text-slate-400 mb-1">Viewing as System Administrator</p>
      )}
      {hasMultipleLeagues ? (
        <button type="button"
          onClick={onOpenLeagueSheet}
          className="flex items-center gap-1 text-slate-500 hover:text-slate-700 transition-colors"
        >
          <span>{leagueName}</span>
          <ChevronDown className="size-4" />
        </button>
      ) : (
        <p className="text-slate-500">{leagueName}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <div className="inline-flex items-center px-3 py-1.5 rounded-full bg-indigo-50 text-indigo-700 text-sm font-medium">
          <span className="size-2 rounded-full bg-indigo-500 mr-2"></span>
          {teamName}
        </div>
        <div className="inline-flex items-center px-3 py-1.5 rounded-full bg-slate-100 text-slate-700 text-sm font-medium">
          <Calendar className="size-4 mr-1.5" />
          <CanonicalSeasonProgress leagueId={leagueId} organizationId={organizationId} viewerRole={viewerRole} />
        </div>
      </div>
    </div>
  );
};
