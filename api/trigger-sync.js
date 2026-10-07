/**
 * api/trigger-sync.js — lets a signed-in dashboard user start the "Sync Metabase data"
 * GitHub Actions workflow, and check on its progress.
 *
 *   POST /api/trigger-sync   { token }   → starts the workflow (unless one is already running)
 *   GET  /api/trigger-sync?token=…       → status of the most recent run
 *
 * The GitHub token lives ONLY in the GITHUB_DISPATCH_TOKEN env var on Vercel and is never
 * sent to the browser. Callers must present the same signed session token the dashboard
 * already uses (verified with SESSION_SECRET + ALLOWED_EMAILS, exactly like api/auth-check.js).
 *
 * Required Vercel env vars: GITHUB_DISPATCH_TOKEN, SESSION_SECRET, ALLOWED_EMAILS
 */

const crypto = require('crypto');

const OWNER = 'nandmodi';
const REPO = '360-tracker-dashboard';
const WORKFLOW = 'sync-data.yml';
const REF = 'main';
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

function sign(payload) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(sign(payloadB64));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [email, expStr] = Buffer.from(payloadB64, 'base64url').toString('utf8').split('|');
  const exp = parseInt(expStr, 10);
  if (!email || !exp || Date.now() > exp) return null;
  return email;
}
function isAllowed(email) {
  return (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean).includes(email);
}

async function gh(path, init = {}) {
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': '360-tracker-dashboard',
      ...(init.headers || {}),
    },
  });
}
async function latestRun() {
  const r = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  if (!r.ok) throw new Error(`GitHub runs lookup failed (${r.status})`);
  const run = ((await r.json()).workflow_runs || [])[0];
  if (!run) return null;
  return {
    id: run.id, status: run.status, conclusion: run.conclusion, event: run.event,
    createdAt: run.created_at, updatedAt: run.updated_at, url: run.html_url,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.SESSION_SECRET || !process.env.GITHUB_DISPATCH_TOKEN) {
    console.error('[trigger-sync] SESSION_SECRET or GITHUB_DISPATCH_TOKEN is not set');
    return res.status(500).json({ ok: false, error: 'Server not configured for manual sync' });
  }

  const token = req.method === 'GET' ? (req.query && req.query.token) : (req.body && req.body.token);
  const email = verifyToken(token);
  if (!email || !isAllowed(email)) return res.status(401).json({ ok: false, error: 'Session expired — please sign in again' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, run: await latestRun() });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    // Don't stack runs: if one is already queued/running, report it instead of starting another.
    const current = await latestRun();
    if (current && ACTIVE.has(current.status)) {
      return res.status(200).json({ ok: true, started: false, alreadyRunning: true, run: current });
    }

    const d = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: REF }),
    });
    if (d.status !== 204) {
      const txt = await d.text();
      console.error('[trigger-sync] dispatch failed', d.status, txt.slice(0, 300));
      return res.status(502).json({ ok: false, error: `GitHub refused to start the workflow (${d.status})` });
    }
    console.log(`[trigger-sync] workflow dispatched by ${email}`);
    return res.status(200).json({ ok: true, started: true, requestedAt: new Date().toISOString(), by: email });
  } catch (err) {
    console.error('[trigger-sync]', err.message);
    return res.status(502).json({ ok: false, error: 'Could not reach GitHub' });
  }
};
