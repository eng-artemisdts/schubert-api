import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IngestJobsService } from './ingest-jobs.service';
import { IngestJob, IngestJobSchema } from './schemas/ingest-job.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: IngestJob.name, schema: IngestJobSchema }]),
  ],
  providers: [IngestJobsService],
  exports: [IngestJobsService],
})
export class IngestJobsModule {}
