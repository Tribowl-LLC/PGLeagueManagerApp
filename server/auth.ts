import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { randomBytes } from "crypto";
import connectPg from "connect-pg-simple";
import { storage } from "./storage";
import { User as SelectUser } from "@shared/schema";
import { env, isDev } from "./config";
import { createLogger } from "./logger";
import { db, pool } from "./db";
import { hashPassword, comparePasswords, safeTokenCompare } from "./lib/password";
import { lockAccountCredential } from "./storage/account-action-requests";

declare module 'express-session' {
  interface SessionData {
    /** Narrow, server-side capability for an anonymous registration flow. */
    pendingRegistration?: {
      userId: number;
      organizationId: number;
      credentialGeneration: number;
      createdAt: number;
    };
  }
}

// Re-export for backward compatibility with existing import sites.
export { hashPassword, safeTokenCompare };

const log = createLogger("Auth");

/**
 * Destroy every session belonging to `userId` EXCEPT `keepSid` (the
 * caller's current session). Used after a password change so a stolen
 * cookie on another device is invalidated immediately instead of
 * lingering until its own expiry.
 *
 * connect-pg-simple stores rows in the `session` table with a JSON
 * `sess` column; passport's serialized user lives at
 * `sess->'passport'->'user'`. Older rows contain a numeric user id, while
 * current rows contain an object with the id and credential generation.
 * The `#>>` paths below support both representations without parsing
 * session JSON in application code.
 *
 * Returns the number of sessions destroyed. Errors are caught by
 * the caller — best-effort vs. blocking is up to the call site.
 */
export async function destroyOtherSessionsForUser(
  userId: number,
  keepSid: string | null,
): Promise<number> {
  const passportUserId = `COALESCE(
    sess #>> '{passport,user,id}',
    sess #>> '{passport,user}'
  )`;
  const sql = keepSid
    ? `DELETE FROM "session" WHERE ${passportUserId} = $1 AND sid <> $2`
    : `DELETE FROM "session" WHERE ${passportUserId} = $1`;
  const params = keepSid ? [String(userId), keepSid] : [String(userId)];
  const result = await pool.query(sql, params);
  return result.rowCount ?? 0;
}

/**
 * Destroy EVERY session belonging to `userId`, including the caller's.
 * Thin wrapper over `destroyOtherSessionsForUser(userId, null)`; the
 * separate name keeps the intent unambiguous at call sites where the
 * caller's own session must die too — for example the change-password
 * lockout path (task #357), where the locking event itself suggests
 * the caller may be the attacker.
 */
export async function destroyAllSessionsForUser(userId: number): Promise<number> {
  return destroyOtherSessionsForUser(userId, null);
}

const PostgresSessionStore = connectPg(session);

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

let DUMMY_HASH: string;

export interface PassportUserPayload {
  id: number;
  generation: number;
}

function credentialGeneration(user: unknown): number | undefined {
  if (!user || typeof user !== 'object') return undefined;
  const value = (user as Record<string, unknown>).credentialGeneration;
  // A user row from before the migration has no property in a mocked or
  // partially rolled-out process. Treat that row as generation zero; the
  // authoritative database read below still rejects it after rotation.
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function parsePassportUserPayload(value: unknown): PassportUserPayload | undefined {
  // Passport sessions written before credential generations were introduced
  // contain only the numeric id. Such a session is valid only while the
  // account remains at generation zero (checked during deserialization).
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return { id: value, generation: 0 };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.id !== 'number' ||
    !Number.isSafeInteger(payload.id) ||
    payload.id <= 0 ||
    typeof payload.generation !== 'number' ||
    !Number.isSafeInteger(payload.generation) ||
    payload.generation < 0
  ) {
    return undefined;
  }
  return { id: payload.id, generation: payload.generation };
}

async function initDummyHash() {
  DUMMY_HASH = await hashPassword(randomBytes(32).toString("hex"));
}

function isValidUser(user: unknown): user is SelectUser {
  if (!user || typeof user !== 'object') return false;
  const u = user as Record<string, unknown>;
  return (
    typeof u.id === 'number' &&
    typeof u.email === 'string' &&
    typeof u.password === 'string' &&
    typeof u.name === 'string' &&
    typeof u.role === 'string' &&
    credentialGeneration(user) !== undefined &&
    (u.createdAt instanceof Date || (typeof u.createdAt === 'string' && !isNaN(Date.parse(u.createdAt))))
  );
}

