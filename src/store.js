// Storage for studies and participant sessions, chosen by environment variables:
//   1. MongoDB        when MONGODB_URI is set (e.g. MongoDB Atlas; recommended for Vercel). Database: MONGODB_DB, default "reviewlens"
//   2. Upstash Redis  when UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_URL/TOKEN) are set
//   3. JSON file      otherwise (local runs): DATA_FILE, default ./data/db.json
// Both offer the same async functions, so the API code does not care which one is used.
import fs from 'node:fs';
import path from 'node:path';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

/* ---------- JSON file ---------- */
function fileStore(file) {
  let db = { studies: [], sessions: [] };
  if (fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(db, null, 1));
    fs.renameSync(file + '.tmp', file); // atomic replace
  };
  const clone = (x) => (x ? structuredClone(x) : null);
  return {
    kind: 'file',
    async listStudies() { return db.studies.map(clone); },
    async getStudy(id) { return clone(db.studies.find((s) => s.id === id)); },
    async putStudy(s) {
      const i = db.studies.findIndex((x) => x.id === s.id);
      if (i < 0) db.studies.push(clone(s)); else db.studies[i] = clone(s);
      save();
    },
    async nextPid(studyId) {
      const s = db.studies.find((x) => x.id === studyId);
      const pid = s.nextPid++;
      save();
      return pid;
    },
    async listSessions(studyId) { return db.sessions.filter((x) => x.studyId === studyId).map(clone); },
    async getSession(id) { return clone(db.sessions.find((x) => x.id === id)); },
    async putSession(x) {
      const i = db.sessions.findIndex((y) => y.id === x.id);
      if (i < 0) db.sessions.push(clone(x)); else db.sessions[i] = clone(x);
      save();
    },
    async deleteSession(id) { db.sessions = db.sessions.filter((x) => x.id !== id); save(); },
  };
}

/* ---------- Redis ---------- */
// keys: studies (set of ids) · study:<id> (json) · study:<id>:pid (counter) · study:<id>:sessions (set) · session:<id> (json)
export function redisStore(r) {
  const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
  const many = async (keys) => (keys.length ? (await r.mget(...keys)).map(parse).filter(Boolean) : []);
  const withPid = async (s) => (s ? { ...s, nextPid: Number((await r.get(`study:${s.id}:pid`)) || 0) + 1 } : s);
  return {
    kind: 'redis',
    async listStudies() {
      const ids = await r.smembers('studies');
      return Promise.all((await many(ids.map((id) => `study:${id}`))).map(withPid));
    },
    async getStudy(id) { return withPid(parse(await r.get(`study:${id}`))); },
    async putStudy(s) {
      const { nextPid, ...rest } = s; // the counter lives in its own key
      await r.set(`study:${s.id}`, JSON.stringify(rest));
      await r.sadd('studies', s.id);
    },
    async nextPid(studyId) { return Number(await r.incr(`study:${studyId}:pid`)); }, // atomic: no two people get the same number
    async listSessions(studyId) {
      const ids = await r.smembers(`study:${studyId}:sessions`);
      return many(ids.map((id) => `session:${id}`));
    },
    async getSession(id) { return parse(await r.get(`session:${id}`)); },
    async putSession(x) {
      await r.set(`session:${x.id}`, JSON.stringify(x));
      await r.sadd(`study:${x.studyId}:sessions`, x.id);
    },
    async deleteSession(id) {
      const x = parse(await r.get(`session:${id}`));
      await r.del(`session:${id}`);
      if (x) await r.srem(`study:${x.studyId}:sessions`, id);
    },
  };
}

/* ---------- MongoDB ---------- */
// collections: studies { id, ..., nextPid } · sessions { id, studyId, pid, person, trials[], tlx[], ... }
// The client is created once per server/function instance and reused (important on Vercel).
export async function mongoStore(uri, dbName) {
  const { MongoClient } = await import('mongodb');
  globalThis.__reviewlensMongo ??= new MongoClient(uri, { maxPoolSize: 5 });
  const client = globalThis.__reviewlensMongo;
  await client.connect();
  const db = client.db(dbName);
  const studies = db.collection('studies');
  const sessions = db.collection('sessions');
  await Promise.all([
    studies.createIndex({ id: 1 }, { unique: true }),
    sessions.createIndex({ id: 1 }, { unique: true }),
    sessions.createIndex({ studyId: 1, pid: 1 }, { unique: true }), // a participant number can only be used once per study
  ]);
  const noId = { projection: { _id: 0 } };
  return {
    kind: 'mongodb',
    async listStudies() { return studies.find({}, noId).toArray(); },
    async getStudy(id) { return studies.findOne({ id }, noId); },
    async putStudy(s) {
      // never overwrite the participant counter here: it is only changed by nextPid()
      const { nextPid, _id, ...fields } = s;
      await studies.updateOne({ id: s.id }, { $set: fields, $setOnInsert: { nextPid: nextPid ?? 1 } }, { upsert: true });
    },
    async nextPid(studyId) {
      // atomic increment: two people starting at the same moment never get the same number
      const before = await studies.findOneAndUpdate({ id: studyId }, { $inc: { nextPid: 1 } }, { returnDocument: 'before' });
      return before.nextPid;
    },
    async listSessions(studyId) { return sessions.find({ studyId }, noId).sort({ pid: 1 }).toArray(); },
    async getSession(id) { return sessions.findOne({ id }, noId); },
    async putSession(x) {
      const { _id, ...doc } = x;
      await sessions.replaceOne({ id: x.id }, doc, { upsert: true });
    },
    async deleteSession(id) { await sessions.deleteOne({ id }); },
  };
}

export async function createStore(defaultFile) {
  console.log('Storage', { MONGODB_URI: !!process.env.MONGODB_URI, REDIS_URL: !!REDIS_URL, REDIS_TOKEN: !!REDIS_TOKEN, DATA_FILE: process.env.DATA_FILE || defaultFile });
  if (process.env.MONGODB_URI) return mongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || 'reviewlens');
  if (REDIS_URL && REDIS_TOKEN) {
    const { Redis } = await import('@upstash/redis');
    return redisStore(new Redis({ url: REDIS_URL, token: REDIS_TOKEN }));
  }
  if (process.env.VERCEL) throw new Error('On Vercel, set MONGODB_URI (MongoDB Atlas) so responses are saved.');
  return fileStore(path.resolve(process.env.DATA_FILE || defaultFile));
}
