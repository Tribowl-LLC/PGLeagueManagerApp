/* eslint-disable shadcn/no-unknown-classes */
import { FC } from "react";
import { CanonicalSeasonProgress } from "@/components/canonical-season-progress";

interface DashboardHeroProps {
  bowlerName: string;
  isSystemAdmin: boolean;
  teamName: string;
  leagueId: number;
  organizationId: number | null;
  viewerRole: string;
}

export const DashboardHero: FC<DashboardHeroProps> = ({
  bowlerName,
  isSystemAdmin,
  teamName,
  leagueId,
  organizationId,
  viewerRole,
}) => {
  const firstName = bowlerName.trim().split(/\s+/)[0] || bowlerName;

  return (
    <header className="familiar-bowler-page-heading">
      <h1>Hi, {firstName}.</h1>
      {isSystemAdmin && (
        <p className="familiar-owner-note">Viewing as Owner</p>
      )}
      <p>
        <span>{teamName}</span>
        <span aria-hidden="true">·</span>
        <span><CanonicalSeasonProgress leagueId={leagueId} organizationId={organizationId} viewerRole={viewerRole} /></span>
      </p>
    </header>
  );
};
