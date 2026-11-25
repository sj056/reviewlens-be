// ReviewLens API (Express). Used by src/index.js (local / Render / Railway) and api/index.js (Vercel).
//   RESEARCHER_PASSWORD  password for the researcher dashboard (default: "reviewlens" – change it!)
//   FRONTEND_URL         address(es) of the frontend allowed to call this API, comma-separated,
//                        e.g. https://reviewlens.vercel.app (unset = any site may call it)
import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = process.env.RESEARCHER_PASSWORD || 'reviewlens';
const store = await createStore(path.join(ROOT, 'data', 'db.json'));
const id = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const now = () => new Date().toISOString();
// pass errors from async handlers to Express instead of crashing
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/* ---------- helpers ---------- */
const app = express();

/* CORS: lets the frontend call the API when it is deployed on a different address */
const ALLOWED = (process.env.FRONTEND_URL || '').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && (!ALLOWED.length || ALLOWED.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-researcher-key');
    res.set('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));

// health check (Render / Railway / uptime monitors)
app.get('/api/health', (_req, res) => res.json({ ok: true, storage: store.kind }));

function auth(req, res, next) {
  const key = req.get('x-researcher-key') || '';
  const ok = key.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Wrong researcher password' });
  next();
}
const PUBLIC_FIELDS = ['id', 'title', 'mode', 'perPart', 'askName', 'askEducation', 'askOccupation', 'consentText', 'open'];
const publicStudy = (s) => Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, s[k]]));

function studySettings(body, base = {}) {
  const pick = (k, fallback) => (body[k] !== undefined ? body[k] : base[k] !== undefined ? base[k] : fallback);
  return {
    title: String(pick('title', 'ReviewLens study')).slice(0, 120),
    mode: pick('mode', 'immediate') === 'twostep' ? 'twostep' : 'immediate',
    perPart: [2, 4, 6, 8].includes(Number(pick('perPart', 8))) ? Number(pick('perPart', 8)) : 8,
    askName: !!pick('askName', true),
    askEducation: !!pick('askEducation', false),
    askOccupation: !!pick('askOccupation', false),
    consentText: String(pick('consentText', '')).slice(0, 2000),
    open: !!pick('open', true),
  };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const head = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [head.join(','), ...rows.map((r) => head.map((k) => cell(r[k])).join(','))].join('\n');
}
const pidText = (n) => 'P' + String(n).padStart(2, '0');

/* ---------- researcher API ---------- */
app.post('/api/login', auth, (_req, res) => res.json({ ok: true }));

