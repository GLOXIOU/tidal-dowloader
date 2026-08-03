const jwt = require('jsonwebtoken');
const { getBestKey } = require('./apiKeys');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_BASE = 'https://auth.tidal.com/v1/oauth2';
const SESSION_COOKIE = 'tidal_session';
const SCOPE = 'r_usr+w_usr+w_sub';

let pendingFlow = null;
let currentSession = null;

async function postForm(path, data, clientId, clientSecret) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
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
  const { ok, status, data } = await postForm('/device_authorization', {
    client_id: key.clientId,
    scope: SCOPE,
  });
  if (!ok || !data.deviceCode) {
    console.error('Tidal device_authorization failed:', status, JSON.stringify(data));
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

async function pollDeviceLogin() {
  if (!pendingFlow) {
    const err = new Error('No pending login. Start one first.');
    err.code = 'NO_PENDING_LOGIN';
    throw err;
  }
  if (Date.now() > pendingFlow.expiresAt) {
    pendingFlow = null;
    const err = new Error('Login code expired, please try again.');
    err.code = 'LOGIN_EXPIRED';
    throw err;
  }

  const { ok, status, data } = await postForm(
    '/token',
    {
      client_id: pendingFlow.clientId,
      device_code: pendingFlow.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      scope: SCOPE,
    },
    pendingFlow.clientId,
    pendingFlow.clientSecret,
  );

  if (!ok) {
    if (status === 400 && Number(data.sub_status) === 1002) return { done: false };
    console.error('Tidal device token exchange failed:', status, JSON.stringify(data));
    pendingFlow = null;
    throw new Error(data.error_description || data.error || 'Login failed.');
  }

  const { clientId, clientSecret } = pendingFlow;
  pendingFlow = null;
  return {
    done: true,
    session: {
      userId: data.user?.userId,
      email: data.user?.email,
      countryCode: data.user?.countryCode,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      clientId,
      clientSecret,
    },
  };
}

async function refreshAccessToken(session) {
  const clientId = session.clientId || getBestKey().clientId;
  const clientSecret = session.clientSecret || getBestKey().clientSecret;
  const { ok, data } = await postForm(
    '/token',
    {
      client_id: clientId,
      refresh_token: session.refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPE,
    },
    clientId,
    clientSecret,
  );
  if (!ok) {
    console.error('Tidal refresh_token grant failed:', data.error, data.error_description || '');
    return null;
  }
  return {
    userId: data.user?.userId,
    email: data.user?.email,
    countryCode: data.user?.countryCode,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

function buildSessionCookie(res, session) {
  currentSession = { ...currentSession, ...session };
  const token = jwt.sign(currentSession, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function readSession(req) {
  if (currentSession) return currentSession;

  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    currentSession = jwt.verify(token, JWT_SECRET);
    return currentSession;
  } catch {
    return null;
  }
}

function clearSession(res) {
  currentSession = null;
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
