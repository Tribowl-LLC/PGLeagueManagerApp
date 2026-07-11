/** Coverage for the public, no-auth adult registration endpoints. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, and } from 'drizzle-orm';
import { db } from '../../server/db';
import { leagues, teams, bowlers, bowlerLeagues, leagueRegistrations } from '@shared/schema';
import { BASE_URL, getBaselineOrgAId } from '../helpers';

interface EmbedResp {
  success: boolean;
  data?: { bowlerIds: number[]; registrationIds: number[] };
  error?: { message: string; code?: string };
}

async function publicGet(leagueId: number) {
  const response = await fetch(`${BASE_URL}/api/public/embed/leagues/${leagueId}`, {
    headers: { 'x-test-rate-limit-bypass': '1' },
  });
  return {
    status: response.status,
    body: (await response.json()) as { success: boolean; data?: unknown; error?: { code?: string } },
  };
}

async function publicSubmit(body: unknown) {
  const response = await fetch(`${BASE_URL}/api/public/embed/registrations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-rate-limit-bypass': '1',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as EmbedResp };
}

describe('public embed registration endpoints', () => {
  let orgAId: number;
  let openLeagueId: number;
  let cappedLeagueId: number;
  let nonPublicLeagueId: number;
  const stamp = Date.now();

  beforeAll(async () => {
    orgAId = await getBaselineOrgAId();
    const baseFields = {
      organizationId: orgAId,
      seasonStart: '2099-01-01',
      seasonEnd: '2099-12-31',
      weekDay: 'Saturday' as const,
      weeklyFee: 0,
      paymentMode: 'weekly' as const,
      active: true,
      seasonNumber: 1,
    };

    const [openLeague] = await db.insert(leagues).values({
      ...baseFields,
      name: `Vitest Adult Embed Open ${stamp}`,
      allowPublicSignup: true,
    }).returning();
    openLeagueId = openLeague.id;

    const [cappedLeague] = await db.insert(leagues).values({
      ...baseFields,
      name: `Vitest Adult Embed Capped ${stamp}`,
      allowPublicSignup: true,
      rosterCap: 1,
    }).returning();
    cappedLeagueId = cappedLeague.id;

    const [closedLeague] = await db.insert(leagues).values({
      ...baseFields,
      name: `Vitest Adult Embed Closed ${stamp}`,
      allowPublicSignup: false,
    }).returning();
    nonPublicLeagueId = closedLeague.id;
  });

  afterAll(async () => {
    const leagueIds = [openLeagueId, cappedLeagueId, nonPublicLeagueId].filter(
      (id): id is number => typeof id === 'number',
    );
    if (leagueIds.length === 0) return;

    const registrations = await db
      .select({ bowlerId: leagueRegistrations.bowlerId })
      .from(leagueRegistrations)
      .where(inArray(leagueRegistrations.leagueId, leagueIds));
    const bowlerIds = Array.from(new Set(registrations.map((row) => row.bowlerId)));

    await db.delete(leagueRegistrations).where(inArray(leagueRegistrations.leagueId, leagueIds));
    if (bowlerIds.length > 0) {
      await db.delete(bowlerLeagues).where(inArray(bowlerLeagues.bowlerId, bowlerIds));
      await db.delete(bowlers).where(inArray(bowlers.id, bowlerIds));
    }
    await db.delete(teams).where(inArray(teams.leagueId, leagueIds));
    await db.delete(leagues).where(inArray(leagues.id, leagueIds));
  });

  it('hides a league that has not opted into public signup', async () => {
    const response = await publicGet(nonPublicLeagueId);
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe('NOT_FOUND');
  });

  it('returns public league and organization details', async () => {
    const response = await publicGet(openLeagueId);
    expect(response.status).toBe(200);
    const body = response.body as {
      data: { league: { id: number; isFull: boolean }; organization: { id: number } };
    };
    expect(body.data.league.id).toBe(openLeagueId);
    expect(body.data.league.isFull).toBe(false);
    expect(body.data.organization.id).toBe(orgAId);
  });

  it('registers multiple adult bowlers under one submission', async () => {
    const response = await publicSubmit({
      leagueId: openLeagueId,
      bowlers: [
        { name: `Vitest Adult A ${stamp}`, email: `adult-a-${stamp}@example.test` },
        { name: `Vitest Adult B ${stamp}`, email: `adult-b-${stamp}@example.test` },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data?.bowlerIds.length).toBe(2);
    expect(response.body.data?.registrationIds.length).toBe(2);

    const links = await db
      .select({ teamId: bowlerLeagues.teamId })
      .from(bowlerLeagues)
      .where(and(
        eq(bowlerLeagues.leagueId, openLeagueId),
        inArray(bowlerLeagues.bowlerId, response.body.data?.bowlerIds ?? []),
      ));
    expect(links).toHaveLength(2);
    expect(new Set(links.map((link) => link.teamId)).size).toBe(1);
  });

  it('rejects a submission that would overflow the roster cap without partial writes', async () => {
    const response = await publicSubmit({
      leagueId: cappedLeagueId,
      bowlers: [
        { name: `Vitest Capped A ${stamp}` },
        { name: `Vitest Capped B ${stamp}` },
      ],
    });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('ROSTER_FULL');

    const links = await db
      .select({ id: bowlerLeagues.id })
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.leagueId, cappedLeagueId));
    expect(links).toHaveLength(0);
  });

  it('allows an adult league to use the public registration flow', async () => {
    const response = await publicSubmit({
      leagueId: cappedLeagueId,
      bowlers: [{ name: `Vitest Capped Solo ${stamp}` }],
    });
    expect(response.status).toBe(200);
    expect(response.body.data?.bowlerIds).toHaveLength(1);
  });
});
