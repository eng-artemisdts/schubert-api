import type { Request } from 'express';

import type { JwtAuthUser } from './jwt.strategy';

const HDR_PLAN = 'x-cifra-billing-plan';
const HDR_SUB = 'x-cifra-auth0-sub';
const HDR_APP_PERMS = 'x-cifra-app-permissions';

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim())
    return v[0].trim();
  return undefined;
}

export type IngestBillingPlan = 'free' | 'starter' | 'pro';

export type IngestCallerLogPayload = {
  auth0Sub: string;
  billingPlan: string;
  auth0ApiPermissions: string[];
  appPermissions: string[];
  scope: string | null;
  /** `jwt` se plano veio do access token; `bff` se veio só dos cabeçalhos do proxy. */
  billingPlanSource: 'jwt' | 'bff' | 'none';
};

/**
 * Junta JWT (Auth0 API) com cabeçalhos opcionais enviados pelo BFF Next.js.
 * Cabeçalhos de plano/permissões de app só são usados se `x-cifra-auth0-sub` coincidir com `sub` do JWT.
 */
export function buildIngestCallerLogPayload(
  req: Request,
  user: JwtAuthUser | undefined,
): IngestCallerLogPayload {
  const auth0Sub =
    user?.sub ?? header(req, HDR_SUB) ?? '(sem utilizador no request)';
  const jwtPlan = user?.billingPlan?.trim();
  const headerSub = header(req, HDR_SUB);
  const bffHeadersMatchJwt = Boolean(
    user?.sub && headerSub && headerSub === user.sub,
  );

  let billingPlan = jwtPlan ?? '(não indicado)';
  let billingPlanSource: IngestCallerLogPayload['billingPlanSource'] = jwtPlan
    ? 'jwt'
    : 'none';

  if (!jwtPlan && bffHeadersMatchJwt) {
    const fromHeader = header(req, HDR_PLAN);
    if (fromHeader) {
      billingPlan = fromHeader;
      billingPlanSource = 'bff';
    }
  }

  let appPermissions = user?.appPermissions?.length
    ? [...user.appPermissions]
    : [];
  if (!appPermissions.length && bffHeadersMatchJwt) {
    const raw = header(req, HDR_APP_PERMS);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (
          Array.isArray(parsed) &&
          parsed.every((x) => typeof x === 'string')
        ) {
          appPermissions = [...parsed];
        }
      } catch {
        /* ignore */
      }
    }
  }

  return {
    auth0Sub,
    billingPlan,
    auth0ApiPermissions: user?.permissions ?? [],
    appPermissions,
    scope: user?.scope ?? null,
    billingPlanSource,
  };
}

/** Plano normalizado para estratégia de transcrição (ingest). */
export function resolveIngestBillingPlan(
  p: IngestCallerLogPayload,
): IngestBillingPlan {
  const v = p.billingPlan.trim().toLowerCase();
  if (v === 'starter' || v === 'pro') return v;
  return 'free';
}
