import { useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from "@/components/error-boundary";
import { useLocation, useSearch } from 'wouter';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { isAbortError, parseRetryAfterSeconds } from '@/lib/queryClient';
import {
  DEFAULT_THROTTLE_FALLBACK_SECONDS,
  formatCountdown,
  useThrottleCountdown,
} from '@/hooks/use-throttle-countdown';
import {
  LANGUAGE_AUTO,
  languageSelectionToWire,
} from '@/lib/preferred-language';
import { PageLoadingState } from "@/components/page-states";
import { AlertCircle } from 'lucide-react';
import { SetPasswordForm } from './set-password-page/set-password-form';

type PasswordAction = 'account_invite' | 'password_reset' | 'account_registration';

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'expired'; message: string }
  | { kind: 'used'; message: string }
  | { kind: 'superseded'; message: string }
  | { kind: 'revoked'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'temporary'; message: string; source: 'validation' | 'submission' }
  | { kind: 'throttled'; message: string; source: 'validation' | 'submission' };

type ApiResponse = {
  success?: unknown;
  data?: {
    email?: unknown;
    action?: unknown;
    loginFailed?: unknown;
  };
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

const TERMINAL_MESSAGES: Record<Exclude<PageState['kind'], 'loading' | 'ready' | 'temporary' | 'throttled'>, string> = {
  expired: 'This link has expired. Please request a new password reset link or ask your league administrator to resend the invitation.',
  used: 'This link has already been used. If you still need access, request a new password reset link.',
  superseded: 'This link was superseded by a newer request. Please use the latest link in your email.',
  revoked: 'This link was revoked and is no longer valid. Please request a new password reset link or ask your league administrator to resend the invitation.',
  invalid: 'This link is not valid. Please request a new password reset link or ask your league administrator to resend the invitation.',
};

function isPasswordAction(value: unknown): value is PasswordAction {
  return value === 'account_invite' || value === 'password_reset' || value === 'account_registration';
}

function getApiCode(data: ApiResponse): string | undefined {
  return typeof data.error?.code === 'string' ? data.error.code : undefined;
}

function getApiMessage(data: ApiResponse, fallback: string): string {
  return typeof data.error?.message === 'string' && data.error.message.trim()
    ? data.error.message
    : fallback;
}

async function readApiResponse(response: Response): Promise<ApiResponse> {
  try {
    const data: unknown = await response.json();
    if (data && typeof data === 'object') return data;
  } catch {
    // Some gateway errors have no JSON body. The status still determines the
    // user-facing state, so leave the body empty and continue.
  }
  return {};
}

function terminalStateForCode(
  code: string | undefined,
  message: string,
  source: 'validation' | 'submission' = 'validation',
): PageState | null {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return { kind: 'expired', message: TERMINAL_MESSAGES.expired };
    case 'TOKEN_USED':
      return { kind: 'used', message: TERMINAL_MESSAGES.used };
    case 'TOKEN_SUPERSEDED':
      return { kind: 'superseded', message: TERMINAL_MESSAGES.superseded };
    case 'TOKEN_REVOKED':
      return { kind: 'revoked', message: TERMINAL_MESSAGES.revoked };
    case 'INVALID_TOKEN':
      return { kind: 'invalid', message: TERMINAL_MESSAGES.invalid };
    default:
      return code === 'VALIDATION_ERROR' && source === 'validation'
        ? { kind: 'invalid', message }
        : null;
  }
}

function retrySecondsFromResponse(response: Response): number {
  const retryAfter = parseRetryAfterSeconds(
    response.headers.get('retry-after'),
    response.headers.get('ratelimit-reset'),
  );
  return retryAfter != null && retryAfter > 0
    ? retryAfter
    : DEFAULT_THROTTLE_FALLBACK_SECONDS;
}

