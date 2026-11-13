// Assumes US (+1) when the caller doesn't type a country code themselves.
export function normalizePhone(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) {
    return `+${trimmed.slice(1).replace(/\D/g, '')}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return `+1${digits}`;
}
