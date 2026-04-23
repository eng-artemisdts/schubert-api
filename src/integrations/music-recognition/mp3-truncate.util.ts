/**
 * Corta um buffer MP3 por limites de frame MPEG (áudio válido até ~maxSeconds).
 * Evita enviar o ficheiro inteiro à AudD (doc: ~25 s máx.).
 */

/** Tabelas de bitrate (kbps), índice 0 e 15 = inválido. */
const MPEG1_L3_BITRATE = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_L3_BITRATE = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

const MPEG1_SR = [44100, 48000, 32000];
const MPEG2_SR = [22050, 24000, 16000];
const MPEG25_SR = [11025, 12000, 8000];

function skipId3v2Prefix(buf: Buffer): number {
  if (
    buf.length >= 10 &&
    buf[0] === 0x49 &&
    buf[1] === 0x44 &&
    buf[2] === 0x33
  ) {
    const size =
      ((buf[6] & 0x7f) << 21) |
      ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) |
      (buf[9] & 0x7f);
    return 10 + size;
  }
  return 0;
}

type Version = 'mpeg1' | 'mpeg2' | 'mpeg25';

function parseAudioVersion(b2: number): Version | null {
  const v = (b2 >> 3) & 0x03;
  if (v === 0) return 'mpeg25';
  if (v === 2) return 'mpeg2';
  if (v === 3) return 'mpeg1';
  return null;
}

/** Layer III corresponde a bits 01 => valor 1 nos 2 bits de layer. */
function isLayer3(b2: number): boolean {
  return ((b2 >> 1) & 0x03) === 1;
}

/**
 * Devolve comprimento do frame em bytes e duração em segundos.
 * `null` se o cabeçalho não for reconhecível.
 */
function parseMpegLayer3Frame(
  buf: Buffer,
  offset: number,
): { frameLength: number; durationSec: number } | null {
  if (offset + 4 > buf.length) return null;

  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) {
    return null;
  }

  const b2 = buf[offset + 1];
  const b3 = buf[offset + 2];
  const b4 = buf[offset + 3];

  const ver = parseAudioVersion(b2);
  if (!ver || !isLayer3(b2)) return null;

  const bitrateIdx = (b3 >> 4) & 0x0f;
  const sampleIdx = (b3 >> 2) & 0x03;
  const padding = (b3 >> 1) & 0x01;

  if (bitrateIdx === 0 || bitrateIdx === 0x0f || sampleIdx === 0x03) {
    return null;
  }

  let bitrateKbps: number;
  if (ver === 'mpeg1') {
    bitrateKbps = MPEG1_L3_BITRATE[bitrateIdx];
  } else {
    bitrateKbps = MPEG2_L3_BITRATE[bitrateIdx];
  }
  if (!bitrateKbps) return null;

  let sampleRate: number;
  if (ver === 'mpeg1') {
    sampleRate = MPEG1_SR[sampleIdx];
  } else if (ver === 'mpeg2') {
    sampleRate = MPEG2_SR[sampleIdx];
  } else {
    sampleRate = MPEG25_SR[sampleIdx];
  }
  if (!sampleRate) return null;

  const coef = ver === 'mpeg1' ? 144 : 72;
  const bitrateBps = bitrateKbps * 1000;
  const frameLength = Math.floor((coef * bitrateBps) / sampleRate) + padding;

  if (frameLength < 24 || offset + frameLength > buf.length) {
    return null;
  }

  const samplesPerFrame = ver === 'mpeg1' ? 1152 : 576;
  const durationSec = samplesPerFrame / sampleRate;

  return { frameLength, durationSec };
}

/**
 * Reduz o buffer ao prefixo MP3 que representa até `maxSeconds` de áudio.
 * Se o parsing de frames falhar em bloco (ex.: formato não MVP3), devolve o buffer original.
 */
export function truncateMp3BufferToMaxDurationSeconds(
  buffer: Buffer,
  maxSeconds: number,
): Buffer {
  if (buffer.length === 0 || maxSeconds <= 0) return buffer;

  let offset = skipId3v2Prefix(buffer);
  if (offset >= buffer.length) return buffer;

  let accumulated = 0;
  let endExclusive = offset;
  let frames = 0;
  const maxScan = buffer.length;

  while (offset < maxScan && accumulated < maxSeconds) {
    const frame = parseMpegLayer3Frame(buffer, offset);
    if (!frame) {
      offset += 1;
      continue;
    }

    if (accumulated + frame.durationSec > maxSeconds) {
      break;
    }

    accumulated += frame.durationSec;
    offset += frame.frameLength;
    endExclusive = offset;
    frames += 1;
  }

  if (frames === 0) {
    return buffer;
  }

  return buffer.subarray(0, endExclusive);
}
