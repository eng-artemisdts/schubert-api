import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly reflector: Reflector) {
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
    return super.canActivate(context);
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
    return super.handleRequest(err, user, info, context, status) as TUser;
  }
}
