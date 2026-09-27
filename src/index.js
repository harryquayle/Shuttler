const FIRESTORE_COLLECTION = 'users';
const FCM_TITLE = '🍊 New Satsuma session scheduled';
const RESEND_FROM = 'Shuttler <notifications@badminton.shuttler.uk>';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/notify-satsuma-session') {
      return handleNotifySatsumaSession(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/notify-satsuma-broadcast') {
      return handleNotifySatsumaBroadcast(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

// Shared setup for both notify routes: checks the shared secret, loads the
// service account, mints a Google access token, and fetches recipients.
// Returns { error: Response } on failure, otherwise { serviceAccount, accessToken, recipients }.
async function prepareNotify(request, env) {
  if (request.headers.get('X-Notify-Secret') !== env.NOTIFY_API_SECRET) {
    return { error: json({ error: 'Unauthorized' }, 401) };
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    return { error: json({ error: 'Server misconfigured: invalid FIREBASE_SERVICE_ACCOUNT' }, 500) };
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(serviceAccount, [
      'https://www.googleapis.com/auth/cloud-platform',
    ]);
  } catch (e) {
    return { error: json({ error: 'Failed to authenticate with Google: ' + e.message }, 500) };
  }

  let recipients;
  try {
    recipients = await fetchSatsumaRecipients(serviceAccount.project_id, accessToken);
  } catch (e) {
    return { error: json({ error: 'Failed to query Firestore: ' + e.message }, 500) };
  }

  return { serviceAccount, accessToken, recipients };
}

async function sendToRecipients(serviceAccount, accessToken, env, recipients, { pushTitle, pushBody, pushData, emailSubject, emailHtml }) {
  const tasks = [];
  for (const r of recipients) {
    if (r.fcmToken) {
      tasks.push(
        sendFcmMessage(serviceAccount.project_id, accessToken, r.fcmToken, pushTitle, pushBody, pushData)
      );
    }
    if (r.email) {
      tasks.push(sendResendEmail(env.RESEND_API_KEY, r.email, emailSubject, emailHtml));
    }
  }

  const results = await Promise.allSettled(tasks);
  const failures = results.filter((r) => r.status === 'rejected');

  return json({
    ok: true,
    recipients: recipients.length,
    pushSent: recipients.filter((r) => r.fcmToken).length,
    emailsSent: recipients.filter((r) => r.email).length,
    failures: failures.map((f) => String((f.reason && f.reason.message) || f.reason)),
  });
}

async function handleNotifySatsumaSession(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { dateStr, timeStr, location } = body || {};
  if (!dateStr || !timeStr || !location) {
    return json({ error: 'Missing dateStr, timeStr, or location' }, 400);
  }

  const prep = await prepareNotify(request, env);
  if (prep.error) return prep.error;
  const { serviceAccount, accessToken, recipients } = prep;

  return sendToRecipients(serviceAccount, accessToken, env, recipients, {
    pushTitle: FCM_TITLE,
    pushBody: `${dateStr} at ${timeStr} — ${location}`,
    pushData: { type: 'satsuma_session', url: '/' },
    emailSubject: FCM_TITLE,
    emailHtml: `<h2>New Satsuma session scheduled</h2><p><strong>${escapeHtml(dateStr)}</strong> at <strong>${escapeHtml(timeStr)}</strong></p><p>📍 ${escapeHtml(location)}</p>`,
  });
}

async function handleNotifySatsumaBroadcast(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { title, body: pushBody, html } = body || {};
  if (!title || !pushBody || !html) {
    return json({ error: 'Missing title, body, or html' }, 400);
  }

  const prep = await prepareNotify(request, env);
  if (prep.error) return prep.error;
  const { serviceAccount, accessToken, recipients } = prep;

  return sendToRecipients(serviceAccount, accessToken, env, recipients, {
    pushTitle: title,
    pushBody,
    pushData: { type: 'satsuma_announcement', url: '/' },
    emailSubject: title,
    emailHtml: html,
  });
}

// ── Firestore ────────────────────────────────────────────────────────

async function fetchSatsumaRecipients(projectId, accessToken) {
  const [byAccess, byView] = await Promise.all([
    runFirestoreQuery(projectId, accessToken, 'satsumaAccess'),
    runFirestoreQuery(projectId, accessToken, 'satsumaView'),
  ]);

  const docsByName = new Map();
  for (const doc of [...byAccess, ...byView]) {
    docsByName.set(doc.name, doc);
  }

  const recipients = [];
  for (const doc of docsByName.values()) {
    const fields = doc.fields || {};
    const email = fields.email && fields.email.stringValue;
    const fcmToken = fields.fcmToken && fields.fcmToken.stringValue;
    if (email || fcmToken) recipients.push({ email, fcmToken });
  }
  return recipients;
}

async function runFirestoreQuery(projectId, accessToken, booleanField) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: FIRESTORE_COLLECTION }],
          where: {
            fieldFilter: {
              field: { fieldPath: booleanField },
              op: 'EQUAL',
              value: { booleanValue: true },
            },
          },
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Firestore query (${booleanField}) failed: ${res.status} ${await res.text()}`);
  }

  const rows = await res.json();
  return rows.filter((row) => row.document).map((row) => row.document);
}

// ── Google OAuth2 (service account) ─────────────────────────────────

async function getGoogleAccessToken(serviceAccount, scopes) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(claimSet))}`;
  const key = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64urlEncodeBytes(new Uint8Array(signature))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function importPrivateKey(pem) {
  const contents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binaryDer = Uint8Array.from(atob(contents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function base64urlEncode(str) {
  return base64urlEncodeBytes(new TextEncoder().encode(str));
}

function base64urlEncodeBytes(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── FCM ──────────────────────────────────────────────────────────────

async function sendFcmMessage(projectId, accessToken, token, title, body, data) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: data || {},
        },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`FCM send failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ── Resend ───────────────────────────────────────────────────────────

async function sendResendEmail(apiKey, to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
