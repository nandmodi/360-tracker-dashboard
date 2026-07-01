// api/trigger-sync.js — Vercel serverless function
// Called by Sync button → triggers GitHub Action → returns immediately

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_PAT;
  if (!token) return res.status(500).json({ error: 'GITHUB_PAT not configured' });

  try {
    const response = await fetch(
      'https://api.github.com/repos/nandmodi/360-tracker-dashboard/actions/workflows/sync-data.yml/dispatches',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    if (response.status === 204) {
      return res.status(200).json({ ok: true, message: 'Sync triggered successfully' });
    } else {
      const text = await response.text();
      return res.status(500).json({ error: `GitHub API error: ${response.status}`, detail: text });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
