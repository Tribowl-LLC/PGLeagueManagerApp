import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { bowlers, locations, users } from '@shared/schema';
import { getBaselineOrgIds } from '../helpers';
import { getTestDb } from '../setup/test-db';

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const userIds: number[] = [];
const bowlerIds: number[] = [];
const locationIds: number[] = [];
let orgAId = 0;
let orgBId = 0;

type PostgresConstraintError = {
  code: string;
  constraint: string;
};

function matchesPostgresConstraintError(
  error: unknown,
  expected: PostgresConstraintError,
): boolean {
  const seen = new Set<object>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (candidate.code === expected.code && candidate.constraint === expected.constraint) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

async function expectPostgresConstraintError(
  operation: Promise<unknown>,
  expected: PostgresConstraintError,
): Promise<void> {
  let rejected = false;
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    rejected = true;
    error = caught;
  }

  expect(rejected).toBe(true);
  expect(matchesPostgresConstraintError(error, expected)).toBe(true);
}

beforeAll(async () => {
  ({ orgAId, orgBId } = await getBaselineOrgIds());
});

afterAll(async () => {
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  if (bowlerIds.length > 0) await db.delete(bowlers).where(inArray(bowlers.id, bowlerIds));
  if (locationIds.length > 0) await db.delete(locations).where(inArray(locations.id, locationIds));
});

describe('users identity-integrity constraints', () => {
  it('rejects case- or whitespace-only duplicate account emails', async () => {
    const [created] = await db.insert(users).values({
      email: `normalized-${suffix}@example.com`,
      password: 'not-used',
      name: 'Normalized Email One',
      role: 'user',
      organizationId: orgAId,
    }).returning({ id: users.id });
    userIds.push(created.id);

    await expectPostgresConstraintError(db.insert(users).values({
      email: `  NORMALIZED-${suffix}@EXAMPLE.COM `,
      password: 'not-used',
      name: 'Normalized Email Two',
      role: 'user',
      organizationId: orgAId,
    }), { code: '23505', constraint: 'users_email_normalized_unique' });
  });

  it('rejects a staff account linked to a bowler', async () => {
    const [bowler] = await db.insert(bowlers).values({
      name: `Staff Link ${suffix}`,
      organizationId: orgAId,
    }).returning({ id: bowlers.id });
    bowlerIds.push(bowler.id);

    await expectPostgresConstraintError(db.insert(users).values({
      email: `staff-link-${suffix}@example.com`,
      password: 'not-used',
      name: 'Invalid Staff Link',
      role: 'org_admin',
      organizationId: orgAId,
      bowlerId: bowler.id,
    }), { code: '23514', constraint: 'users_elevated_role_bowler_check' });
  });

  it('requires a same-organization location for payment managers', async () => {
    await expectPostgresConstraintError(db.insert(users).values({
      email: `manager-no-location-${suffix}@example.com`,
      password: 'not-used',
      name: 'Manager Without Location',
      role: 'payment_manager',
      organizationId: orgAId,
    }), { code: '23514', constraint: 'users_payment_manager_scope_check' });

    const [foreignLocation] = await db.insert(locations).values({
      name: `Foreign Location ${suffix}`,
      organizationId: orgBId,
    }).returning({ id: locations.id });
    locationIds.push(foreignLocation.id);

    await expectPostgresConstraintError(db.insert(users).values({
      email: `manager-foreign-location-${suffix}@example.com`,
      password: 'not-used',
      name: 'Manager Foreign Location',
      role: 'payment_manager',
      organizationId: orgAId,
      locationId: foreignLocation.id,
    }), { code: '23503', constraint: 'users_location_organization_fk' });

    const [localLocation] = await db.insert(locations).values({
      name: `Local Location ${suffix}`,
      organizationId: orgAId,
    }).returning({ id: locations.id });
    locationIds.push(localLocation.id);
    const [manager] = await db.insert(users).values({
      email: `manager-local-location-${suffix}@example.com`,
      password: 'not-used',
      name: 'Manager Local Location',
      role: 'payment_manager',
      organizationId: orgAId,
      locationId: localLocation.id,
    }).returning({ id: users.id });
    userIds.push(manager.id);
  });
});
