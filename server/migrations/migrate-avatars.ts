import { db } from "../db";
import { users } from "@shared/schema";
import { eq, like, sql } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { createLogger } from '../logger';
import { DATABASE_SCHEMA_WRITER_LOCK_KEY } from '@shared/database-advisory-locks';

const log = createLogger("AvatarMigration");

const AVATARS_DIR = path.join(process.cwd(), "uploads", "avatars");

async function dropLegacyAvatarTable(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${DATABASE_SCHEMA_WRITER_LOCK_KEY})`);
    await tx.execute(sql`DROP TABLE IF EXISTS user_avatars`);
  });
}

const EXT_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function ensureAvatarsDirectory(): void {
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
}

export async function migrateAvatarsFromDBToDisk(): Promise<boolean> {
  const tableExists = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'user_avatars'
    ) AS "exists"
  `);

  const exists = tableExists.rows?.[0]?.exists === true || tableExists.rows?.[0]?.exists === 't';
  if (!exists) {
    return true;
  }

  const rows = await db.execute(sql`SELECT user_id, data, mime_type FROM user_avatars`);

  if (rows.rows.length === 0) {
    log.info("No avatars in DB to migrate, dropping user_avatars table");
    await dropLegacyAvatarTable();
    return true;
  }

  log.info(`Migrating ${rows.rows.length} avatars from DB to disk`);

  ensureAvatarsDirectory();

  let failedCount = 0;

  for (const row of rows.rows) {
    const userId = row.user_id as number;
    const base64Data = row.data as string;
    const mimeType = row.mime_type as string;

    try {
      const ext = EXT_MAP[mimeType] || "jpg";
      const filename = `${userId}.${ext}`;
      const filePath = path.join(AVATARS_DIR, filename);

      const buffer = Buffer.from(base64Data, "base64");
      fs.writeFileSync(filePath, buffer);

      const avatarUrl = `/api/user/avatar/${userId}?v=${Date.now()}`;
      await db.update(users).set({ avatar: avatarUrl }).where(eq(users.id, userId));

      log.info(`Migrated avatar for user ${userId} to ${filename}`);
    } catch (error) {
      failedCount++;
      log.error(`Failed to migrate avatar for user ${userId}:`, error);
    }
  }

  if (failedCount > 0) {
    log.warn(`${failedCount} avatar(s) failed to migrate, keeping user_avatars table for retry on next startup`);
    return false;
  }

  await dropLegacyAvatarTable();
  log.info("All avatars migrated successfully, user_avatars table dropped");
  return true;
}

// Rewrites legacy `/uploads/avatars/<id>.<ext>` URLs (from when the
// avatars directory was served statically without auth) to the gated
// `/api/user/avatar/<id>?v=<ts>` form. The static mount has been
// removed, so any row still pointing at `/uploads/avatars/...` would
// 404 in the UI.
//
// The `?v=<ts>` query string is a cache buster: browsers that
// previously cached the static path under the new URL key never see
// a stale image. The server ignores the query string when serving.
//
// Idempotent — only matches rows that still hold the legacy prefix,
// so re-running the migration is a no-op once everyone has been
// rewritten. Replaces the prior `migrateApiUrlsToDiskUrls` which did
// the inverse rollback.
export async function migrateDiskUrlsToApiUrls(): Promise<void> {
  const usersWithDiskUrls = await db
    .select({ id: users.id, avatar: users.avatar })
    .from(users)
    .where(like(users.avatar, "/uploads/avatars/%"));

  if (usersWithDiskUrls.length === 0) {
    return;
  }

  log.info(`Rewriting ${usersWithDiskUrls.length} legacy /uploads/avatars/ URLs to gated /api/user/avatar/ form`);

  const now = Date.now();
  for (const user of usersWithDiskUrls) {
    const avatarUrl = `/api/user/avatar/${user.id}?v=${now}`;
    await db.update(users).set({ avatar: avatarUrl }).where(eq(users.id, user.id));
  }

  log.info(`Rewrote ${usersWithDiskUrls.length} avatar URLs`);
}