app.get('/api/studies', auth, wrap(async (_req, res) => {
  const studies = (await store.listStudies()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json(
    await Promise.all(
      studies.map(async (s) => {
        const ss = await store.listSessions(s.id);
        return { ...s, started: ss.length, finished: ss.filter((x) => x.finishedAt).length };
      }),
    ),
  );
}));

app.post('/api/studies', auth, wrap(async (req, res) => {
  const s = { id: id(8), createdAt: now(), nextPid: 1, ...studySettings(req.body || {}) };
  await store.putStudy(s);
  res.json(s);
}));

app.patch('/api/studies/:id', auth, wrap(async (req, res) => {
  const s = await store.getStudy(req.params.id);
  if (!s) return res.status(404).json({ error: 'Study not found' });
  Object.assign(s, studySettings(req.body || {}, s));
  await store.putStudy(s);
  res.json(s);
}));

app.get('/api/studies/:id/sessions', auth, wrap(async (req, res) => {
  const rows = (await store.listSessions(req.params.id))
    .sort((a, b) => a.pid - b.pid)
    .map(({ trials, tlx, ...rest }) => ({ ...rest, nTrials: trials.filter((t) => t.phase === 'main').length, nTlx: tlx.length }));
  res.json(rows);
}));

app.delete('/api/sessions/:sid', auth, wrap(async (req, res) => {
  await store.deleteSession(req.params.sid);
  res.json({ ok: true });
}));

app.get('/api/studies/:id/export/:kind', auth, wrap(async (req, res) => {
  const ss = (await store.listSessions(req.params.id)).sort((a, b) => a.pid - b.pid);
  let rows = [];
  if (req.params.kind === 'trials') rows = ss.flatMap((x) => x.trials);
  else if (req.params.kind === 'tlx') rows = ss.flatMap((x) => x.tlx);
  else if (req.params.kind === 'participants')
    rows = ss.map((x) => ({
      pid: pidText(x.pid),
      status: x.finishedAt ? 'finished' : 'incomplete',
      started_at: x.startedAt,
      finished_at: x.finishedAt || '',
      name: x.person?.name || '',
      age: x.person?.age ?? '',
      gender: x.person?.gender || '',
      education: x.person?.education || '',
      occupation: x.person?.occupation || '',
      ai_use_1to5: x.person?.aiUse ?? '',
      ai_knowledge_1to5: x.person?.aiKnowledge ?? '',
      condition_order: (x.blocks || []).map((b) => b.cond).join('>'),
      ...(x.summary || {}),
    }));
  else return res.status(400).json({ error: 'Unknown export' });
  res.type('text/csv').send(toCsv(rows));
}));

/* ---------- participant API (no password; the session id acts as the key) ---------- */
app.get('/api/public/studies/:id', wrap(async (req, res) => {
  const s = await store.getStudy(req.params.id);
  if (!s) return res.status(404).json({ error: 'This study link is not valid.' });
  res.json(publicStudy(s));
}));

app.post('/api/public/studies/:id/sessions', wrap(async (req, res) => {
  const s = await store.getStudy(req.params.id);
  if (!s) return res.status(404).json({ error: 'This study link is not valid.' });
  if (!s.open) return res.status(403).json({ error: 'This study is closed and is not accepting new participants.' });
  // The database refuses a participant number that is already taken (unique index), so on a clash take the next one.
  for (let attempt = 0; attempt < 20; attempt++) {
    const pid = await store.nextPid(s.id);
    const x = { id: id(16), studyId: s.id, pid, mode: s.mode, person: req.body?.person || {}, blocks: [], startedAt: now(), finishedAt: null, trials: [], tlx: [], rank: {}, why: '', summary: null };
    try {
      await store.putSession(x);
      return res.json({ sessionId: x.id, pid });
    } catch (err) {
      if (err?.code !== 11000) throw err; // 11000 = duplicate key
    }
  }
  res.status(503).json({ error: 'Too many people are starting right now, please try again.' });
}));

app.post('/api/public/sessions/:sid/blocks', wrap(async (req, res) => {
  const x = await store.getSession(req.params.sid);
  if (!x) return res.status(404).json({ error: 'Session not found' });
  x.blocks = req.body?.blocks || [];
  await store.putSession(x);
  res.json({ ok: true });
}));

app.post('/api/public/sessions/:sid/trials', wrap(async (req, res) => {
  const x = await store.getSession(req.params.sid);
  if (!x) return res.status(404).json({ error: 'Session not found' });
  const row = req.body?.row;
  // idempotent: a retried request must not create a duplicate row
  if (row && !x.trials.some((t) => t.phase === row.phase && t.block === row.block && t.trial === row.trial)) x.trials.push(row);
  await store.putSession(x);
  res.json({ ok: true });
}));

app.post('/api/public/sessions/:sid/tlx', wrap(async (req, res) => {
  const x = await store.getSession(req.params.sid);
  if (!x) return res.status(404).json({ error: 'Session not found' });
  const row = req.body?.row;
  if (row && !x.tlx.some((t) => t.block === row.block)) x.tlx.push(row);
  await store.putSession(x);
  res.json({ ok: true });
}));

app.post('/api/public/sessions/:sid/finish', wrap(async (req, res) => {
  const x = await store.getSession(req.params.sid);
  if (!x) return res.status(404).json({ error: 'Session not found' });
  x.rank = req.body?.rank || {};
  x.why = req.body?.why || '';
  x.summary = req.body?.summary || null;
  x.finishedAt = x.finishedAt || now();
  await store.putSession(x);
  res.json({ ok: true });
}));


app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error, please try again' });
});

export const storageKind = store.kind;
export default app;
