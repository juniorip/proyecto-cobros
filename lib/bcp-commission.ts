// Turnos ATK applies 0.5% to BCP profiles 0.35% and 0.5%, and 1% to profile 1%.
export const BCP_EFFECT_RATES = [50, 100] as const;
export const BCP_EFFECT_MIN_CENTS = 1200;

export function isValidBcpEffectRate(rate: number) {
  return (BCP_EFFECT_RATES as readonly number[]).includes(rate);
}

export function calculateCommissionCents({
  cents,
  rate,
  company,
  operationType,
}: {
  cents: number;
  rate: number;
  company?: string | null;
  operationType?: string | null;
}) {
  const percentage = Math.round((cents * rate) / 10_000);
  if (company?.trim().toLowerCase() === "bcp" && operationType === "Efectivización") {
    return Math.max(percentage, BCP_EFFECT_MIN_CENTS);
  }
  return percentage;
}
