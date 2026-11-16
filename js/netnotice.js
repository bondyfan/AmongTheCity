// ---- What the HUD says when the co-op server ends or refuses a session ----
// The close codes are the server's deliberate ones (server-city/hub.js CLOSE).
// netcity.js puts them on the close info and on a failed join's error;
// main.js turns them into the toast. Czech UI text, no DOM, no imports, so the
// tests can read it headless.

export const CLOSE_CODES = { REPLACED: 4001, IDLE: 4002, SILENT: 4003, LIMIT: 4402, UNMEASURED: 4503 };

// A running session ended. info: netcity's onClose record.
export function closeNotice(info) {
  if (info?.limit) return 'Server má tento měsíc vyčerpaný limit, pokračuješ sám';
  if (info?.unmeasured) return 'Server teď nemůže ověřit svůj limit, pokračuješ sám';
  if (info?.idle) return 'Odpojeno pro dlouhou nečinnost, pokračuješ sám';
  if (info?.silent) return 'Odpojeno, hra dlouho neodpovídala, pokračuješ sám';
  if (info?.replaced) return 'Hra se připojila v jiném okně, tady pokračuješ sám';
  return 'Server spadl, pokračuješ sám';
}

// Joining failed. err: what connectCity threw ('limit' = the month's budget is used up,
// 'unmeasured' = the server cannot check the account's budget right now).
export function connectNotice(err) {
  if (err?.code === 'limit') return 'Server má tento měsíc vyčerpaný limit, hraješ sám';
  if (err?.code === 'unmeasured') return 'Server teď nemůže ověřit svůj limit, hraješ sám';
  return 'Server je nedostupný, hraješ sám';
}
