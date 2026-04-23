import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import MusicAi from '@music.ai/sdk';

import type { ChordSectionAnalysisResult } from '../domain/chord-section-analysis.port';
import { IChordSectionProvider } from '../domain/chord-section-analysis.port';
import {
  tryLoadMusicAiExportFromDir,
  tryLoadMusicAiSdkOutputDir,
} from '../mappers/musicai-export-json.mapper';
import {
  buildPlaceholderChord,
  buildPlaceholderSections,
} from '../mappers/placeholder-chords.mapper';

const DEFAULT_DURATION = 120;

/**
 * Slug em `MUSIC_AI_WORKFLOW` → `POST /job` (ver [API Reference](https://music.ai/docs/api/reference)).
 * O campo `result` do job são **as chaves de output** desse workflow (URLs ou strings); o SDK só repassa
 * ([@music.ai/sdk](https://www.npmjs.com/package/@music.ai/sdk), `downloadJobResults` descarrega só valores `https://…`).
 * Vários outputs exigem que o workflow publicado no dashboard exponha várias portas no nó Output — não é algo que o cliente force por código.
 */
const DEFAULT_MUSIC_AI_CHORD_WORKFLOW = 'music-ai/generate-chords';

function parseJobExtraParamsJson(
  raw: string | undefined,
  logger: Logger,
  label: string,
): Record<string, unknown> | null {
  const t = raw?.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      logger.warn(`${label}: esperado um objeto JSON (ignorado).`);
      return null;
    }
    return o as Record<string, unknown>;
  } catch {
    logger.warn(`${label}: JSON inválido (ignorado).`);
    return null;
  }
}

@Injectable()
export class MusicAiChordSectionProvider implements IChordSectionProvider {
  private readonly logger = new Logger(MusicAiChordSectionProvider.name);

  constructor(private readonly config: ConfigService) {}

  /** `params` do job principal: `inputUrl` + opcional `MUSIC_AI_JOB_EXTRA_PARAMS` (merge; `inputUrl` prevalece). */
  private buildJobParams(inputUrl: string): Record<string, unknown> {
    const extra = parseJobExtraParamsJson(
      this.config.get<string>('MUSIC_AI_JOB_EXTRA_PARAMS'),
      this.logger,
      'MUSIC_AI_JOB_EXTRA_PARAMS',
    );
    return { ...(extra ?? {}), inputUrl };
  }

  /** `params` do job de secções: `inputUrl` + opcional `MUSIC_AI_SECTIONS_JOB_EXTRA_PARAMS`. */
  private buildSectionsJobParams(inputUrl: string): Record<string, unknown> {
    const extra = parseJobExtraParamsJson(
      this.config.get<string>('MUSIC_AI_SECTIONS_JOB_EXTRA_PARAMS'),
      this.logger,
      'MUSIC_AI_SECTIONS_JOB_EXTRA_PARAMS',
    );
    return { ...(extra ?? {}), inputUrl };
  }

  /** `MUSIC_AI_LOG_WORKFLOWS=1` → lista `GET /workflow` e verifica se o slug configurado existe. */
  private async maybeLogWorkflowCatalog(
    client: InstanceType<typeof MusicAi>,
    configuredSlug: string,
  ): Promise<void> {
    const flag = this.config
      .get<string>('MUSIC_AI_LOG_WORKFLOWS')
      ?.trim()
      .toLowerCase();
    if (flag !== '1' && flag !== 'true') return;
    try {
      const { workflows } = await client.listWorkflows({ page: 0, size: 100 });
      const ours = workflows.find((w) => w.slug === configuredSlug);
      if (ours) {
        this.logger.log(
          `Music.AI GET /workflow: slug «${configuredSlug}» encontrado (name=${JSON.stringify(ours.name)}).`,
        );
      } else {
        this.logger.warn(
          `Music.AI GET /workflow: slug «${configuredSlug}» não está na primeira página (até 100). ` +
            `Exemplos de slugs: ${workflows
              .map((w) => w.slug)
              .slice(0, 15)
              .join(', ')}${workflows.length > 15 ? '…' : ''}`,
        );
      }
    } catch (e) {
      this.logger.warn(`Music.AI listWorkflows: ${(e as Error).message}`);
    }
  }

