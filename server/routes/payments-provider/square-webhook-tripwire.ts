import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../logger';
import { squareWebhookTripwireLimiter } from '../../middleware/rate-limit';
import { apiHeaders, securityHeaders } from '../../middleware/security';
import { sendError } from '../../utils/api';

const log = createLogger('SquareWebhook');

export const SQUARE_WEBHOOK_TRIPWIRE_PATH = '/api/payments-provider/webhooks/square';
export const SQUARE_WEBHOOK_TRIPWIRE_BODY_LIMIT_BYTES = 12 * 1024;
export const SQUARE_WEBHOOK_REQUEST_ID_HEADER = 'X-Request-ID';

const MAX_LOGGABLE_DECLARED_CONTENT_LENGTH = 1_000_000;
const REQUEST_ID_LOCAL = 'squareWebhookTripwireRequestId';

type SquareWebhookOutcome =
  | 'rejected_not_implemented'
  | 'rejected_payload_too_large'
  | 'rejected_invalid_json';

interface SquareWebhookDiagnostic {
  event: 'square_webhook_not_implemented';
  requestId: string;
  method: 'POST';
  path: typeof SQUARE_WEBHOOK_TRIPWIRE_PATH;
  contentType: 'application/json' | 'other' | 'none';
  declaredContentLength: number | null;
  outcome: SquareWebhookOutcome;
}

function getRequestId(res: Response): string {
  const existing = res.locals[REQUEST_ID_LOCAL];
  if (typeof existing === 'string') return existing;

  // Defensive fallback for direct handler tests. Production registration
  // always runs initializeSquareWebhookRequest first.
  const requestId = randomUUID();
  res.locals[REQUEST_ID_LOCAL] = requestId;
  res.setHeader(SQUARE_WEBHOOK_REQUEST_ID_HEADER, requestId);
  return requestId;
}

function normalizedContentType(req: Request): SquareWebhookDiagnostic['contentType'] {
  if (req.headers['content-type'] === undefined) return 'none';
  return req.is('json') ? 'application/json' : 'other';
}

function boundedDeclaredContentLength(req: Request): number | null {
  const value = req.headers['content-length'];
  if (typeof value !== 'string' || !/^\d{1,7}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_LOGGABLE_DECLARED_CONTENT_LENGTH
    ? parsed
    : null;
}

function diagnosticFor(
  req: Request,
  res: Response,
  outcome: SquareWebhookOutcome,
): SquareWebhookDiagnostic {
  return {
    event: 'square_webhook_not_implemented',
    requestId: getRequestId(res),
    method: 'POST',
    path: SQUARE_WEBHOOK_TRIPWIRE_PATH,
    contentType: normalizedContentType(req),
    declaredContentLength: boundedDeclaredContentLength(req),
    outcome,
  };
}

function initializeSquareWebhookRequest(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  res.locals[REQUEST_ID_LOCAL] = requestId;
  res.setHeader(SQUARE_WEBHOOK_REQUEST_ID_HEADER, requestId);
  next();
}

const squareWebhookBodyParser = express.json({
  limit: SQUARE_WEBHOOK_TRIPWIRE_BODY_LIMIT_BYTES,
});
const squareWebhookNonJsonBodyParser = express.raw({
  limit: SQUARE_WEBHOOK_TRIPWIRE_BODY_LIMIT_BYTES,
  type: () => true,
});

function discardSquareWebhookBody(req: Request, _res: Response, next: NextFunction): void {
  // Neither parsed JSON nor non-JSON bytes are part of the tripwire contract.
  // Drop the short-lived parser result before the diagnostic handler runs.
  req.body = undefined;
  next();
}

const squareWebhookBodyErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const errorShape = err && typeof err === 'object'
    ? err as { status?: unknown; type?: unknown }
    : {};
  const tooLarge = errorShape.status === 413 || errorShape.type === 'entity.too.large';

  if (tooLarge) {
    log.warn(
      'Disabled Square webhook request rejected',
      diagnosticFor(req, res, 'rejected_payload_too_large'),
    );
    sendError(
      res,
      'Request body exceeds the allowed size',
      413,
      'SQUARE_WEBHOOK_PAYLOAD_TOO_LARGE',
    );
    return;
  }

  // Absorb parser errors here so neither the global error logger nor Sentry
  // receives an error object whose message may contain request-body fragments.
  log.warn(
    'Disabled Square webhook request rejected',
    diagnosticFor(req, res, 'rejected_invalid_json'),
  );
  sendError(res, 'Malformed JSON body', 400, 'SQUARE_WEBHOOK_INVALID_JSON');
};

function rejectSquareWebhook(req: Request, res: Response): void {
  log.warn(
    'Disabled Square webhook request rejected',
    diagnosticFor(req, res, 'rejected_not_implemented'),
  );
  sendError(
    res,
    'Square webhook receiver is not implemented',
    501,
    'SQUARE_WEBHOOK_NOT_IMPLEMENTED',
  );
}

/**
 * Register the exact disabled endpoint before tenant resolution and before the
 * global JSON parser. This keeps the request out of organization lookup and
 * prevents the global raw-body capture from ever seeing Square payload bytes.
 */
export function registerSquareWebhookTripwire(app: Express): void {
  app.post(
    SQUARE_WEBHOOK_TRIPWIRE_PATH,
    securityHeaders,
    apiHeaders,
    initializeSquareWebhookRequest,
    squareWebhookTripwireLimiter,
    squareWebhookBodyParser,
    squareWebhookNonJsonBodyParser,
    squareWebhookBodyErrorHandler,
    discardSquareWebhookBody,
    rejectSquareWebhook,
  );
}
