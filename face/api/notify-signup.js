module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, phone } = req.body || {};
  if (typeof phone !== 'string' || !phone.trim()) {
    return res.status(400).json({ error: 'Missing phone' });
  }

  const { NTFY_TOPIC } = process.env;
  if (NTFY_TOPIC) {
    const displayName = (typeof name === 'string' && name.trim()) || 'Unknown';
    const displayEmail = (typeof email === 'string' && email.trim()) || '';
    const lines = [displayName, displayEmail, phone.trim()].filter(Boolean);
    try {
      await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST',
        headers: { Title: 'New signup started', Tags: 'wave', Click: 'https://faceswap.fit/admin' },
        body: lines.join('\n').slice(0, 500),
      });
    } catch (err) {
      console.error('ntfy notify failed', err);
    }
  }

  return res.status(200).json({ ok: true });
};
