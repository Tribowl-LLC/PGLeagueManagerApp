import { formatCountdown } from '@/hooks/use-throttle-countdown';
import { AlertTriangle, Loader2, Check, Eye, EyeOff } from 'lucide-react';

interface PasswordRequirement {
  label: string;
  met: boolean;
}

interface SetPasswordFormProps {
  password: string;
  setPassword: (value: string) => void;
  confirmPassword: string;
  setConfirmPassword: (value: string) => void;
  showPassword: boolean;
  setShowPassword: (value: boolean) => void;
  requirements: PasswordRequirement[];
  allMet: boolean;
  passwordsMatch: boolean;
  isThrottled: boolean;
  remainingSeconds: number;
  submitting: boolean;
  action: 'account_invite' | 'password_reset' | 'account_registration';
  handleSubmit: (e: React.FormEvent) => void;
}

export function SetPasswordForm({
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  showPassword,
  setShowPassword,
  requirements,
  allMet,
  passwordsMatch,
  isThrottled,
  remainingSeconds,
  submitting,
  action,
  handleSubmit,
}: SetPasswordFormProps) {
  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="password" className="block">New password</label>
        <div className="relative">
          <input
            id="password"
            aria-label="Password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            autoComplete="new-password"
            className="w-full pr-12"
          />
          <button
            type="button"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="absolute right-0 top-0 grid h-full w-12 place-items-center text-navigation-600"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <ul className="space-y-1.5 text-xs text-navigation-600" aria-label="Password requirements">
        {requirements.map((req) => (
          <li key={req.label} className={`flex items-center gap-2 ${req.met ? 'text-positive-800' : ''}`}>
            <Check className="size-3.5 shrink-0" />
            <span>{req.label}</span>
            <span className="sr-only">{req.met ? ' — met' : ' — not met'}</span>
          </li>
        ))}
      </ul>

      <div className="space-y-2">
        <label htmlFor="confirmPassword" className="block">Confirm password</label>
        <input
          id="confirmPassword"
          aria-label="Confirm Password"
          type={showPassword ? 'text' : 'password'}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Confirm your password"
          autoComplete="new-password"
          className="w-full"
        />
        {confirmPassword && !passwordsMatch && (
          <p className="text-sm text-attention-800">Passwords do not match</p>
        )}
      </div>

      {isThrottled && (
        <div className="public-flow-inset public-flow-inset-danger" role="alert" data-testid="alert-set-password-throttled">
          <strong><AlertTriangle className="mr-2 inline-block size-4 align-middle" />Too many attempts</strong>
            To protect your account, we've paused password submissions
            from this device for about{" "}
            <span data-testid="text-set-password-retry-in">
              {formatCountdown(remainingSeconds)}
            </span>
            . Please try again then; your {action === 'password_reset' ? 'reset' : 'invitation'} link may still be valid,
            so you don't need to request a new one.
        </div>
      )}

      <button
        type="submit"
        className="public-flow-primary disabled:cursor-not-allowed disabled:opacity-60"
        disabled={!allMet || !passwordsMatch || submitting || isThrottled}
        data-testid="button-set-password-submit"
      >
        {submitting ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" />
            Setting password…
          </>
        ) : isThrottled ? (
          `Try again in ${formatCountdown(remainingSeconds)}`
        ) : (
          action === 'password_reset' ? <>Reset password <span aria-hidden="true">→</span></> : action === 'account_registration' ? <>Create account <span aria-hidden="true">→</span></> : <>Set Password &amp; Sign In <span aria-hidden="true">→</span></>
        )}
      </button>
    </form>
  );
}
