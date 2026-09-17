/**
 * api/auth-check.js — verifies a Google Sign-In ID token OR an existing
 * signed session-token, and checks the user's email against a server-only
 * allow-list.
 *
 * SECURITY NOTE: the earlier version let the browser "stay signed in" just
 * by having *any* value present in localStorage — that was forgeable from
 * the browser console. Now the browser stores a token that is signed with
 * SESSION_SECRET (a server-only secret, never sent to the client). Every
 * page load, this endpoint re-verifies that signature + expiry — a value
 * typed into the console won't have a valid signature, so it's rejected.
 *
 * The allow-list itself lives ONLY in the ALLOWED_EMAILS environment
 * variable and is never sent to the browser — this endpoint only ever
 * returns a yes/no answer (+ a fresh signed token) for the ONE email that
 * was just verified, never the full list.
 */

const crypto = require('crypto');
const CLIENT_ID = '713197071795-fsr4u5j8d3o91olgcdb96kit4oaiqfu7.apps.googleusercontent.com';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(payload) {
  const secret = process.env.SESSION_SECRET;
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}
function issueToken(email) {
  const payload = email + '|' + (Date.now() + SESSION_TTL_MS);
  const payloadB64 = Buffer.from(payload).toString('base64url');
  return payloadB64 + '.' + sign(payloadB64);
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expectedSig = sign(payloadB64);
  // Constant-time comparison — avoids leaking the secret via response-timing.
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  const [email, expStr] = payload.split('|');
  const exp = parseInt(expStr, 10);
  if (!email || !exp || Date.now() > exp) return null;
  return email;
}
function isAllowed(email) {
  const allowList = (process.env.ALLOWED_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return allowList.includes(email);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    return res.status(405).json({ allowed: false, error: 'Method not allowed' });
  }
  if (!process.env.SESSION_SECRET) {
    console.error('[auth-check] SESSION_SECRET is not set');
    return res.status(500).json({ allowed: false, error: 'Server misconfigured' });
  }

  // Path 1: restoring an existing (previously-issued, signed) session.
  const existingToken = req.body && req.body.token;
  if (existingToken) {
    const email = verifyToken(existingToken);
    if (email && isAllowed(email)) {
      return res.status(200).json({ allowed: true, email, token: issueToken(email) }); // sliding renewal
    }
    return res.status(200).json({ allowed: false, error: 'Session expired or invalid — please sign in again' });
  }

  // Path 2: fresh Google Sign-In credential.
  const credential = req.body && req.body.credential;
  if (!credential) {
    return res.status(400).json({ allowed: false, error: 'Missing credential or token' });
  }

  try {
    // Google verifies the token's signature for us and hands back the
    // decoded claims — no JWT/crypto library needed on our side for this part.
    const verifyRes = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential)
    );
    if (!verifyRes.ok) {
      return res.status(200).json({ allowed: false, error: 'Invalid or expired token' });
    }
    const claims = await verifyRes.json();

    if (claims.aud !== CLIENT_ID) {
      return res.status(200).json({ allowed: false, error: 'Token not issued for this app' });
    }
    if (claims.email_verified !== 'true' && claims.email_verified !== true) {
      return res.status(200).json({ allowed: false, error: 'Email not verified by Google' });
    }

    const email = (claims.email || '').trim().toLowerCase();
    if (!isAllowed(email)) {
      return res.status(200).json({ allowed: false });
    }
    return res.status(200).json({ allowed: true, email, token: issueToken(email) });
  } catch (err) {
    console.error('[auth-check]', err.message);
    return res.status(200).json({ allowed: false, error: 'Verification failed' });
  }
};
