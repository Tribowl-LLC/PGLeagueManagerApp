import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { organizations, bowlers, leagues, teams, bowlerLeagues } from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { getBowlers, getAllBowlersSystemAdmin } from "../../server/storage/bowlers";
import { deleteOrganization } from "../../server/storage/organizations";
import { cacheInvalidate } from "../../server/utils/cache";

const db = getTestDb();
const organizationIds: number[] = [];
let organizationId: number;
let teamId: number;
let rosteredId: number;
let unassignedId: number;
let foreignId: number;

beforeAll(async () => {
  const suffix = randomUUID();
  const created = await db.insert(organizations).values([
    { name: "Directory organization A", slug: `directory-a-${suffix}` },
    { name: "Directory organization B", slug: `directory-b-${suffix}` },
  ]).returning({ id: organizations.id });
  organizationIds.push(...created.map((row) => row.id));
  const [own, foreign] = created;
  if (!own || !foreign) throw new Error("Missing directory fixture organizations");
  organizationId = own.id;
  const profiles = await db.insert(bowlers).values([
    { name: "Rostered fixture", organizationId, order: 1 },
    { name: "Unassigned fixture", organizationId, order: 2 },
    { name: "Foreign fixture", organizationId: foreign.id, order: 3 },
  ]).returning({ id: bowlers.id });
  const [rostered, unassigned, foreignProfile] = profiles;
  if (!rostered || !unassigned || !foreignProfile) throw new Error("Missing directory profiles");
  rosteredId = rostered.id;
  unassignedId = unassigned.id;
  foreignId = foreignProfile.id;
  const [league] = await db.insert(leagues).values({
    name: "Directory league", organizationId, weekDay: "Monday",
    seasonStart: "2039-01-03T00:00:00Z", seasonEnd: "2039-04-03T00:00:00Z",
  }).returning({ id: leagues.id });
  if (!league) throw new Error("Missing directory league");
  const [team] = await db.insert(teams).values({ name: "Directory team", number: 1, leagueId: league.id })
    .returning({ id: teams.id });
  if (!team) throw new Error("Missing directory team");
  teamId = team.id;
  await db.insert(bowlerLeagues).values({ bowlerId: rosteredId, leagueId: league.id, teamId });
});

afterAll(async () => {
  for (const id of organizationIds) await deleteOrganization(id);
  cacheInvalidate("bowlers:");
});

describe("administrator bowler directory", () => {
  it("includes owned unassigned profiles without mixing roster-only caches or foreign owners", async () => {
    const rosterOnly = { organizationId };
    expect((await getBowlers(rosterOnly)).map((row) => row.id)).toEqual([rosteredId]);
    const directory = await getBowlers({ organizationId, includeUnassigned: true });
    expect(directory.map((row) => row.id)).toEqual([rosteredId, unassignedId]);
    expect(directory.some((row) => row.id === foreignId)).toBe(false);
    expect((await getBowlers(rosterOnly)).map((row) => row.id)).toEqual([rosteredId]);
  });

  it("preserves explicit team membership filtering", async () => {
    const rows = await getBowlers({ organizationId, teamId, includeUnassigned: true });
    expect(rows.map((row) => row.id)).toEqual([rosteredId]);
  });

  it("lets the explicit global administrator directory see owned unassigned profiles", async () => {
    const ids = (await getAllBowlersSystemAdmin(true)).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([rosteredId, unassignedId, foreignId]));
    const rosterOnly = (await getAllBowlersSystemAdmin()).map((row) => row.id);
    expect(rosterOnly).not.toContain(unassignedId);
    expect(rosterOnly).not.toContain(foreignId);
  });
});
