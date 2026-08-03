// OAuth2 device-code login against Tidal (ported from tidal_dl/tidal.py's
// getDeviceCode/checkAuthStatus/refreshAccessToken/verifyAccessToken), wired into the
// JWT-session-cookie pattern used in shazam-to-platform's src/tidalAuth.js.
//
// Unlike shazam-to-platform (authorization-code + PKCE against the official partner API),
// this uses the device-code grant against Tidal's private API - the only flow that later lets
// tidalApi.js fetch a playable stream manifest. No password is ever entered in this app: the
// user authorizes by typing a short code on tidal.com on any device.

const jwt = require('jsonwebtoken');
const { getBestKey } = require('./apiKeys');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_BASE = 'https://auth.tidal.com/v1/oauth2';
const SESSION_COOKIE = 'tidal_session';
const SCOPE = 'r_usr+w_usr+w_sub';

// Single-user, self-hosted app: one pending device-flow attempt at a time is enough.
let pendingFlow = null;

async function postForm(path, data, useAuth) {
  const key = getBestKey();
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (useAuth) {
    headers.Authorization = 'Basic ' + Buffer.from(`${key.clientId}:${key.clientSecret}`).toString('base64');
  }
  const res = await fetch(TOKEN_BASE + path, {
    method: 'POST',
    headers,
    body: new URLSearchParams(data).toString(),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: json };
}

async function startDeviceLogin() {
  const key = getBestKey();
  const { ok, data } = await postForm('/device_authorization', {
    client_id: key.clientId,
    scope: SCOPE,
  });
  if (!ok || !data.deviceCode) {
    throw new Error('Device authorization failed. Tidal rejected the client key.');
  }

  pendingFlow = {
    clientId: key.clientId,
    clientSecret: key.clientSecret,
    deviceCode: data.deviceCode,
    interval: data.interval || 2,
    expiresAt: Date.now() + (data.expiresIn || 300) * 1000,
  };

  return {
    verificationUrl: `http://${data.verificationUri}/${data.userCode}`,
    userCode: data.userCode,
    interval: pendingFlow.interval,
    expiresIn: data.expiresIn || 300,
  };
}

// Returns { done: false } while waiting, { done: true, session } once linked, throws on timeout/error.
async function pollDeviceLogin() {
  if (!pendingFlow) throw new Error('No pending login. Start one first.');
  if (Date.now() > pendingFlow.expiresAt) {
    pendingFlow = null;
    throw new Error('Login code expired, please try again.');
  }

  const { ok, status, data } = await postForm(
    '/token',
    {
      client_id: pendingFlow.clientId,
      device_code: pendingFlow.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      scope: SCOPE,
    },
    true,
  );

  if (!ok) {
    if (status === 400 && Number(data.sub_status) === 1002) return { done: false };
    pendingFlow = null;
    throw new Error(data.error_description || 'Login failed.');
  }

  pendingFlow = null;
  return {
    done: true,
    session: {
      userId: data.user?.userId,
      countryCode: data.user?.countryCode,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    },
  };
}

async function refreshAccessToken(refreshToken) {
  const key = getBestKey();
  const { ok, data } = await postForm(
    '/token',
    {
      client_id: key.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPE,
    },
    true,
  );
  if (!ok) return null;
  return {
    userId: data.user?.userId,
    countryCode: data.user?.countryCode,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

function buildSessionCookie(res, session) {
  const token = jwt.sign(session, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function readSession(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function clearSession(res) {
  res.clearCookie(SESSION_COOKIE);
}

module.exports = {
  startDeviceLogin,
  pollDeviceLogin,
  refreshAccessToken,
  buildSessionCookie,
  readSession,
  clearSession,
};
