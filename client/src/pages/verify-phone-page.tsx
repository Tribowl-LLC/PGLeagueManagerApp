import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useLocation } from "wouter";
import { apiRequest, makeApiError, parseRetryAfterSeconds } from "@/lib/queryClient";
import { isAbortError, isExpectedApiError } from "@/lib/api-error";
import { logger } from "@/lib/logger";
import { ErrorBoundary } from "@/components/error-boundary";
import { PublicPageLayout, PublicProgress } from "@/components/public-page-layout";
import { ArrowLeft, ArrowRight, Loader2, MessageSquare, RefreshCw } from "lucide-react";

declare global {
  interface CredentialRequestOptions {
    otp?: { transport: string[] };
  }
}

const statusSchema = z.object({
  phase: z.string().optional(),
  status: z.string().optional(),
  phone: z.string().nullable().optional(),
  phoneMasked: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  verificationExpiresAt: z.string().nullable().optional(),
  passwordSetupExpiresAt: z.string().nullable().optional(),
  resendAvailableAt: z.string().nullable().optional(),
  cooldownSeconds: z.number().int().nonnegative().optional(),
  delivery: z.enum(["sms", "email", "unknown"]).optional(),
}).passthrough();

type RegistrationStatus = z.infer<typeof statusSchema>;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function retrySeconds(error: unknown): number {
  const status = error as { retryAfterSeconds?: unknown };
  if (typeof status.retryAfterSeconds === "number" && status.retryAfterSeconds > 0) {
    return Math.ceil(status.retryAfterSeconds);
  }
  return 30;
}

function readOtpCode(credential: Credential | null): string | undefined {
  if (!credential || !Object.prototype.hasOwnProperty.call(credential, "code")) return undefined;
  const code = Reflect.get(credential, "code");
  return typeof code === "string" ? code : undefined;
}

function formatPhone(status: RegistrationStatus | null): string {
  return status?.phone || status?.phoneMasked || "your phone";
}

