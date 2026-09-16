/**
 * api/auth-check.js — verifies a Google Sign-In ID token and checks the
 * signed-in user's email against a server-only allow-list.
 *
 * The allow-list lives ONLY in the ALLOWED_EMAILS environment variable
 * (set in Vercel → Project Settings → Environment Variables) and is never
 * sent to the browser — this endpoint only ever returns a yes/no answer
 * for the ONE email that was just verified, never the full list.
 */

const CLIENT_ID = '713197071795-fsr4u5j8d3o91olgcdb96kit4oaiqfu7.apps.googleusercontent.com';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    return res.status(405).json({ allowed: false, error: 'Method not allowed' });
  }

  const credential = req.body && req.body.credential;
  if (!credential) {
    return res.status(400).json({ allowed: false, error: 'Missing credential' });
  }

  try {
    // Google verifies the token's signature for us and hands back the
    // decoded claims — no JWT/crypto library needed on our side.
    const verifyRes = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential)
    );
    if (!verifyRes.ok) {
      return res.status(200).json({ allowed: false, error: 'Invalid or expired token' });
    }
    const claims = await verifyRes.json();

    // Must be issued for OUR client — otherwise a token meant for a
    // different app could be replayed here.
    if (claims.aud !== CLIENT_ID) {
      return res.status(200).json({ allowed: false, error: 'Token not issued for this app' });
    }
    if (claims.email_verified !== 'true' && claims.email_verified !== true) {
      return res.status(200).json({ allowed: false, error: 'Email not verified by Google' });
    }

    const email = (claims.email || '').trim().toLowerCase();
    const allowList = (process.env.ALLOWED_EMAILS || '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

    const allowed = allowList.includes(email);
    return res.status(200).json({ allowed, email: allowed ? email : undefined });
  } catch (err) {
    console.error('[auth-check]', err.message);
    return res.status(200).json({ allowed: false, error: 'Verification failed' });
  }
};
