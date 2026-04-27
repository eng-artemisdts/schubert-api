import './sentry.bootstrap';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
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

  await app.listen(process.env.PORT ?? 3001, '0.0.0.0');
}
bootstrap();
