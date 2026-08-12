import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout.js";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { ArrowLeft } from "lucide-react";
import { PageLoadingState, PageErrorState } from "@/components/page-states";
import type { Score, Bowler } from "@shared/schema";
import type { BowlerScoreHistoryReadContract } from "@shared/canonical-games-scores";
import { groupBowlerScoreHistory } from "@/lib/bowler-score-history";
import { bowlerScoreHistoryRequest } from "@/lib/score-requests";
import { format } from "date-fns";
import { Link, useParams, useSearch } from "wouter";

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: {
    message: string;
    code?: string;
  };
}

export default function BowlerScoresPage() {
  const { bowlerId } = useParams<{ bowlerId: string }>();
  const parsedBowlerId = bowlerId ? parseInt(bowlerId) : undefined;
  const search = useSearch();
  const backHref = search ? `/bowlers/${bowlerId}?${search}` : `/bowlers/${bowlerId}`;

  const { data: bowlerResponse, isLoading: loadingBowler } = useQuery<ApiResponse<Bowler>>({
    queryKey: [`/api/bowlers/${bowlerId}`],
    enabled: !!bowlerId,
  });
  const bowler = bowlerResponse?.data;
  const historyRequest = parsedBowlerId && bowler?.organizationId
    ? bowlerScoreHistoryRequest(parsedBowlerId, bowler.organizationId)
    : null;

  // Use historical scores endpoint for complete history
  const { data: scoresResponse, isLoading: loadingScores, error: scoresError, refetch: refetchScores } = useQuery<ApiResponse<BowlerScoreHistoryReadContract>>({
    queryKey: historyRequest?.queryKey ?? ["/api/scores/history", parsedBowlerId, null],
    queryFn: async ({ queryKey }) => {
      const scopedUrl = queryKey[3];
      if (typeof scopedUrl !== "string") throw new Error("Tenant-scoped bowler ID is required");
      const response = await fetch(scopedUrl);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to fetch scores');
      }
      return response.json();
    },
    enabled: historyRequest !== null,
  });

  const scores = scoresResponse?.data.scores || [];
  const isLoading = loadingBowler || loadingScores;

  // Group scores by week and calculate series totals
  const weeklyScores = groupBowlerScoreHistory(scores);

  if (isLoading) {
    return (
      <Layout>
        <PageLoadingState />
      </Layout>
    );
  }

  if (!bowler) {
    return (
      <Layout>
        <div className="text-center text-destructive">Bowler not found</div>
      </Layout>
    );
  }

  // Calculate current average from all historical games
  const validScores = scores.filter(s => !s.isAbsent && !s.isVacant && s.score !== null);

  const totalPinfall = validScores.reduce((sum, score) => {
    return sum + (score.score || 0);
  }, 0);

  const gamesPlayed = validScores.length;

  const currentAverage = gamesPlayed > 0 ? Math.round(totalPinfall / gamesPlayed) : 0;

  return (
    <Layout>
      <ErrorBoundary level="section">
      <div className="space-y-6">
        <Link
          href={backHref}
          className="text-muted-foreground hover:text-foreground flex items-center"
        >
          <ArrowLeft className="size-4 mr-2" />
          Back to Bowler
        </Link>

        <div>
          <h1 className="text-2xl font-bold mb-2">{bowler.name}'s Recent Scores</h1>
          <p className="text-muted-foreground">
            View recent scores and statistics
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Current Average</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{currentAverage}</p>
              <p className="text-sm text-muted-foreground">
                Based on {gamesPlayed} games
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="pt-6">
            {scoresError ? (
              <PageErrorState message={`Error loading scores: ${scoresError.message}`} onRetry={() => refetchScores()} />
            ) : weeklyScores.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Week</TableHead>
                    <TableHead className="text-right">Game 1</TableHead>
                    <TableHead className="text-right">Game 2</TableHead>
                    <TableHead className="text-right">Game 3</TableHead>
                    <TableHead className="text-right">Series</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {weeklyScores.map((week) => (
                    <TableRow key={week.identityKey}>
                      <TableCell>{format(new Date(`${week.date}T12:00:00.000Z`), "MMM d, yyyy")}</TableCell>
                      <TableCell>{week.weekNumber}</TableCell>
                      {[1, 2, 3].map((gameNumber) => {
                        const game = week.games[gameNumber - 1];
                        return (
                        <TableCell key={`${week.identityKey}-g${gameNumber}`} className="text-right">
                          {game?.isVacant ? "VACANT" :
                           game?.isAbsent ? "ABSENT" :
                           game?.score || "—"}
                        </TableCell>
                        );
                      })}
                      <TableCell className="text-right font-medium">
                        {week.seriesTotal || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center text-muted-foreground py-8">
                No scores recorded yet
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      </ErrorBoundary>
    </Layout>
  );
}
