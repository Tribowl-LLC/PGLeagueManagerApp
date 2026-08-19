import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  bowlerLeagues,
  bowlers,
  leagues,
  locations,
  teams,
  users,
} from '@shared/schema';
import { getTestDb } from '../setup/test-db';
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  getBaselineOrgAId,
  login,
  type AuthSession,
} from '../helpers';
import { hashPassword } from '../../server/lib/password';

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const password = 'Payment-manager-boundary-123!';

let managerId = 0;
let locationId = 0;
let leagueId = 0;
let teamId = 0;
let bowlerId = 0;
let rosterId = 0;
let session: AuthSession;

beforeAll(async () => {
  const organizationId = await getBaselineOrgAId();
  const [location] = await db.insert(locations).values({
    name: `PM Boundary Location ${suffix}`,
    organizationId,
  }).returning();
  locationId = location.id;

  const [league] = await db.insert(leagues).values({
    name: `PM Boundary League ${suffix}`,
    seasonStart: '2030-01-01T00:00:00.000Z',
    seasonEnd: '2030-03-31T00:00:00.000Z',
    weekDay: 'Monday',
    weeklyFee: 2000,
    paymentMode: 'weekly',
    organizationId,
    locationId,
  }).returning();
  leagueId = league.id;

  const [team] = await db.insert(teams).values({
    name: `PM Boundary Team ${suffix}`,
    number: 1,
    leagueId,
  }).returning();
  teamId = team.id;

  const [bowler] = await db.insert(bowlers).values({
    name: `PM Boundary Bowler ${suffix}`,
    email: `pm-boundary-bowler-${suffix}@example.com`,
    organizationId,
  }).returning();
  bowlerId = bowler.id;

  const [roster] = await db.insert(bowlerLeagues).values({
    bowlerId,
    leagueId,
    teamId,
    order: 0,
  }).returning();
  rosterId = roster.id;

  const email = `pm-boundary-${suffix}@example.com`;
  const [manager] = await db.insert(users).values({
    name: `PM Boundary Manager ${suffix}`,
    email,
    password: await hashPassword(password),
    role: 'payment_manager',
    organizationId,
    locationId,
  }).returning();
  managerId = manager.id;
  session = await login(email, password);
});

afterAll(async () => {
  if (managerId) await db.delete(users).where(eq(users.id, managerId));
  if (rosterId) await db.delete(bowlerLeagues).where(eq(bowlerLeagues.id, rosterId));
  if (bowlerId) await db.delete(bowlers).where(eq(bowlers.id, bowlerId));
  if (teamId) await db.delete(teams).where(eq(teams.id, teamId));
  if (leagueId) await db.delete(leagues).where(eq(leagues.id, leagueId));
  if (locationId) await db.delete(locations).where(eq(locations.id, locationId));
});

describe('payment-manager roster boundaries', () => {
  it('allows assigned-location roster reads', async () => {
    const currentUser = await apiGet('/api/user', session);
    expect(currentUser.status, JSON.stringify(currentUser.data)).toBe(200);
    const teamList = await apiGet(`/api/teams?leagueId=${leagueId}`, session);
    expect(teamList.status, JSON.stringify({ response: teamList.data, user: currentUser.data, leagueId, locationId })).toBe(200);
    expect((await apiGet(`/api/teams/${teamId}`, session)).status).toBe(200);
    expect((await apiGet(`/api/bowler-leagues?leagueId=${leagueId}`, session)).status).toBe(200);
  });

  it('denies every team and roster mutation', async () => {
    const results = await Promise.all([
      apiPost('/api/teams', { name: 'Denied', number: 2, leagueId }, session),
      apiPatch(`/api/teams/${teamId}`, { name: 'Denied rename' }, session),
      apiPatch('/api/teams/reorder', { leagueId, teams: [{ id: teamId, displayOrder: 0, number: 1 }] }, session),
      apiDelete(`/api/teams/${teamId}`, session),
      apiPost('/api/bowler-leagues', { bowlerId, leagueId, teamId, order: 1 }, session),
      apiPatch(`/api/bowler-leagues/${rosterId}`, { order: 1 }, session),
      apiPatch(`/api/bowler-leagues/${rosterId}/order`, { newOrder: 1 }, session),
      apiDelete(`/api/bowler-leagues/${rosterId}`, session),
    ]);
    expect(results.map((result) => result.status)).toEqual(Array(8).fill(403));

    const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
    const [roster] = await db.select().from(bowlerLeagues).where(eq(bowlerLeagues.id, rosterId));
    expect(team?.name).toBe(`PM Boundary Team ${suffix}`);
    expect(roster?.order).toBe(0);
  });

  it('denies bowler creation before duplicate lookup can disclose another record', async () => {
    const response = await apiPost('/api/bowlers', {
      name: 'Denied duplicate probe',
      email: `pm-boundary-bowler-${suffix}@example.com`,
      teamId,
    }, session);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.data)).not.toContain('existingBowler');
  });
});
