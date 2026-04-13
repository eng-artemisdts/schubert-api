import { Inject, Injectable } from '@nestjs/common';

import type { IngestBillingPlan } from '../../auth/caller-context.util';
import type { ILyricsTranscriptionProvider } from '../domain/lyrics-transcription.port';
import {
  AUDIOSHAKE_TRANSCRIPTION_PROVIDER,
  WHISPER_TRANSCRIPTION_PROVIDER,
} from '../ingest.tokens';

@Injectable()
export class LyricsTranscriptionStrategyFactory {
  constructor(
    @Inject(WHISPER_TRANSCRIPTION_PROVIDER)
    private readonly whisper: ILyricsTranscriptionProvider,
    @Inject(AUDIOSHAKE_TRANSCRIPTION_PROVIDER)
    private readonly audioshake: ILyricsTranscriptionProvider,
  ) {}

  /** `free` → Whisper; `starter` / `pro` → AudioShake. */
  select(plan: IngestBillingPlan): ILyricsTranscriptionProvider {
    return plan === 'free' ? this.whisper : this.audioshake;
  }
}
