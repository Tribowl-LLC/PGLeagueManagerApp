import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { randomBytes } from "crypto";
import connectPg from "connect-pg-simple";
import { storage } from "./storage";
import { User as SelectUser } from "@shared/schema";
import { cacheFetch } from "./utils/cache";
import { env, isDev, isDeployment } from "./config";
import { createLogger } from "./logger";
import { pool } from "./db";
import { hashPassword, comparePasswords, safeTokenCompare } from "./lib/password";

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
 * `sess` column; passport's serialized user id lives at
 * `sess->'passport'->>'user'` (TEXT). We compare as text since the
 * column is JSON-encoded.
 *
 * Returns the number of sessions destroyed. Errors are caught by
 * the caller — best-effort vs. blocking is up to the call site.
 */
export async function destroyOtherSessionsForUser(
  userId: number,
  keepSid: string | null,
): Promise<number> {
  const sql = keepSid
    ? `DELETE FROM "session" WHERE sess->'passport'->>'user' = $1 AND sid <> $2`
    : `DELETE FROM "session" WHERE sess->'passport'->>'user' = $1`;
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
    (u.createdAt instanceof Date || (typeof u.createdAt === 'string' && !isNaN(Date.parse(u.createdAt))))
  );
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
      // Test escape hatch (Task #700): the per-worker test app is
      // spawned with `TRUST_PROXY_DISABLE_SECURE_COOKIES=1` so the
      // session cookie is sent over plain http://127.0.0.1:<port>
      // instead of being silently dropped because REPLIT_DOMAINS is
      // set in this workspace. Gated to non-production NODE_ENV so it
      // can never leak into a real deployment.
      secure: (
        process.env.TRUST_PROXY_DISABLE_SECURE_COOKIES === '1' && isDev
      ) ? false : (!isDev || isDeployment || !!env.REPLIT_DOMAINS),
      sameSite: (
        process.env.TRUST_PROXY_DISABLE_SECURE_COOKIES === '1' && isDev
      ) ? "lax" as const : ((isDev && !!env.REPLIT_DOMAINS) ? "none" as const : "lax" as const),
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

  passport.serializeUser((user, done) => {
    if (!isValidUser(user)) {
      return done(new Error('Invalid user object during serialization'));
    }
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await cacheFetch(`user:${id}`, 60_000, () => storage.getUser(id));
      if (!user || !isValidUser(user)) {
        return done(null, null);
      }
      done(null, user);
    } catch (error) {
      log.error('Deserialization error:', error);
      done(error);
    }
  });

}