export default function SetPasswordPage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { toast } = useToast();

  const [token, setToken] = useState('');
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [valid, setValid] = useState(false);
  // The validate endpoint returns only a masked email. A bearer of a valid
  // token can already finish the flow, so this confirms the destination
  // without disclosing the full address or the user's name.
  const [userEmail, setUserEmail] = useState('');
  const [action, setAction] = useState<PasswordAction>('account_invite');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Task #420: keep the user's preferred-language tri-state semantics. The
  // field is omitted until the picker is touched, and Auto becomes null only
  // after an explicit choice.
  const [preferredLanguage, setPreferredLanguage] = useState<string>(LANGUAGE_AUTO);
  const [languageTouched, setLanguageTouched] = useState(false);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const requestIdRef = useRef(0);
  const validationControllerRef = useRef<AbortController | null>(null);
  const submitControllerRef = useRef<AbortController | null>(null);
  const { isThrottled, remainingSeconds, throttle, clear: clearThrottle } = useThrottleCountdown();

  const handleLanguageChange = (value: string) => {
    setPreferredLanguage(value);
    setLanguageTouched(true);
  };

  const requirements = [
    { label: 'At least 8 characters', met: password.length >= 8 },
    { label: 'One uppercase letter', met: /[A-Z]/.test(password) },
    { label: 'One lowercase letter', met: /[a-z]/.test(password) },
    { label: 'One number', met: /[0-9]/.test(password) },
    { label: 'One special character (!@#$%^&*)', met: /[!@#$%^&*]/.test(password) },
  ];

  const allMet = requirements.every(r => r.met);
  const passwordsMatch = password === confirmPassword && confirmPassword.length > 0;

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    validationControllerRef.current?.abort();
    submitControllerRef.current?.abort();

    const params = new URLSearchParams(search);
    const nextToken = params.get('token') ?? '';
    const controller = new AbortController();
    validationControllerRef.current = controller;

    // A URL change starts a completely new flow. Clear form data as well as
    // server-derived data so a prior token cannot be submitted accidentally.
    setToken(nextToken);
    setState(nextToken ? { kind: 'loading' } : { kind: 'invalid', message: TERMINAL_MESSAGES.invalid });
    setValid(false);
    setUserEmail('');
    setAction('account_invite');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setPreferredLanguage(LANGUAGE_AUTO);
    setLanguageTouched(false);
    setSubmitting(false);
    clearThrottle();

    if (!nextToken) {
      return () => controller.abort();
    }

    const query = new URLSearchParams({ token: nextToken }).toString();
    void (async () => {
      try {
        const response = await fetch(`/api/auth/validate-invite?${query}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (requestId !== requestIdRef.current) return;

        if (response.status === 429) {
          throttle(retrySecondsFromResponse(response));
          setState({
            kind: 'throttled',
            source: 'validation',
            message: 'Validation is temporarily rate-limited. Your link may still be valid; try again after the cooldown.',
          });
          return;
        }

        const data = await readApiResponse(response);
        if (requestId !== requestIdRef.current) return;

        if (response.ok && data.success === true) {
          setToken(nextToken);
          setUserEmail(typeof data.data?.email === 'string' ? data.data.email : 'your account');
          // Older servers omitted action and represented invitation links only.
          setAction(isPasswordAction(data.data?.action) ? data.data.action : 'account_invite');
          setValid(true);
          setState({ kind: 'ready' });
          return;
        }

        const code = getApiCode(data);
        const message = getApiMessage(data, 'We could not validate this link.');
        const terminalState = terminalStateForCode(code, message);
        if (terminalState) {
          setValid(false);
          setState(terminalState);
          return;
        }
        if (response.status >= 500) {
          setState({
            kind: 'temporary',
            source: 'validation',
            message: 'The link validation service is temporarily unavailable. Please try again.',
          });
          return;
        }
        setValid(false);
        setState({ kind: 'invalid', message });
      } catch (error) {
        if (requestId !== requestIdRef.current || isAbortError(error)) {
          return;
        }
        setState({
          kind: 'temporary',
          source: 'validation',
          message: 'We could not reach the link validation service. Check your connection and try again.',
        });
      }
    })();

    return () => {
      // Invalidate this effect generation even when cleanup happens because
      // the component is unmounting (there is no next effect to increment it).
      // This prevents a transport that ignores AbortSignal from navigating or
      // publishing a toast after the user has left the page.
      requestIdRef.current += 1;
      controller.abort();
      submitControllerRef.current?.abort();
      if (validationControllerRef.current === controller) validationControllerRef.current = null;
    };
  }, [search, validationAttempt, clearThrottle, throttle]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !allMet || !passwordsMatch || isThrottled || submitting) return;

    const requestId = requestIdRef.current;
    const controller = new AbortController();
    submitControllerRef.current?.abort();
    submitControllerRef.current = controller;
    setSubmitting(true);
    setState({ kind: 'ready' });

    try {
      const body: { token: string; password: string; preferredLanguage?: string | null } = {
        token,
        password,
      };
      if (languageTouched) {
        body.preferredLanguage = languageSelectionToWire(preferredLanguage);
      }

      const response = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (requestId !== requestIdRef.current) return;

      if (response.status === 429) {
        throttle(retrySecondsFromResponse(response));
        setState({
          kind: 'throttled',
          source: 'submission',
          message: 'Password submissions are temporarily rate-limited. Your link may still be valid; try again after the cooldown.',
        });
        return;
      }

      const data = await readApiResponse(response);
      if (requestId !== requestIdRef.current) return;

      if (response.ok && data.success === true) {
        const registrationLoginFailed = action === 'account_registration'
          && data.data?.loginFailed === true;
        toast({
          title: action === 'password_reset' ? 'Password reset successfully' : 'Password set successfully',
          description: action === 'password_reset'
            ? 'You can now log in with your new password.'
            : action === 'account_registration'
              ? registrationLoginFailed
                ? 'Your account is ready. Please log in.'
                : 'Your account is ready. You are now signed in.'
              : 'You can now use your new password to sign in.',
        });
        if (action === 'password_reset' || registrationLoginFailed) {
          // Reset tokens do not create a session. Send the user through the
          // normal login flow after the server rotates the password. A
          // registration action can take the same path when session creation
          // fails after its atomic password/link transaction committed.
          setLocation('/login');
        } else {
          // Preserve the invitation flow's existing post-success landing.
          window.location.href = '/';
        }
        return;
      }

      const code = getApiCode(data);
      const message = getApiMessage(data, 'Failed to set your password. Please try again.');
      const terminalState = terminalStateForCode(code, message, 'submission');
      if (terminalState) {
        setValid(false);
        setState(terminalState);
      } else if (response.status >= 500) {
        setState({
          kind: 'temporary',
          source: 'submission',
          message: 'The password service is temporarily unavailable. Please try again.',
        });
      } else {
        setState({ kind: 'ready' });
        toast({ title: 'Could not set password', description: message, variant: 'destructive' });
      }
    } catch (error) {
      if (requestId !== requestIdRef.current || isAbortError(error)) {
        return;
      }
      setState({
        kind: 'temporary',
        source: 'submission',
        message: 'We could not reach the password service. Check your connection and try again.',
      });
    } finally {
      if (requestId === requestIdRef.current) {
        setSubmitting(false);
        if (submitControllerRef.current === controller) submitControllerRef.current = null;
      }
    }
  };

  const retryValidation = () => {
    if (isThrottled) return;
    clearThrottle();
    setValidationAttempt((attempt) => attempt + 1);
  };

  const retryButton = (
    <Button
      onClick={retryValidation}
      disabled={isThrottled}
      data-testid="button-set-password-validation-retry"
    >
      {isThrottled ? `Try again in ${formatCountdown(remainingSeconds)}` : 'Try again'}
    </Button>
  );

  if (state.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" data-testid="state-set-password-loading">
        <PageLoadingState message="Validating your password link…" />
      </div>
    );
  }

  if (!valid) {
    const isTemporary = state.kind === 'temporary';
    const isThrottledValidation = state.kind === 'throttled';
    const isTerminal = !isTemporary && !isThrottledValidation && state.kind !== 'ready';
    const stateMessage = state.kind === 'ready' ? '' : state.message;
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4" data-testid={`state-set-password-${state.kind}`}>
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">
              {isTemporary ? 'Temporarily unavailable' : isThrottledValidation ? 'Too many attempts' : isTerminal ? (state.kind === 'used' ? 'Link already used' : 'This link is no longer available') : 'Password link'}
            </CardTitle>
            <CardDescription>{stateMessage}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-3">
            {(isTemporary || isThrottledValidation) && retryButton}
            {!isTemporary && !isThrottledValidation && (
              <Button onClick={() => setLocation('/login')}>Go to Login</Button>
            )}
            <a href="/forgot-password" className="text-sm text-primary hover:underline">
              Request a new password reset link
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

  const temporarySubmission = state.kind === 'temporary' && state.source === 'submission';
  const formStateKind = state.kind === 'temporary' || state.kind === 'throttled'
    ? state.kind
    : 'ready';

  return (
    <ErrorBoundary level="section">
      <div className="min-h-screen flex items-center justify-center bg-background p-4" data-testid={`state-set-password-${formStateKind}`}>
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">
              {action === 'password_reset'
                ? 'Reset Your Password'
                : action === 'account_registration'
                  ? 'Finish Your Registration'
                  : 'Set Your Password'}
            </CardTitle>
            <CardDescription>
              {action === 'password_reset'
                ? <>Choose a new password for your LeagueVault account ({userEmail}).</>
                : action === 'account_registration'
                  ? <>Create a password to finish setting up your LeagueVault account ({userEmail}).</>
                : <>Create a password to finish setting up your LeagueVault account ({userEmail}).</>}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {temporarySubmission && (
              <Alert variant="destructive" className="mb-4" data-testid="alert-set-password-temporary">
                <AlertCircle className="size-4" />
                <AlertTitle>Unable to save your password</AlertTitle>
                <AlertDescription>{state.message} You can try submitting again.</AlertDescription>
              </Alert>
            )}
            <SetPasswordForm
              password={password}
              setPassword={setPassword}
              confirmPassword={confirmPassword}
              setConfirmPassword={setConfirmPassword}
              showPassword={showPassword}
              setShowPassword={setShowPassword}
              preferredLanguage={preferredLanguage}
              handleLanguageChange={handleLanguageChange}
              requirements={requirements}
              allMet={allMet}
              passwordsMatch={passwordsMatch}
              isThrottled={isThrottled}
              remainingSeconds={remainingSeconds}
              submitting={submitting}
              action={action}
              handleSubmit={handleSubmit}
            />
          </CardContent>
        </Card>
      </div>
    </ErrorBoundary>
  );
}
