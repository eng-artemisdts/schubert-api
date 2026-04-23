/**
 * Limite Multer (`fileSize`) por upload MP3 — alinhado ao BFF em `cifra.ai-web`.
 * O envio à AudD (`/tracks/identify`) usa apenas ~25 s após truncagem no serviço.
 */
export const MAX_MP3_UPLOAD_BYTES = 50 * 1024 * 1024;
