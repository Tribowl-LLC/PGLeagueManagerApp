import type { FC } from "react";
import { BowlerLayout } from "@/components/bowler-layout";
import { Skeleton } from "@/components/ui/skeleton";

interface BowlerScreenSkeletonProps {
  screen: "dashboard" | "pay" | "history";
  /** Announced to assistive technology while the screen loads. */
  message?: string;
  bowlerName?: string | null;
  leagueName?: string | null;
  /** Keeps the navigation links on the league this screen is loading. */
  leagueId?: number;
}

const SCREEN_TITLES = {
  dashboard: null,
  pay: "Make a payment",
  history: "Payment history",
} as const;

function SkeletonTile() {
  return (
    <div className="rounded-lg border bg-card p-4">
      <Skeleton className="mb-3 h-3 w-20" />
      <Skeleton className="mb-2 h-7 w-24" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * The bowler navigation and page outline, shown at once while a bowler
 * screen's data loads, in place of a blank page with a spinner. Whatever is
 * already known (the bowler and league names) is shown for real.
 */
export const BowlerScreenSkeleton: FC<BowlerScreenSkeletonProps> = ({ screen, message = "Loading…", bowlerName, leagueName, leagueId }) => {
  const title = SCREEN_TITLES[screen];
  return (
    // A non-breaking space keeps the league bar from inviting a league choice
    // before the bowler's leagues are known.
    <BowlerLayout bowlerName={bowlerName ?? ""} leagueName={leagueName || " "} currentLeagueId={leagueId}>
      <div role="status" aria-busy="true" className="flex flex-col gap-6" data-testid="bowler-screen-skeleton">
        <span className="sr-only">{message}</span>
        {title
          ? <h1 className="text-2xl font-bold">{title}</h1>
          : <div className="flex flex-col gap-2"><Skeleton className="h-7 w-56" /><Skeleton className="h-4 w-40" /></div>}
        <div className="grid grid-cols-2 gap-3">
          <SkeletonTile />
          <SkeletonTile />
        </div>
        {screen === "pay" && <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>}
        <SkeletonRows count={screen === "history" ? 5 : 2} />
      </div>
    </BowlerLayout>
  );
};
