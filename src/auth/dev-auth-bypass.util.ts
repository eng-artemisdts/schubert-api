import type { ConfigService } from '@nestjs/config';

export function isTruthyEnv(raw: string | undefined): boolean {
  if (raw == null) return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

/** JWT pode ser ignorado só em `development` com `DEV_AUTH_BYPASS` activo. */
export function isDevAuthBypassEnabled(config: ConfigService): boolean {
  if (config.get<string>('NODE_ENV') !== 'development') return false;
  return isTruthyEnv(config.get<string>('DEV_AUTH_BYPASS'));
}
