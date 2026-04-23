/** Alinhado a `CIFRA_CLAIMS_NS` em cifra.ai-web (`lib/billing/claims-namespace.ts`). */
export const CIFRA_CLAIMS_NS = 'https://cifra.ai/' as const;

export const cifraPlanClaimKey = `${CIFRA_CLAIMS_NS}plan` as const;
export const cifraPermissionsClaimKey =
  `${CIFRA_CLAIMS_NS}permissions` as const;
