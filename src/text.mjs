const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntity(_, code) {
  if (NAMED[code]) return NAMED[code];
  const numeric = code[0] === '#' ? (code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : NaN;
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : `&${code};`;
}

// TP stores descriptions as HTML. Present them as readable text instead of raw markup.
export function renderRichText(value) {
  if (typeof value !== 'string' || !/<[a-z/!][^>]*>/i.test(value)) return value;
  return value
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*li\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<\s*\/\s*(?:p|div|h[1-6]|tr|table|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&([a-z]+|#\d+|#x[0-9a-f]+);/gi, decodeEntity)
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Applied at the tool boundary only, so internal comparisons keep the original payload.
export function present(value) {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(present);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, key.toLowerCase() === 'description' && typeof entry === 'string' ? renderRichText(entry) : present(entry)]));
}