export default function VerifyPhonePage() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<RegistrationStatus | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const submittedCodeRef = useRef<string | null>(null);
  const autoVerifyRef = useRef(false);
  const verifyCodeRef = useRef<(submittedCode?: string) => Promise<void>>(async () => undefined);
  const sendCodeRef = useRef<() => Promise<void>>(async () => undefined);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/auth/registration/status", {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status === 401 || response.status === 404) {
      setLocation("/register");
      return null;
    }
    if (!response.ok) throw new Error("We could not restore your registration. Please try again.");
    const body: unknown = await response.json();
    const parsed = z.object({ success: z.literal(true), data: statusSchema }).safeParse(body);
    if (!parsed.success) throw new Error("The registration status response was invalid.");
    setStatus(parsed.data.data);
    const cooldown = parsed.data.data.cooldownSeconds ?? 0;
    if (cooldown > 0) setResendIn(cooldown);
    return parsed.data.data;
  }, [setLocation]);

  const sendCode = useCallback(async () => {
    if (sending || resendIn > 0) return;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await apiRequest<{
        delivery?: "sms" | "email" | "unknown";
        phase?: string;
        cooldownSeconds?: number;
      }>("/api/auth/registration/send", "POST");
      const delivery = response.data?.delivery;
      if (delivery === "email") {
        setNotice("This email is already registered. Check your email for password-reset instructions.");
      } else if (delivery === "sms" || delivery === undefined) {
        setNotice("A six-digit code was sent by text message.");
      } else {
        setNotice("Check your email for the next step.");
      }
      const seconds = response.data?.cooldownSeconds ?? 30;
      setResendIn(seconds);
      await loadStatus();
    } catch (caught) {
      const seconds = retrySeconds(caught);
      setResendIn(seconds);
      setError(errorMessage(caught, "We could not send the verification message. Please try again later."));
    } finally {
      setSending(false);
    }
  }, [loadStatus, resendIn, sending]);

  useEffect(() => {
    sendCodeRef.current = sendCode;
  }, [sendCode]);

  const verifyCode = useCallback(async (submittedCode?: string) => {
    const value = (submittedCode ?? code).replace(/\D/g, "").slice(0, 6);
    if (value.length !== 6 || verifying || submittedCodeRef.current === value) return;
    submittedCodeRef.current = value;
    setVerifying(true);
    setError(null);
    try {
      await apiRequest<{ phase?: string }>("/api/auth/registration/verify", "POST", { code: value });
      abortRef.current?.abort();
      setLocation("/set-password?registration=sms");
    } catch (caught) {
      submittedCodeRef.current = null;
      setCode("");
      setError(errorMessage(caught, "That code was not accepted. Request a new code and try again."));
      inputRef.current?.focus();
    } finally {
      setVerifying(false);
    }
  }, [code, setLocation, verifying]);

  // Keep the long-lived WebOTP listener pointed at the latest verification
  // callback without restarting (and aborting) the listener on every digit.
  useEffect(() => {
    verifyCodeRef.current = verifyCode;
  }, [verifyCode]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const current = await loadStatus(controller.signal);
        if (!current) return;
        if (current.phase === "set_password") {
          setLocation("/set-password?registration=sms");
          return;
        }
        if (current.phase === "complete") {
          setLocation("/registration-complete");
          return;
        }
        // A refresh must restore the current challenge without sending a new
        // message. Only the initial visit (no prior send timestamp) starts the
        // first provider delivery; all later sends are explicit button clicks.
        if (!current.resendAvailableAt) await sendCodeRef.current();
      } catch (caught) {
        if (!isAbortError(caught)) setError(errorMessage(caught, "We could not restore your registration."));
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
    // The page starts one send operation for the current session. Resends are
    // explicit and are handled by the button below.
  }, [loadStatus, setLocation]);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = window.setInterval(() => setResendIn((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const credentials = navigator.credentials;
    if (!credentials || typeof credentials.get !== "function") return () => controller.abort();
    try {
      void credentials.get({ otp: { transport: ["sms"] }, signal: controller.signal })
        .then((credential) => {
          const code = readOtpCode(credential);
          if (code && /^\d{6}$/.test(code) && !autoVerifyRef.current) {
            autoVerifyRef.current = true;
            setCode(code);
            void verifyCodeRef.current(code);
          }
        })
        .catch(() => undefined);
    } catch {
      // Browsers that expose navigator.credentials but do not implement the
      // SMS OTP transport can throw synchronously. Manual entry remains the
      // supported fallback in that case.
    }
    return () => controller.abort();
  }, []);

  const displayCode = code.padEnd(6, " ").slice(0, 6).split("");
  const isEmailBranch = status?.delivery === "email" || status?.phase === "email" || status?.status === "email";
  const changeDetails = async () => {
    try {
      await apiRequest("/api/auth/registration/abandon", "POST");
    } catch {
      // Navigation still returns the user to the public form; the server will
      // supersede any stale capability when the corrected form is submitted.
    }
    setLocation("/register");
  };

  return (
    <ErrorBoundary level="section">
      <PublicPageLayout>
        <section className="public-flow-card" data-testid="verify-phone-card">
          {!isEmailBranch && <PublicProgress step={2} />}
          <div className="public-flow-icon"><MessageSquare size={23} strokeWidth={1.8} /></div>
          <h1 className="public-flow-title">{isEmailBranch ? "Check your email." : "Check your texts."}</h1>
          <p className="public-flow-description">
            {isEmailBranch
              ? "This email already has a LeagueVault account. Follow the password-reset instructions we sent to continue."
              : <>Enter the six-digit code sent to <strong>{formatPhone(status)}</strong>.</>}
          </p>
          {notice && <div className="public-flow-inset" role="status"><strong>Message sent</strong>{notice}</div>}
          {error && <div className="public-flow-inset public-flow-inset-danger" role="alert"><strong>Registration could not continue</strong>{error}</div>}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-navigation-600"><Loader2 className="size-4 animate-spin" /> Restoring registration…</div>
          ) : isEmailBranch ? (
            <div className="grid gap-3">
              <button type="button" className="public-flow-primary" onClick={() => setLocation("/login")}>Go to login <ArrowRight size={18} /></button>
              <button type="button" className="public-flow-secondary" onClick={() => setLocation("/register")}>Use a different email</button>
            </div>
          ) : (
            <>
              <div className="relative" onClick={() => inputRef.current?.focus()}>
                <div className="grid grid-cols-6 gap-2" aria-hidden="true">
                  {displayCode.map((digit, index) => (
                    <div key={index} className="flex h-12 items-center justify-center rounded-md border border-navigation-300 bg-white text-xl font-semibold text-navigation-800">{digit.trim()}</div>
                  ))}
                </div>
                <input
                  ref={inputRef}
                  value={code}
                  onChange={(event) => {
                    const value = event.target.value.replace(/\D/g, "").slice(0, 6);
                    setCode(value);
                    submittedCodeRef.current = null;
                    if (value.length === 6) void verifyCode(value);
                  }}
                  aria-label="Six-digit verification code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  className="absolute inset-0 h-12 w-full cursor-text bg-transparent text-transparent caret-transparent outline-none"
                />
              </div>
              <button type="button" className="public-flow-primary mt-6 disabled:cursor-not-allowed disabled:opacity-60" disabled={code.length !== 6 || verifying} onClick={() => void verifyCode()}>
                {verifying ? <><Loader2 className="size-4 animate-spin" /> Verifying…</> : <>Verify code <ArrowRight size={18} /></>}
              </button>
              <div className="public-flow-verify-actions mt-1 flex items-center justify-between gap-3">
                <button type="button" className="public-flow-link" onClick={() => void changeDetails()}><ArrowLeft size={16} /> Change phone number</button>
                <button type="button" className="public-flow-link" disabled={sending || resendIn > 0} onClick={() => void sendCode()}>
                  <RefreshCw className="size-3.5" /> {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                </button>
              </div>
            </>
          )}
        </section>
      </PublicPageLayout>
    </ErrorBoundary>
  );
}
