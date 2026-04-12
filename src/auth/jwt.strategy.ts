import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { passportJwtSecret } from 'jwks-rsa';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { cifraPermissionsClaimKey, cifraPlanClaimKey } from './cifra-claims.constants';

export type Auth0JwtPayload = {
  sub: string;
  scope?: string;
  permissions?: string[];
  [key: string]: unknown;
};

/** Plano de faturação vindo do claim namespaced (quando a Auth0 Action o inclui no access token). */
export type BillingPlanClaim = 'free' | 'starter' | 'pro';

/** Objeto colocado em `req.user` pelo Passport após validação do JWT (Auth0 API). */
export type JwtAuthUser = {
  sub: string;
  scope?: string;
  permissions?: string[];
  billingPlan?: BillingPlanClaim;
  /** Permissões de app (`https://cifra.ai/permissions`), distintas das RBAC `permissions` da API Auth0. */
  appPermissions?: string[];
};

/** Evita issuer/JWKS errados se AUTH0_DOMAIN vier com https:// ou barra final. */
function normalizeAuth0Domain(raw: string): string {
  let d = raw.trim();
  d = d.replace(/^https?:\/\//i, '');
  d = d.replace(/\/+$/, '');
  return d;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    const domain = normalizeAuth0Domain(
      config.get<string>('AUTH0_DOMAIN') ?? '',
    );
    const audience = config.get<string>('AUTH0_AUDIENCE')?.trim();
    const issuerOverride = config.get<string>('AUTH0_ISSUER')?.trim();
    if (!domain || !audience) {
      throw new Error(
        'Defina AUTH0_DOMAIN e AUTH0_AUDIENCE no ambiente (identificador da API no Auth0).',
      );
    }
    const issuer = issuerOverride
      ? `${issuerOverride.replace(/\/+$/, '')}/`
      : `https://${domain}/`;

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      audience,
      issuer,
      algorithms: ['RS256'],
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri: `https://${domain}/.well-known/jwks.json`,
      }),
    });
  }

  validate(payload: Auth0JwtPayload): JwtAuthUser {
    if (!payload?.sub) {

      throw new UnauthorizedException();
    }

    const planRaw = payload[cifraPlanClaimKey];
    const billingPlan: BillingPlanClaim | undefined =
      planRaw === 'free' || planRaw === 'starter' || planRaw === 'pro' ? planRaw : undefined;

    const cp = payload[cifraPermissionsClaimKey];
    const appPermissions =
      Array.isArray(cp) && cp.every((x): x is string => typeof x === 'string') ? [...cp] : undefined;

    return {
      sub: payload.sub,
      scope: payload.scope,
      permissions: payload.permissions,
      billingPlan,
      appPermissions,
    };
  }
}
