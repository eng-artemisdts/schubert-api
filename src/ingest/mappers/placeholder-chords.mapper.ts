import type {
  TranscriptionChordEventSubdoc,
  TranscriptionSectionSubdoc,
} from '../../tracks/schemas/track.schema';

const NC = 'N.C.';

/** Acorde «sem acorde» válido para o schema, útil quando o provider externo ainda não está configurado. */
export function buildPlaceholderChord(
  start: number,
  end: number,
): TranscriptionChordEventSubdoc {
  return {
    start,
    end,
    start_bar: 1,
    start_beat: 1,
    end_bar: 1,
    end_beat: 4,
    chord_majmin: NC,
    bass: null,
    bass_nashville: null,
    chord_complex_jazz: NC,
    chord_simple_jazz: NC,
    chord_basic_jazz: NC,
    chord_complex_pop: NC,
    chord_simple_pop: NC,
    chord_basic_pop: NC,
    chord_complex_nashville: NC,
    chord_simple_nashville: NC,
    chord_basic_nashville: NC,
  };
}

export function buildPlaceholderSections(
  start: number,
  end: number,
): TranscriptionSectionSubdoc[] {
  return [{ start, end, label: 'full' }];
}
