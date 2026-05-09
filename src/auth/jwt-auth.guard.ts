import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { isDevAuthBypassEnabled } from './dev-auth-bypass.util';
import type { BillingPlanClaim, JwtAuthUser } from './jwt.strategy';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    if (isDevAuthBypassEnabled(this.config)) {
      const req = context.switchToHttp().getRequest<{ user?: JwtAuthUser }>();
      req.user = this.buildDevBypassUser();
      return true;
    }

    return super.canActivate(context);
  }

  private buildDevBypassUser(): JwtAuthUser {
    const sub =
      this.config.get<string>('DEV_AUTH_BYPASS_SUB')?.trim() ||
      'auth0|dev-local-bypass';
    const planRaw = this.config.get<string>('DEV_AUTH_BYPASS_PLAN')?.trim().toLowerCase();
    const billingPlan: BillingPlanClaim =
      planRaw === 'free' || planRaw === 'starter' || planRaw === 'pro' ? planRaw : 'pro';
    return {
      sub,
      scope: 'openid profile email',
      permissions: [],
      billingPlan,
      appPermissions: [],
    };
  }

  override handleRequest<TUser = unknown>(
    err: Error | undefined,
    user: TUser | false,
    info: Error | string | undefined,
    context: ExecutionContext,
    status?: unknown,
  ): TUser {
    if (err || !user) {
      const fromInfo =
        info &&
        typeof info === 'object' &&
        'message' in info &&
        typeof (info as { message: unknown }).message === 'string'
          ? (info as { message: string }).message
          : typeof info === 'string'
            ? info
            : undefined;
      const detail = err?.message ?? fromInfo ?? String(status ?? '');
      if (detail) {
        this.logger.warn(`JWT rejeitado antes de validate(): ${detail}`);
      }
    }
    return super.handleRequest(err, user, info, context, status);
  }
}
