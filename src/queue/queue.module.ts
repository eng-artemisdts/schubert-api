import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { INGEST_QUEUE_NAME } from './queue.constants';
import { QueueProducerService } from './queue.producer.service';

@Module({
  providers: [
    {
      provide: INGEST_QUEUE_NAME,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL')?.trim();
        if (!redisUrl) return null;
        return new Queue(INGEST_QUEUE_NAME, {
          connection: { url: redisUrl },
        });
      },
    },
    QueueProducerService,
  ],
  exports: [QueueProducerService, INGEST_QUEUE_NAME],
})
export class QueueModule {}
