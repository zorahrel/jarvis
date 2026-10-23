import { localConfig } from './local-config.mjs';

export function operatore() {
  const override = process.env.USAGE_HUB_OPERATORE?.trim();
  if (override) return override;
  const value = localConfig().operatore;
  // Config mancante: un'identità neutra.
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'operatore';
}
