import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  LANGUAGE_AUTO,
  languageSelectionToWire,
  normalizeStoredLanguage,
} from "@/lib/preferred-language";
import type { PaymentSyncStatus, User } from "@shared/schema";
import { parsePaymentSyncStatus } from "@shared/schema";
import { ProfileInfoView } from "./profile-info-view";
import { ProfileInfoForm } from "./profile-info-form";

// Server augments the /api/user response with a derived
// `paymentSyncStatus` ('pending_retry' if the linked bowler row has
// `payment_sync_pending_at` set, otherwise null) so the retry button
// can be hydrated on initial page load — see auth.ts /user handler
// (#363). Optional because older API consumers (or unit-test fixtures
// that pass a bare User row) won't include it; treat missing as null.
export type CurrentUserWithSyncStatus = User & {
  paymentSyncStatus?: 'pending_retry' | null;
};

export type EmailDeliveryOutcome = 'accepted' | 'not_sent' | 'unknown';
export type PendingEmailChange = {
  originalEmail: string;
  requestedEmail: string;
  confirmation: EmailDeliveryOutcome;
  notification: EmailDeliveryOutcome;
};

const parseEmailDeliveryOutcome = (value: unknown): EmailDeliveryOutcome =>
  value === 'accepted' || value === 'not_sent' ? value : 'unknown';

const emailDeliveryCopy = (outcome: EmailDeliveryOutcome, subject: string) => {
  if (outcome === 'accepted') return `${subject} email was submitted.`;
  if (outcome === 'not_sent') return `We could not send the ${subject.toLowerCase()} email.`;
  return `We could not confirm whether the ${subject.toLowerCase()} email was accepted.`;
};

const profileSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Please enter a valid email"),
  phone: z.string().nullable().optional(),
  // Captured as a string by the form (Select can't bind null). The
  // mutation below maps the LANGUAGE_AUTO sentinel back to null
  // before sending the payload.
  preferredLanguage: z.string(),
});

export type ProfileFormData = z.infer<typeof profileSchema>;

// Defensive fallback when a 429 response from the retry endpoint is
// missing both `Retry-After` and `RateLimit-Reset` headers (task #441).
// The self-serve `retryPaymentSyncLimiter` (task #365) sets
// `standardHeaders: true` so this branch is unreachable in practice
// against our own server, but a misconfigured proxy or a future
// limiter swap could strip the headers — falling back to the
// limiter's 60s window keeps the cooldown UX correct (button stays
// disabled, countdown still shows) instead of silently letting a
// confused user mash the button straight into another 429.
const RETRY_COOLDOWN_FALLBACK_SECONDS = 60;

// How long after a successful retry we ignore a server-derived
// `paymentSyncStatus === 'pending_retry'` from /api/user (task #438).
//
// Background: the retry endpoint runs `syncBowlerForUser` synchronously
// and returns a fresh status, but the bowler row's
// `payment_sync_pending_at` column is cleared by the same sync helper
// — and the next /api/user refetch can race ahead of the commit
// becoming visible to a fresh read. Without a guard, the hydration
// effect below would briefly mirror that stale 'pending_retry' back
// into local state and the button would flicker into view for a beat
// before the next refetch settles. 30 seconds is comfortably longer
// than any one round-trip plus DB-replica lag we've seen, and short
// enough that a *legitimately* re-flagged pending state (e.g. a
// background re-sync) will surface to the user in well under a
// minute.
const RETRY_FLICKER_GUARD_MS = 30_000;