/**
 * Read and validate the authoritative credential snapshot while holding the
 * same transaction-scoped account lock used by credential mutations. This
 * closes the login/reset race: a password snapshot checked before a reset
 * cannot be serialized with the reset's newer generation.
 */
async function getAuthoritativeLoginUser(user: SelectUser): Promise<SelectUser | undefined> {
  const candidateGeneration = credentialGeneration(user);
  if (candidateGeneration === undefined) return undefined;

  return db.transaction(async tx => {
    await lockAccountCredential(tx, user.id);
    const current = await storage.getUser(user.id, tx);
    if (!current || !isValidUser(current)) return undefined;
    if (
      current.password !== user.password ||
      credentialGeneration(current) !== candidateGeneration
    ) {
      return undefined;
    }
    return current;
  });
}

export async function setupAuth(app: Express) {
  await initDummyHash();
  const isProduction = !isDev;

  const sessionSettings: session.SessionOptions = {
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new PostgresSessionStore({
      pool,
      // Expired sessions are excluded by the store's reads, so automatic
      // pruning is database housekeeping rather than session correctness.
      // Keep it out of the request process so Neon can reach its idle window;
      // cleanup can run through a deliberate low-frequency maintenance path.
      pruneSessionInterval: false,
      tableName: 'session',
    }),
    cookie: {
      // Production sessions are HTTPS-only. Local and test sessions need to
      // work over loopback HTTP, but remain same-site.
      secure: isProduction,
      sameSite: "lax" as const,
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      // safe: APP_DOMAIN is normalised to lowercase at parse-time (task #335).
      // Cookie domain matching is case-insensitive per RFC 6265 §5.1.3, but
      // we still emit the canonical lowercase form so the Set-Cookie header
      // is readable.
      ...(isProduction ? { domain: `.${env.APP_DOMAIN}` } : {}),
    },
  };

  app.set("trust proxy", 1);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy({
      usernameField: 'email',
      passwordField: 'password',
    }, async (email: string, password: string, done) => {
      try {
        const user = await storage.getUserByEmail(email);

        if (!user) {
          await comparePasswords(password, DUMMY_HASH);
          return done(null, false, { message: "Invalid email or password" });
        }

        if (!isValidUser(user)) {
          const userId = user && typeof user === 'object' ? (user as Record<string, unknown>).id : undefined;
          log.error('Invalid user object structure for ID:', { userId });
          await comparePasswords(password, DUMMY_HASH);
          return done(null, false, { message: "Invalid user data structure" });
        }

        const isValidPassword = await comparePasswords(password, user.password);

        if (!isValidPassword) {
          return done(null, false, { message: "Invalid email or password" });
        }

        return done(null, user);
      } catch (error) {
        log.error('Login error:', error);
        return done(error);
      }
    }),
  );

  passport.serializeUser(async (user, done) => {
    if (!isValidUser(user)) {
      return done(new Error('Invalid user object during serialization'));
    }

    try {
      const current = await getAuthoritativeLoginUser(user);
      if (!current) {
        return done(new Error('Stale user object during serialization'));
      }
      const generation = credentialGeneration(current);
      if (generation === undefined) {
        return done(new Error('Invalid user object during serialization'));
      }
      done(null, {
        id: current.id,
        generation,
      } satisfies PassportUserPayload);
    } catch (error) {
      log.error('Serialization error:', error);
      done(error);
    }
  });

  passport.deserializeUser(async (serialized: unknown, done) => {
    const payload = parsePassportUserPayload(serialized);
    if (!payload) return done(null, null);

    try {
      // This is a security decision, so it must always use an authoritative
      // read. The former 60-second cache could keep a pre-rotation user alive
      // on another process after the credential generation changed.
      const user = await storage.getUser(payload.id);
      if (!user || !isValidUser(user) || credentialGeneration(user) !== payload.generation) {
        return done(null, null);
      }
      done(null, user);
    } catch (error) {
      log.error('Deserialization error:', error);
      done(error);
    }
  });

}
