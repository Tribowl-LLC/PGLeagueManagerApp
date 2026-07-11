/**
 * Public, no-auth endpoints for the embeddable adult registration form.
 *
 * The endpoint only exposes leagues that are active and explicitly opted
 * into public signup. Registration writes are performed in one transaction
 * so roster caps remain correct when submissions race.
 */
import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlers,
  bowlerLeagues,
  leagueRegistrationQuestions,
  leagueRegistrations,
  leagues,
  organizations,
  teams,
  type LeagueRegistrationQuestion,
} from "@shared/schema";
import { sendSuccess, sendError, handleZodError } from "../utils/api";
import { createSharedRateLimitStore } from "../utils/rate-limit-store";
import { testBypassSkip } from "../middleware/rate-limit";
import { createLogger } from "../logger";

const log = createLogger("PublicEmbedRegistration");
const router = Router();

const embedSubmitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  store: createSharedRateLimitStore("embed-submit"),
  skip: testBypassSkip,
  message: {
    success: false,
    error: { message: "Too many registration attempts, please try again later", code: "RATE_LIMITED" },
  },
});

router.get("/leagues/:leagueId", async (req, res) => {
  try {
    const leagueId = parseInt(req.params.leagueId, 10);
    if (!Number.isFinite(leagueId) || leagueId <= 0) {
      return sendError(res, "Invalid league id", 400, "INVALID_ID");
    }

    const [row] = await db
      .select({ league: leagues, org: organizations })
      .from(leagues)
      .innerJoin(organizations, eq(organizations.id, leagues.organizationId))
      .where(eq(leagues.id, leagueId));

    if (!row || !row.league.active || !row.league.allowPublicSignup) {
      return sendError(res, "League not found", 404, "NOT_FOUND");
    }

    const questions = await db
      .select()
      .from(leagueRegistrationQuestions)
      .where(eq(leagueRegistrationQuestions.leagueId, leagueId))
      .orderBy(leagueRegistrationQuestions.displayOrder, leagueRegistrationQuestions.id);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.leagueId, leagueId));
    const registered = Number(count ?? 0);
    const cap = row.league.rosterCap;

    return sendSuccess(res, {
      league: {
        id: row.league.id,
        name: row.league.name,
        embedRegistrationFee: row.league.embedRegistrationFee,
        rosterCap: cap,
        registeredCount: registered,
        isFull: cap !== null && cap !== undefined && registered >= cap,
      },
      organization: {
        id: row.org.id,
        name: row.org.name,
        slug: row.org.slug,
        logo: row.org.logo,
      },
      questions: questions.map(stripInternal),
    });
  } catch (err) {
    log.error("get embed league failed", err);
    return sendError(res, "Failed to load registration form", 500, "SERVER_ERROR");
  }
});

function stripInternal(q: LeagueRegistrationQuestion) {
  return {
    id: q.id,
    label: q.label,
    type: q.type,
    required: q.required,
    options: q.options,
    displayOrder: q.displayOrder,
  };
}

const bowlerSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(200).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
});

const submitSchema = z.object({
  leagueId: z.number().int().positive(),
  bowlers: z.array(bowlerSchema).min(1).max(10),
  answers: z.record(z.string(), z.unknown()).optional().nullable(),
});

router.post("/registrations", embedSubmitLimiter, async (req, res) => {
  try {
    const data = submitSchema.parse(req.body);
    const [leagueRow] = await db
      .select({ league: leagues, org: organizations })
      .from(leagues)
      .innerJoin(organizations, eq(organizations.id, leagues.organizationId))
      .where(eq(leagues.id, data.leagueId));

    if (!leagueRow || !leagueRow.league.active || !leagueRow.league.allowPublicSignup) {
      return sendError(res, "League not found", 404, "NOT_FOUND");
    }
    const league = leagueRow.league;
    const orgId = league.organizationId;
    if (orgId === null || orgId === undefined) {
      return sendError(res, "League not found", 404, "NOT_FOUND");
    }

    if (league.embedRegistrationFee && league.embedRegistrationFee > 0) {
      return sendError(
        res,
        "This league has a registration fee but online checkout is not yet enabled. Please contact the league administrator.",
        400,
        "PAYMENT_NOT_AVAILABLE",
      );
    }

    const questions = await db
      .select()
      .from(leagueRegistrationQuestions)
      .where(eq(leagueRegistrationQuestions.leagueId, data.leagueId));
    const answers: Record<string, unknown> = data.answers ?? {};
    for (const q of questions) {
      const value = answers[String(q.id)];
      const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      if (q.required && empty) {
        return sendError(res, `Question "${q.label}" is required`, 400, "MISSING_ANSWER");
      }
    }

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from leagues where id = ${data.leagueId} for update`);
      if (league.rosterCap !== null && league.rosterCap !== undefined) {
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(bowlerLeagues)
          .where(eq(bowlerLeagues.leagueId, data.leagueId));
        if (Number(row?.count ?? 0) + data.bowlers.length > league.rosterCap) {
          throw new RegistrationError("ROSTER_FULL", "This league is full.");
        }
      }

      const UNASSIGNED_NUMBER = 9999;
      let [unassigned] = await tx
        .select()
        .from(teams)
        .where(and(eq(teams.leagueId, data.leagueId), eq(teams.number, UNASSIGNED_NUMBER)));
      if (!unassigned) {
        [unassigned] = await tx
          .insert(teams)
          .values({
            leagueId: data.leagueId,
            name: "Unassigned",
            number: UNASSIGNED_NUMBER,
            active: true,
            displayOrder: 9999,
          })
          .returning();
      }

      const bowlerIds: number[] = [];
      const registrationIds: number[] = [];
      for (const input of data.bowlers) {
        const [bowler] = await tx
          .insert(bowlers)
          .values({
            name: input.name,
            email: input.email ?? null,
            phone: input.phone ?? null,
            organizationId: orgId,
            active: true,
          })
          .returning();
        bowlerIds.push(bowler.id);

        await tx.insert(bowlerLeagues).values({
          bowlerId: bowler.id,
          leagueId: data.leagueId,
          teamId: unassigned.id,
          active: true,
          order: 0,
        });

        const [registration] = await tx
          .insert(leagueRegistrations)
          .values({
            leagueId: data.leagueId,
            organizationId: orgId,
            bowlerId: bowler.id,
            status: league.embedRegistrationFee && league.embedRegistrationFee > 0 ? "pending" : "free",
            source: "embed",
            answers,
          })
          .returning();
        registrationIds.push(registration.id);
      }

      return { bowlerIds, registrationIds };
    });

    return sendSuccess(res, result);
  } catch (err) {
    if (err instanceof RegistrationError) {
      return sendError(res, err.message, 409, err.code);
    }
    if (err instanceof z.ZodError) {
      handleZodError(res, err);
      return;
    }
    log.error("embed registration failed", err);
    return sendError(res, "Failed to submit registration", 500, "SERVER_ERROR");
  }
});

class RegistrationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export default router;
