import './sentry.bootstrap';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { isDevAuthBypassEnabled } from './auth/dev-auth-bypass.util';
import { AppModule } from './app.module';
import { INGEST_QUEUE_NAME } from './queue/queue.constants';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  if (isDevAuthBypassEnabled(config)) {
    new Logger('Bootstrap').warn(
      'DEV_AUTH_BYPASS está ligado: rotas protegidas aceitam pedidos sem JWT válido. Use apenas em desenvolvimento local.',
    );
  }
  app.useBodyParser('json', { limit: '20mb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const webOrigin = process.env.WEB_APP_ORIGIN?.trim();
  if (webOrigin) {
    app.enableCors({
      origin: webOrigin.split(',').map((o) => o.trim()),
      allowedHeaders: ['authorization', 'content-type'],
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    });
  }

  const boardEnabled = process.env.BULLBOARD_ENABLED !== '0';
  const redisUrl = process.env.REDIS_URL?.trim();
  if (boardEnabled && redisUrl) {
    const ingestQueue = new Queue(INGEST_QUEUE_NAME, {
      connection: { url: redisUrl },
    });
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: [new BullMQAdapter(ingestQueue)],
      serverAdapter,
    });
    app.use('/admin/queues', serverAdapter.getRouter());
  }

  await app.listen(process.env.PORT ?? 3001, '0.0.0.0');
}
bootstrap();
