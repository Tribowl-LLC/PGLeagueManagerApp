import { Router } from "express";
import { sendError } from "../utils/api.js";

/** PR1 retires F3 policy/authorization/plan writes. Historical evidence is
 * available through the archive report; no request may reach a dropped F3
 * relation or start automatic collection. */
const router = Router();
router.all("*", (_req, res) => sendError(res, "Automatic payment policy setup is not available in roster-driven payments", 410, "F3_RETIRED"));

export default router;
