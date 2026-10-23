// Prezzi listino Anthropic in USD per milione di token, verificati il 2026-10-16.
// Fonti: https://www.anthropic.com/pricing e https://docs.anthropic.com/en/docs/about-claude/pricing
export const API_PRICES = Object.freeze({
  'claude-opus-4-1': Object.freeze({ input: 15, output: 75, cacheWrite5m: 18.75, cacheRead: 1.5 }),
  'claude-opus-4-5': Object.freeze({ input: 5, output: 25, cacheWrite5m: 6.25, cacheRead: 0.5 }),
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20, cacheWrite5m: 5, cacheRead: 0.2 }),
  'claude-sonnet-4-5': Object.freeze({ input: 3, output: 15, cacheWrite5m: 3.75, cacheRead: 0.3 }),
  'claude-sonnet-4-6': Object.freeze({ input: 3, output: 15, cacheWrite5m: 3.75, cacheRead: 0.3 }),
  'claude-haiku-4-5': Object.freeze({ input: 1, output: 5, cacheWrite5m: 1.25, cacheRead: 0.1 }),
  'claude-haiku-3-5': Object.freeze({ input: 0.8, output: 4, cacheWrite5m: 1, cacheRead: 0.08 }),
  'claude-sonnet-3-7': Object.freeze({ input: 3, output: 15, cacheWrite5m: 3.75, cacheRead: 0.3 }),
});

export function priceForModel(model) {
  const name = String(model || '');
  const key = Object.keys(API_PRICES).find(candidate => name === candidate || name.startsWith(`${candidate}-`));
  return key ? API_PRICES[key] : null;
}
