import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  formatCountdown,
} from '@/hooks/use-throttle-countdown';
import {
  LANGUAGE_AUTO,
  LANGUAGE_OPTIONS,
} from '@/lib/preferred-language';
import { AlertTriangle, Loader2, Check, X, Eye, EyeOff } from 'lucide-react';

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
  preferredLanguage: string;
  handleLanguageChange: (value: string) => void;
  requirements: PasswordRequirement[];
  allMet: boolean;
  passwordsMatch: boolean;
  isThrottled: boolean;
  remainingSeconds: number;
  submitting: boolean;
  action: 'account_invite' | 'password_reset';
  handleSubmit: (e: React.FormEvent) => void;
}

export function SetPasswordForm({
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  showPassword,
  setShowPassword,
  preferredLanguage,
  handleLanguageChange,
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
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-full px-3"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm Password</Label>
        <Input
          id="confirmPassword"
          type={showPassword ? 'text' : 'password'}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Confirm your password"
        />
        {confirmPassword && !passwordsMatch && (
          <p className="text-sm text-destructive">Passwords do not match</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="preferredLanguage">Preferred language</Label>
        <Select
          value={preferredLanguage}
          onValueChange={handleLanguageChange}
        >
          <SelectTrigger
            id="preferredLanguage"
            data-testid="select-set-password-language"
          >
            <SelectValue placeholder="Auto (follow my browser)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              value={LANGUAGE_AUTO}
              data-testid="option-set-password-language-auto"
            >
              Auto (follow my browser)
            </SelectItem>
            {LANGUAGE_OPTIONS.map((opt) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                data-testid={`option-set-password-language-${opt.value}`}
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Used for security and onboarding emails. You can change this
          later in your account settings.
        </p>
      </div>

      {password.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-muted-foreground">Password requirements:</p>
          {requirements.map((req) => (
            <div key={req.label} className="flex items-center gap-2 text-sm">
              {req.met ? (
                <Check className="size-3.5 text-green-600" />
              ) : (
                <X className="size-3.5 text-muted-foreground" />
              )}
              <span className={req.met ? 'text-green-600' : 'text-muted-foreground'}>{req.label}</span>
            </div>
          ))}
        </div>
      )}

      {isThrottled && (
        <Alert variant="destructive" data-testid="alert-set-password-throttled">
          <AlertTriangle className="size-4" />
          <AlertTitle>Too many attempts</AlertTitle>
          <AlertDescription>
            To protect your account, we've paused password submissions
            from this device for about{" "}
            <span data-testid="text-set-password-retry-in">
              {formatCountdown(remainingSeconds)}
            </span>
            . Please try again then; your {action === 'password_reset' ? 'reset' : 'invitation'} link may still be valid,
            so you don't need to request a new one.
          </AlertDescription>
        </Alert>
      )}

      <Button
        type="submit"
        className="w-full"
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
          action === 'password_reset' ? 'Reset Password' : 'Set Password & Sign In'
        )}
      </Button>
    </form>
  );
}
