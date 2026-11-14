// Captures ?ref=<code> from the URL into localStorage so it survives
// navigation between the landing page and wherever signup actually happens.
const STORAGE_KEY = 'bhs_ref';

export function captureReferralCode(): void {
  const ref = new URLSearchParams(location.search).get('ref');
  if (!ref || !ref.trim()) return;
  try {
    localStorage.setItem(STORAGE_KEY, ref.trim().toUpperCase());
  } catch {
    // ignore
  }
}

export function getReferralCode(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}
