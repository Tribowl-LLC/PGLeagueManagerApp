import { validateAppEnvAgreement } from '@shared/app-env';

export interface RateLimitEnvironment {
  APP_ENV?: string;
  NODE_ENV?: string;
}

export function usesSharedRateLimitStore(environment: RateLimitEnvironment): boolean {
  return environment.NODE_ENV === 'production';
}

export function assertProductionRateLimitStore(
  environment: RateLimitEnvironment,
): void {
  const agreement = validateAppEnvAgreement({
    appEnv: environment.APP_ENV,
    nodeEnv: environment.NODE_ENV,
  });
  if (!agreement.ok) {
    throw new Error(
      'Refusing to start: production APP_ENV requires NODE_ENV=production and ' +
        'production NODE_ENV requires APP_ENV=prod so rate limits use the shared PostgreSQL store. ' +
        agreement.reason,
    );
  }
}
