import { eq } from "drizzle-orm";
import { db } from "../db.js";
import {
  locations,
  leagues,
  webhookEvents,
  locationSquareCredentialsSchema,
  type Location,
  type InsertLocation,
  type UpdateLocation,
  type LocationSquareCredentials,
} from "@shared/schema";
import { createLogger } from '../logger';
import { encrypt, decrypt, isEncrypted } from '../utils/crypto';
import { hasLocationOccurrenceEvidence } from './canonical-occurrence-evidence.js';

const log = createLogger("StorageLocations");

export class LocationWebhookEvidenceExistsError extends Error {
  constructor() {
    super('Location has retained webhook evidence and must be archived instead');
    this.name = 'LocationWebhookEvidenceExistsError';
  }
}

export class LocationOccurrenceEvidenceExistsError extends Error {
  constructor() {
    super('Location has retained canonical occurrence evidence and must be archived instead');
    this.name = 'LocationOccurrenceEvidenceExistsError';
  }
}

export class LocationLeagueReferenceExistsError extends Error {
  constructor() {
    super('Location is still assigned to one or more leagues and must be archived or reassigned before deletion');
    this.name = 'LocationLeagueReferenceExistsError';
  }
}

export class LocationOrganizationImmutableError extends Error {
  constructor() {
    super('A location cannot be moved to another organization');
    this.name = 'LocationOrganizationImmutableError';
  }
}

function encryptSquareCreds(creds: LocationSquareCredentials | null | undefined): LocationSquareCredentials | null | undefined {
  if (!creds) return creds;
  return {
    ...creds,
    accessToken: creds.accessToken ? encrypt(creds.accessToken) : creds.accessToken,
  };
}

function decryptSquareCreds(creds: LocationSquareCredentials | null | undefined): LocationSquareCredentials | null | undefined {
  if (!creds || !creds.accessToken) return creds;
  if (!isEncrypted(creds.accessToken)) return creds;
  const decrypted = decrypt(creds.accessToken);
  if (decrypted === null) {
    log.error("Failed to decrypt Square accessToken — returning without token");
    return { ...creds, accessToken: undefined };
  }
  return { ...creds, accessToken: decrypted };
}

export async function getLocations(organizationId: number): Promise<Location[]> {
  return db.select().from(locations)
    .where(eq(locations.organizationId, organizationId))
    .orderBy(locations.name);
}

export async function getAllLocationsSystemAdmin(): Promise<Location[]> {
  return db.select().from(locations).orderBy(locations.name);
}

export async function getFirstSquareConfiguredLocation(orgId: number): Promise<Location | undefined> {
  const orgLocations = await db.select().from(locations)
    .where(eq(locations.organizationId, orgId))
    .orderBy(locations.id);
  return orgLocations.find(loc => {
    const parsed = locationSquareCredentialsSchema.safeParse(loc.squareCredentials);
    if (!parsed.success || !parsed.data) return false;
    return (parsed.data.accessToken ?? '').trim().length > 0;
  });
}

export async function getAllSquareConfiguredLocations(): Promise<Location[]> {
  const all = await db.select().from(locations).orderBy(locations.id);
  return all.filter((loc) => {
    const parsed = locationSquareCredentialsSchema.safeParse(loc.squareCredentials);
    if (!parsed.success || !parsed.data) return false;
    return (parsed.data.accessToken ?? '').trim().length > 0;
  });
}

export async function getLocation(id: number): Promise<Location | undefined> {
  const [result] = await db.select().from(locations).where(eq(locations.id, id));
  return result;
}

export async function createLocation(data: InsertLocation): Promise<Location> {
  const encrypted = {
    ...data,
    squareCredentials: encryptSquareCreds(data.squareCredentials),
  };
  const [result] = await db.insert(locations).values(encrypted).returning();
  return result;
}

export async function updateLocation(id: number, data: UpdateLocation): Promise<Location> {
  let encrypted = { ...data };
  if (data.squareCredentials !== undefined) {
    encrypted = { ...encrypted, squareCredentials: encryptSquareCreds(data.squareCredentials) };
  }
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ organizationId: locations.organizationId })
      .from(locations)
      .where(eq(locations.id, id))
      .for('update');
    if (!current) throw new Error(`Location with ID ${id} not found`);
    if (data.organizationId !== undefined && data.organizationId !== current.organizationId) {
      throw new LocationOrganizationImmutableError();
    }
    const [result] = await tx.update(locations).set(encrypted).where(eq(locations.id, id)).returning();
    if (!result) throw new Error(`Location with ID ${id} not found`);
    return result;
  });
}

export async function deleteLocation(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [location] = await tx
      .select({ id: locations.id, organizationId: locations.organizationId })
      .from(locations)
      .where(eq(locations.id, id))
      .for('update');
    if (!location) return;

    const [retainedEvent] = await tx
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(eq(webhookEvents.locationId, id))
      .limit(1);
    if (retainedEvent) throw new LocationWebhookEvidenceExistsError();

    if (await hasLocationOccurrenceEvidence(tx, location.organizationId, id)) {
      throw new LocationOccurrenceEvidenceExistsError();
    }

    // Do not clear league references while holding the location row lock.
    // Rollover and league PATCH transactions may already hold a league lock
    // and then perform an FK key-share read on this location; unlinking here
    // would invert that order and can deadlock. Administrators must archive
    // or reassign the leagues first, after which deletion is safe.
    const [referencingLeague] = await tx.select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.locationId, id))
      .limit(1);
    if (referencingLeague) throw new LocationLeagueReferenceExistsError();
    await tx.delete(locations).where(eq(locations.id, id));
  });
}

export async function archiveLocation(id: number): Promise<Location> {
  const [result] = await db.update(locations).set({ active: false }).where(eq(locations.id, id)).returning();
  return result;
}

export async function restoreLocation(id: number): Promise<Location> {
  const [result] = await db.update(locations).set({ active: true }).where(eq(locations.id, id)).returning();
  return result;
}

export async function getLocationSquareConfig(locationId: number): Promise<LocationSquareCredentials | null> {
  const [location] = await db.select({ squareCredentials: locations.squareCredentials }).from(locations).where(eq(locations.id, locationId));

  if (!location?.squareCredentials) return null;

  const parsed = locationSquareCredentialsSchema.safeParse(location.squareCredentials);
  if (!parsed.success) {
    log.warn(`Malformed squareCredentials JSONB for location ${locationId}:`, parsed.error.format());
    return null;
  }
  return decryptSquareCreds(parsed.data) ?? null;
}

export async function updateLocationSquareConfig(locationId: number, creds: LocationSquareCredentials): Promise<Location> {
  const encrypted = encryptSquareCreds(creds);
  const [result] = await db.update(locations).set({ squareCredentials: encrypted }).where(eq(locations.id, locationId)).returning();
  return result;
}

export async function getFirstPaymentConfiguredLocation(orgId: number): Promise<Location | undefined> {
  return getFirstSquareConfiguredLocation(orgId);
}
