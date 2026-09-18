import twilio, { type Twilio } from "twilio";
import { env } from "../config";
import { createLogger } from "../logger";

const log = createLogger("TwilioVerify");

export type TwilioVerificationSendResult = {
  sid: string;
};

export type TwilioVerificationCheckResult =
  | { kind: "approved"; status: string }
  | { kind: "rejected"; status: string }
  | { kind: "provider_not_found" }
  | { kind: "provider_unavailable" };

export interface TwilioVerifyAdapter {
  sendSmsVerification(phone: string): Promise<TwilioVerificationSendResult>;
  checkSmsVerification(phone: string, code: string, verificationSid: string): Promise<TwilioVerificationCheckResult>;
}

function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" ? value : undefined;
}

function configuredTwilioClient(): Twilio | null {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const username = env.TWILIO_API_KEY || accountSid;
  const password = env.TWILIO_API_SECRET || env.TWILIO_AUTH_TOKEN;
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
  if (!username || !password || !serviceSid) {
    return null;
  }
  return twilio(username, password, accountSid ? { accountSid } : undefined);
}

class ConfiguredTwilioVerifyAdapter implements TwilioVerifyAdapter {
  async sendSmsVerification(phone: string): Promise<TwilioVerificationSendResult> {
    const client = configuredTwilioClient();
    const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
    if (!client || !serviceSid) throw new TwilioVerifyError("not_configured");
    try {
      const verification = await client.verify.v2
        .services(serviceSid)
        .verifications
        .create({
          to: phone,
          channel: "sms",
          ...(env.TWILIO_VERIFY_TEMPLATE_SID ? { templateSid: env.TWILIO_VERIFY_TEMPLATE_SID } : {}),
        });
      if (!verification.sid) throw new TwilioVerifyError("provider_unavailable");
      return { sid: verification.sid };
    } catch (error) {
      if (error instanceof TwilioVerifyError) throw error;
      log.warn("Twilio Verify send failed", {
        status: providerStatus(error) ?? "unknown",
        errorType: error instanceof Error ? error.name : "unknown",
      });
      throw new TwilioVerifyError(
        providerStatus(error) === 404 ? "provider_not_found" : "provider_unavailable",
      );
    }
  }

  async checkSmsVerification(
    phone: string,
    code: string,
    verificationSid: string,
  ): Promise<TwilioVerificationCheckResult> {
    const client = configuredTwilioClient();
    const serviceSid = env.TWILIO_VERIFY_SERVICE_SID;
    if (!client || !serviceSid) return { kind: "provider_unavailable" };
    try {
      // Registration checks are always fenced to the exact verification SID
      // reserved by the challenge lease. Falling back to a phone-number
      // check would allow an in-flight response from a superseded send to
      // authorize the current browser session.
      const checked = await client.verify.v2
        .services(serviceSid)
        .verificationChecks
        .create({ code, verificationSid });
      const status = String(checked.status || "").toLowerCase();
      return status === "approved"
        ? { kind: "approved", status }
        : { kind: "rejected", status: status || "rejected" };
    } catch (error) {
      const status = providerStatus(error);
      log.warn("Twilio Verify check failed", {
        status: status ?? "unknown",
        errorType: error instanceof Error ? error.name : "unknown",
      });
      // A provider 404 is an outage/configuration signal, never a successful
      // verification. The route maps this to a retryable error.
      return { kind: status === 404 ? "provider_not_found" : "provider_unavailable" };
    }
  }
}

export class TwilioVerifyError extends Error {
  constructor(public readonly code: "not_configured" | "provider_not_found" | "provider_unavailable") {
    super(code);
    this.name = "TwilioVerifyError";
  }
}

export const twilioVerifyAdapter: TwilioVerifyAdapter = new ConfiguredTwilioVerifyAdapter();

// Tests and local adapters can replace the provider without touching the
// route. Production never invokes this seam.
export function setTwilioVerifyAdapterForTests(adapter: TwilioVerifyAdapter | null): void {
  activeAdapter = adapter ?? twilioVerifyAdapter;
}

let activeAdapter: TwilioVerifyAdapter = twilioVerifyAdapter;

export function getTwilioVerifyAdapter(): TwilioVerifyAdapter {
  return activeAdapter;
}
