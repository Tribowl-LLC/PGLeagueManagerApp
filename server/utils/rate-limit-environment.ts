import { resolveAppEnv } from '@shared/app-env';

export interface RateLimitEnvironment {
  APP_ENV?: string;
  NODE_ENV?: string;
  REPLIT_DEPLOYMENT?: string;
}

export function usesSharedRateLimitStore(environment: RateLimitEnvironment): boolean {
  return environment.NODE_ENV === 'production';
}

export function assertProductionRateLimitStore(
  environment: RateLimitEnvironment,
): void {
  const appEnv = resolveAppEnv({
    appEnv: environment.APP_ENV,
    replitDeployment: environment.REPLIT_DEPLOYMENT,
  });

  if (appEnv === 'prod' && !usesSharedRateLimitStore(environment)) {
    throw new Error(
      'Refusing to start: production APP_ENV requires NODE_ENV=production so rate limits use the shared PostgreSQL store.',
    );
  }
}