export function ProfileInfoCard({ currentUser }: { currentUser: CurrentUserWithSyncStatus }) {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [pendingEmailChange, setPendingEmailChange] = useState<PendingEmailChange | null>(null);
  const [emailChangeEditMode, setEmailChangeEditMode] = useState<"normal" | "retry">("normal");

  useEffect(() => {
    if (!pendingEmailChange) return;
    const currentEmail = currentUser.email.trim().toLowerCase();
    if (
      currentEmail === pendingEmailChange.requestedEmail
      || currentEmail !== pendingEmailChange.originalEmail
    ) {
      setPendingEmailChange(null);
    }
  }, [currentUser.email, pendingEmailChange]);
  // Tracks the most recent payment-sync outcome so the "Retry now"
  // button (task #323) shows up immediately after a profile edit
  // returns `pending_retry`, and disappears once a manual retry
  // succeeds. Hydrated from the server-provided
  // `currentUser.paymentSyncStatus` (#363) so the button persists
  // across page reloads while the underlying flag is set, and the
  // useEffect below keeps it in sync after /api/user is invalidated
  // (e.g. by a profile save or a successful retry).
  const [lastSyncStatus, setLastSyncStatus] = useState<PaymentSyncStatus | null>(
    () => currentUser.paymentSyncStatus ?? null,
  );

  // Wall-clock timestamp of the most recent retry that the server
  // reported as resolved (status !== 'pending_retry'). Lives in state
  // (not a ref) so the hydration effect below has a real dependency
  // to re-run on when the latch is set, cleared, or expires —
  // otherwise a stale 'pending_retry' could stay hidden forever
  // (task #438): the effect's other dep is `currentUser.paymentSyncStatus`,
  // and that string doesn't change between consecutive refetches that
  // both return the same value, so the effect would never naturally
  // re-evaluate the latch's age.
  const [latchedRetryAt, setLatchedRetryAt] = useState<number | null>(null);

  // Cooldown UX for the self-serve retry endpoint's per-user 5/min
  // throttle (task #441). When the retry mutation gets a 429, we read
  // the `Retry-After` (or `RateLimit-Reset`) header — already parsed
  // into `err.retryAfterSeconds` by `apiRequest` — and freeze the
  // button until that wall-clock deadline. `cooldownUntilMs` is the
  // absolute Date.now() the cooldown ends; `nowMs` ticks via
  // setInterval below to drive the per-second countdown render.
  // Storing wall-clock (not seconds-remaining) means a tab that's
  // backgrounded and brought back resumes with the correct remaining
  // time instead of the count it was paused on.
  const [cooldownUntilMs, setCooldownUntilMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Drive the countdown render. Only schedules an interval while a
  // cooldown is pending — otherwise the component is silent. Each
  // tick advances `nowMs` so `secondsLeft` recomputes; once the
  // deadline passes we clear `cooldownUntilMs` so the inline message
  // disappears and the button re-enables on its own (per the task
  // spec — no manual refresh needed).
  //
  // The 1000ms cadence is good enough for a "Try again in Ns" label;
  // `Math.ceil` on the remaining delta keeps the displayed count
  // monotonically decreasing (no off-by-one "0s" frame before the
  // unmount). The early-expiry branch handles a tab that was
  // backgrounded past the deadline — Date.now() jumps forward
  // enormously between renders, and we'd otherwise schedule one
  // useless tick before clearing.
  useEffect(() => {
    if (cooldownUntilMs == null) return;
    if (cooldownUntilMs <= Date.now()) {
      setCooldownUntilMs(null);
      return;
    }
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      const t = Date.now();
      setNowMs(t);
      if (t >= cooldownUntilMs) {
        setCooldownUntilMs(null);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntilMs]);

  const cooldownSecondsLeft = cooldownUntilMs != null
    ? Math.max(0, Math.ceil((cooldownUntilMs - nowMs) / 1000))
    : 0;
  const inRetryCooldown = cooldownSecondsLeft > 0;

  // The mutations below invalidate `['/api/user']`, which produces a
  // fresh `currentUser` prop with an updated `paymentSyncStatus`. We
  // mirror that into local state so a successful retry clears the
  // button without needing a manual setLastSyncStatus(null), and so a
  // background sweep that re-flags the bowler (after the user already
  // saw `synced` in this session) re-shows the action on next refetch.
  // Guarded so we only overwrite local state when the server-derived
  // value differs from what we already have — avoids clobbering a
  // freshly-set transient status (e.g. 'synced' from the retry mutation
  // before the next /api/user refetch lands) on every parent re-render.
  //
  // Flicker guard (task #438): when the server-derived value is
  // 'pending_retry' but the user has just clicked Retry and that retry
  // resolved (status !== 'pending_retry'), ignore the value if it
  // arrived within RETRY_FLICKER_GUARD_MS. The bowler row's
  // `payment_sync_pending_at` may not yet have been cleared visibly
  // when this refetch raced through. We schedule a setTimeout to drop
  // the latch at expiry and trigger one more effect-run so a server
  // that *never* reports cleared (e.g. a real lingering pending state
  // that the retry didn't actually fix) eventually surfaces the
  // button to the user instead of being trapped by the latch. The
  // latch is also dropped immediately on the first refetch that
  // confirms a non-'pending_retry' value, so a fresh re-flag arriving
  // after that isn't masked by an old latch.
  useEffect(() => {
    const next = currentUser.paymentSyncStatus ?? null;

    if (next === "pending_retry" && latchedRetryAt !== null) {
      const elapsed = Date.now() - latchedRetryAt;
      if (elapsed < RETRY_FLICKER_GUARD_MS) {
        // Suppress this stale value AND deterministically re-evaluate
        // at expiry. Setting the state to null re-triggers this effect
        // (latchedRetryAt is in its dep array), at which point the
        // suppression branch is skipped and the value is mirrored
        // normally.
        const timer = window.setTimeout(() => {
          setLatchedRetryAt(null);
        }, RETRY_FLICKER_GUARD_MS - elapsed);
        return () => window.clearTimeout(timer);
      }
      // Latch already expired (e.g. the user opened the tab again
      // long after the retry); drop it and fall through.
      setLatchedRetryAt(null);
      return;
    }

    // Server confirmed a non-'pending_retry' value. Drop the latch so
    // a future legitimate re-flag surfaces immediately instead of
    // being masked.
    if (next !== "pending_retry" && latchedRetryAt !== null) {
      setLatchedRetryAt(null);
    }

    setLastSyncStatus((prev) => (prev === next ? prev : next));
  }, [currentUser.paymentSyncStatus, latchedRetryAt]);

  const form = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: "", email: "", phone: "", preferredLanguage: LANGUAGE_AUTO },
    values: {
      name: currentUser.name,
      email: emailChangeEditMode === "retry" && pendingEmailChange !== null && pendingEmailChange.confirmation !== "accepted"
        ? pendingEmailChange.requestedEmail
        : currentUser.email,
      phone: currentUser.phone || "",
      // null/empty in the DB = "auto / follow default", which the
      // Select represents with a non-empty sentinel. Any legacy /
      // unknown code is also coerced to AUTO so a save isn't blocked
      // on a value the new validator no longer accepts.
      preferredLanguage: normalizeStoredLanguage(currentUser.preferredLanguage),
    },
  });

  const beginEdit = (mode: "normal" | "retry") => {
    setEmailChangeEditMode(mode);
    form.reset({
      name: currentUser.name,
      email: mode === "retry" && pendingEmailChange !== null && pendingEmailChange.confirmation !== "accepted"
        ? pendingEmailChange.requestedEmail
        : currentUser.email,
      phone: currentUser.phone || "",
      preferredLanguage: normalizeStoredLanguage(currentUser.preferredLanguage),
    });
    setIsEditing(true);
  };

  const mutation = useMutation({
    mutationFn: async (data: ProfileFormData) => {
      const trimmedPhone = (data.phone ?? "").trim();
      const payload = {
        name: data.name,
        email: data.email,
        phone: trimmedPhone === "" ? null : trimmedPhone,
        // Map the Select sentinel back to null so the backend stores
        // "no preference" rather than a bogus locale code.
        preferredLanguage: languageSelectionToWire(data.preferredLanguage),
      };
      return apiRequest<{
        paymentSyncStatus?: PaymentSyncStatus;
        emailChangeRequested?: boolean;
        emailChangeDelivery?: {
          confirmation?: EmailDeliveryOutcome;
          notification?: EmailDeliveryOutcome;
        };
      }>(
        `/api/account/profile/${currentUser.id}`,
        "PATCH",
        payload,
      );
    },
    onSuccess: (response, submittedData) => {
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      const emailChanged = submittedData.email.trim().toLowerCase() !== currentUser.email.trim().toLowerCase();
      const emailChangeRequested = response?.data?.emailChangeRequested === true;
      const confirmation = parseEmailDeliveryOutcome(response?.data?.emailChangeDelivery?.confirmation);
      const notification = parseEmailDeliveryOutcome(response?.data?.emailChangeDelivery?.notification);

      if (emailChangeRequested) {
        setPendingEmailChange({
          originalEmail: currentUser.email.trim().toLowerCase(),
          requestedEmail: submittedData.email.trim().toLowerCase(),
          confirmation,
          notification,
        });
        setIsEditing(false);
        setEmailChangeEditMode("normal");
      } else if (emailChanged) {
        // Keep the form open if an email change was requested but the server
        // did not create a pending confirmation request. The user can fix or
        // retry the same address without losing their entered value.
        setIsEditing(true);
        toast({
          title: "Email change was not submitted",
          description: "Your sign-in email was not changed. Check the address and try again.",
          variant: "destructive",
        });
      } else {
        setIsEditing(false);
      }
      toast({ title: "Profile Updated", description: "Your profile has been saved successfully." });
      if (emailChangeRequested) {
        toast({
          title: "Email change pending",
          description: `${emailDeliveryCopy(confirmation, "Confirmation")} Your sign-in email remains unchanged until the new address confirms. ${emailDeliveryCopy(notification, "Security notification")}`,
          variant: confirmation === "accepted" ? "default" : "destructive",
        });
      }
      // Coerce any unknown server value to `not_applicable` via the
      // shared parser (task #374) so an old client + future server
      // adding a fifth state stays silent rather than rendering a
      // misleading retry notice. `null`/missing stays meaningful here
      // (it means "no edit has happened yet") so we keep that branch
      // out of the parser.
      const raw = response?.data?.paymentSyncStatus;
      const status: PaymentSyncStatus | null =
        raw == null ? null : parsePaymentSyncStatus(raw);
      setLastSyncStatus(status);
      if (status === "pending_retry") {
        toast({
          title: "Payment record will be retried",
          description:
            "Your payment profile is temporarily out of date and will be retried automatically. Charges or saved cards may behave oddly for the next few minutes.",
        });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Update Failed", description: error.message || "Failed to update profile", variant: "destructive" });
    },
  });

  // Self-serve "Retry now" — calls the per-user endpoint added in
  // task #323. Since #363 added server-derived `paymentSyncStatus`
  // to /api/user, we MUST invalidate that query on success so the
  // canonical pending flag (bowler.payment_sync_pending_at) propagates
  // to every consumer of /api/user across the app — including a fresh
  // page load, another tab, or any other component reading the
  // currentUser query. The local `setLastSyncStatus(status)` below
  // still gives an instant UX response; the invalidation triggers a
  // refetch that hydrates the rest of the app and re-runs the
  // mirroring useEffect above on the next render.
  const retryMutation = useMutation({
    mutationFn: async () =>
      apiRequest<{ paymentSyncStatus?: PaymentSyncStatus }>(
        "/api/account/profile/retry-payment-sync",
        "POST",
      ),
    onSuccess: (response) => {
      // Same defensive parse as the profile-edit mutation above
      // (task #374): unknown values collapse to `not_applicable` so
      // the post-retry UX stays silent on a future fifth state.
      const raw = response?.data?.paymentSyncStatus;
      const status: PaymentSyncStatus | null =
        raw == null ? null : parsePaymentSyncStatus(raw);
      setLastSyncStatus(status);
      // Latch the resolved timestamp so the hydration effect ignores
      // any stale 'pending_retry' that races back from /api/user
      // before the bowler's payment_sync_pending_at clear becomes
      // visible to a fresh read (task #438). Only latch on outcomes
      // that mean "done" — 'pending_retry' here means the retry
      // itself didn't go through, so the button SHOULD stay visible.
      if (status !== "pending_retry") {
        setLatchedRetryAt(Date.now());
      }
      queryClient.invalidateQueries({ queryKey: ["/api/user"] });
      if (status === "synced") {
        toast({ title: "Payment record updated", description: "Your payment profile is back in sync." });
      } else if (status === "pending_retry") {
        toast({
          title: "Still out of date",
          description: "The retry didn't go through. We'll keep trying in the background — please try again in a few minutes.",
          variant: "destructive",
        });
      } else {
        // 'skipped' or 'not_applicable' — nothing to retry. Treat as
        // resolved so the button doesn't linger.
        toast({ title: "Nothing to retry", description: "No pending payment-sync work for your account." });
      }
    },
    onError: (error: Error & { status?: number; retryAfterSeconds?: number | null }) => {
      // 429 → freeze the button until the limiter window elapses
      // (task #441). `apiRequest` already parsed the standard
      // `Retry-After` / `RateLimit-Reset` headers into
      // `retryAfterSeconds`; if both were absent (defensive — our
      // limiter sets `standardHeaders: true`), fall back to the
      // limiter's 60s window so the user still sees a working
      // countdown instead of an undisabled button that 429s again on
      // the next click.
      if (error.status === 429) {
        const headerSeconds = error.retryAfterSeconds;
        const seconds = typeof headerSeconds === "number" && headerSeconds >= 0
          ? headerSeconds
          : RETRY_COOLDOWN_FALLBACK_SECONDS;
        setCooldownUntilMs(Date.now() + seconds * 1000);
      }
      toast({
        title: "Retry failed",
        description: error.message || "Could not retry payment-sync right now.",
        variant: "destructive",
      });
    },
  });

  const showRetry = lastSyncStatus === "pending_retry";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile Settings</CardTitle>
        <CardDescription>Your personal information</CardDescription>
      </CardHeader>
      <CardContent>
        {!isEditing ? (
          <ProfileInfoView
            currentUser={currentUser}
            pendingEmailChange={pendingEmailChange}
            showRetry={showRetry}
            inRetryCooldown={inRetryCooldown}
            cooldownSecondsLeft={cooldownSecondsLeft}
            retryPending={retryMutation.isPending}
            onEdit={() => beginEdit("normal")}
            onRetryEmailChange={() => beginEdit("retry")}
            onRetry={() => retryMutation.mutate()}
          />
        ) : (
          <ProfileInfoForm
            form={form}
            isSaving={mutation.isPending}
            onSubmit={(data) => mutation.mutate(data)}
            onCancel={() => {
              form.reset();
              setEmailChangeEditMode("normal");
              setIsEditing(false);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