  async analyze(audioPath: string): Promise<ChordSectionAnalysisResult> {
    const exportDir = this.config.get<string>('MUSICAI_EXPORT_DIR')?.trim();
    if (exportDir) {
      const loaded = tryLoadMusicAiExportFromDir(exportDir);
      if (loaded?.chords?.length || loaded?.sections?.length) {
        this.logger.log(`Music.AI: modo dev — export local (${exportDir}).`);
        return {
          chords: loaded.chords ?? [],
          sections: loaded.sections ?? [],
          original_tune: loaded.original_tune ?? '',
        };
      }
      this.logger.warn(
        `MUSICAI_EXPORT_DIR sem exportação válida: ${exportDir}`,
      );
    }

    const apiKey = this.config.get<string>('MUSIC_AI_API_KEY')?.trim();
    if (!apiKey) {
      this.logger.warn(
        'MUSIC_AI_API_KEY ausente — placeholders. Chave: https://music.ai/dash/org/_/settings ou MUSICAI_EXPORT_DIR.',
      );
      return this.placeholder();
    }

    const workflow =
      this.config.get<string>('MUSIC_AI_WORKFLOW')?.trim() ||
      DEFAULT_MUSIC_AI_CHORD_WORKFLOW;
    const apiEndpoint = this.config
      .get<string>('MUSIC_AI_API_ENDPOINT')
      ?.trim();
    const pollMsRaw = this.config.get<string>('MUSIC_AI_JOB_POLL_MS')?.trim();
    const pollMs = pollMsRaw ? parseInt(pollMsRaw, 10) : NaN;

    const client = new MusicAi({
      apiKey,
      ...(apiEndpoint ? { apiEndpoint } : {}),
      ...(Number.isFinite(pollMs) && pollMs >= 500
        ? { jobMonitorInterval: pollMs }
        : {}),
    });

    const outDir = await mkdtemp(join(tmpdir(), 'musicai-chords-'));
    const jobIdsToDelete: string[] = [];

    try {
      await this.maybeLogWorkflowCatalog(client, workflow);
      const inputUrl = await client.uploadFile(audioPath);
      const params = this.buildJobParams(inputUrl);
      const primaryJobId = await client.addJob({
        name: `schubert-ingest-${Date.now()}`,
        workflow,
        params,
      });
      jobIdsToDelete.push(primaryJobId);
      const job = await client.waitForJobCompletion(primaryJobId);
      if (job.status === 'FAILED') {
        const msg = job.error?.message ?? job.error?.title ?? 'job failed';
        throw new ServiceUnavailableException(`Music.AI: ${msg}`);
      }

      await client.downloadJobResults(job, outDir);

      const sectionsWorkflow = this.config
        .get<string>('MUSIC_AI_SECTIONS_WORKFLOW')
        ?.trim();

      let parsed = tryLoadMusicAiSdkOutputDir(outDir);

      if (sectionsWorkflow) {
        await this.maybeLogWorkflowCatalog(client, sectionsWorkflow);
        const sectionsDir = join(outDir, 'sections-workflow-output');
        await mkdir(sectionsDir, { recursive: true });
        const sectionsJobId = await client.addJob({
          name: `schubert-ingest-sections-${Date.now()}`,
          workflow: sectionsWorkflow,
          params: this.buildSectionsJobParams(inputUrl),
        });
        jobIdsToDelete.push(sectionsJobId);
        try {
          const jobSections = await client.waitForJobCompletion(sectionsJobId);
          if (jobSections.status !== 'FAILED') {
            await client.downloadJobResults(jobSections, sectionsDir);
            const parsedSections = tryLoadMusicAiSdkOutputDir(sectionsDir);
            if (parsedSections?.sections?.length) {
              const base = parsed ?? {
                chords: [],
                sections: [],
                original_tune: '',
              };
              const baseTune = (base.original_tune ?? '').trim();
              const secTune = (parsedSections.original_tune ?? '').trim();
              parsed = {
                ...base,
                sections: parsedSections.sections,
                original_tune: baseTune || secTune,
              };
            }
          }
        } catch {
          /* secções opcionais — falha silenciosa */
        }
      }

      if (parsed?.chords?.length || parsed?.sections?.length) {
        return {
          chords: parsed.chords ?? [],
          sections: parsed.sections ?? [],
          original_tune: parsed.original_tune ?? '',
        };
      }

      return this.placeholder();
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Music.AI SDK: ${msg}`);
      throw new ServiceUnavailableException(`Music.AI: ${msg}`);
    } finally {
      // Não bloquear a resposta HTTP: FS ou rede podem atrasar.
      void rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      const keepJobs = ['1', 'true', 'yes'].includes(
        this.config.get<string>('MUSIC_AI_KEEP_JOBS')?.trim().toLowerCase() ??
          '',
      );
      if (!keepJobs) {
        for (const id of jobIdsToDelete) {
          void client.deleteJob(id).catch(() => undefined);
        }
      }
    }
  }

  private placeholder(): ChordSectionAnalysisResult {
    const end = DEFAULT_DURATION;
    return {
      chords: [buildPlaceholderChord(0, end)],
      sections: buildPlaceholderSections(0, end),
      original_tune: '',
    };
  }
}
