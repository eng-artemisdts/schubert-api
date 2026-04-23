import { Inject, Injectable } from '@nestjs/common';

import type { IngestBillingPlan } from '../../auth/caller-context.util';
import type { ILyricsTranscriptionProvider } from '../domain/lyrics-transcription.port';
import { AUDIOSHAKE_TRANSCRIPTION_PROVIDER } from '../ingest.tokens';

@Injectable()
export class LyricsTranscriptionStrategyFactory {
  constructor(
    @Inject(AUDIOSHAKE_TRANSCRIPTION_PROVIDER)
    private readonly audioshake: ILyricsTranscriptionProvider,
  ) {}

  /** Estratégia única: transcrição sempre via AudioShake. */
  select(plan: IngestBillingPlan): ILyricsTranscriptionProvider {
    void plan;
    return this.audioshake;
  }
}
