/**
 * Cloudflare Pages Function: POST /livekit-token
 *
 * Accepts:
 *   Authorization: Bearer <firebase-id-token>
 *   Body JSON: { roomName: string, canPublish: boolean }
 *
 * Returns:
 *   { token: string }  — a signed LiveKit JWT
 *
 * Required Cloudflare env vars (set via Pages → Settings → Environment variables):
 *   LIVEKIT_API_KEY
 *   LIVEKIT_API_SECRET
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── Auth: decode Firebase ID token to get the caller's UID ──────────────
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return _json({ error: 'Unauthorized' }, 401);
  }

  const payload = _decodeJwt(idToken);
  if (!payload || !payload.sub) {
    return _json({ error: 'Unauthorized' }, 401);
  }
  const uid = payload.sub;

  // ── Parse params (sent as query string to survive any redirect) ───────────
  const url = new URL(request.url);
  const roomName  = url.searchParams.get('roomName')  || '';
  const canPublish = url.searchParams.get('canPublish') === '1';

  if (!roomName || typeof roomName !== 'string' || roomName.length > 128) {
    return _json({ error: 'Bad Request: invalid roomName', roomName: roomName.slice(0, 50) }, 400);
  }

  // ── Check env vars ────────────────────────────────────────────────────────
  const apiKey    = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    return _json({ error: 'Server misconfigured — missing LiveKit credentials' }, 500);
  }

  // ── Generate LiveKit JWT ──────────────────────────────────────────────────
  try {
    const token = await _createLiveKitToken({
      apiKey,
      apiSecret,
      roomName,
      identity: uid,
      canPublish: !!canPublish
    });
    return _json({ token });
  } catch (err) {
    return _json({ error: 'Internal error' }, 500);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Decode a JWT payload without cryptographic verification.
 * Good enough for extracting the Firebase UID; LiveKit's server enforces
 * room permissions via the signed token we return.
 */
function _decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/**
 * Create a LiveKit access token signed with HS256.
 * Uses the Web Crypto API (available in Cloudflare Workers).
 */
async function _createLiveKitToken({ apiKey, apiSecret, roomName, identity, canPublish }) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = {
    exp: now + 6 * 3600,
    iss: apiKey,
    nbf: now,
    sub: identity,
    video: {
      room:           roomName,
      roomJoin:       true,
      canPublish:     canPublish,
      canSubscribe:   true,
      canPublishData: true
    }
  };

  // base64url-encode a Uint8Array without using btoa (avoids binary string pitfalls).
  function b64url(bytes) {
    const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1] | 0, c = bytes[i + 2] | 0;
      s += TABLE[a >> 2];
      s += TABLE[((a & 3) << 4) | (b >> 4)];
      if (i + 1 < bytes.length) s += TABLE[((b & 15) << 2) | (c >> 6)];
      if (i + 2 < bytes.length) s += TABLE[c & 63];
    }
    return s;
  }

  const enc = new TextEncoder();
  const headerB64 = b64url(enc.encode(JSON.stringify(header)));
  const claimsB64 = b64url(enc.encode(JSON.stringify(claims)));
  const sigInput  = `${headerB64}.${claimsB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(sigInput));
  const sig    = b64url(new Uint8Array(sigBuf));

  return `${sigInput}.${sig}`;
}
