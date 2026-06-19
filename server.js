import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── DB CONNECTION ─────────────────────────────────────────
let db;

async function connectDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db(process.env.DB_NAME || 'relay');
  console.log(`✅ Connected to MongoDB Atlas — db: ${db.databaseName}`);
  // indexes for faster lookups
  await db.collection('collections').createIndex({ updatedAt: -1 });
  await db.collection('environments').createIndex({ name: 1 });
}

// ── HELPERS ───────────────────────────────────────────────
const toId = (id) => { try { return new ObjectId(id); } catch { return null; } };

const withDB = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// ══════════════════════════════════════════════════════════
// HTTP PROXY  (forwards requests server-side — bypasses browser CORS)
// ══════════════════════════════════════════════════════════

app.post('/api/proxy', async (req, res) => {
  const { url, method = 'GET', headers = {}, body } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const fetchOpts = { method, headers, signal: controller.signal };
    if (body !== undefined && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      fetchOpts.body = body;
    }

    const upstream = await fetch(url, fetchOpts);
    clearTimeout(timeout);

    const resHeaders = {};
    upstream.headers.forEach((v, k) => { resHeaders[k] = v; });

    const text = await upstream.text();
    res.status(200).json({
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
      body: text,
    });
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    res.status(200).json({
      status: 0,
      statusText: timedOut ? 'Request Timeout' : 'Network Error',
      headers: {},
      body: '',
      error: timedOut ? 'Request timed out after 30 seconds.' : err.message,
    });
  }
});

// ══════════════════════════════════════════════════════════
// COLLECTIONS
// ══════════════════════════════════════════════════════════

// GET all collections (metadata only — no full request bodies for speed)
app.get('/api/collections', withDB(async (req, res) => {
  const cols = await db.collection('collections')
    .find({}, { projection: { 'requests.body': 0 } })
    .sort({ updatedAt: -1 })
    .toArray();
  res.json(cols);
}));

// GET single collection (full)
app.get('/api/collections/:id', withDB(async (req, res) => {
  const col = await db.collection('collections').findOne({ _id: toId(req.params.id) });
  if (!col) return res.status(404).json({ error: 'Not found' });
  res.json(col);
}));

// POST create collection
app.post('/api/collections', withDB(async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const doc = { name: name.trim(), requests: [], folders: [], createdAt: new Date(), updatedAt: new Date() };
  const result = await db.collection('collections').insertOne(doc);
  res.status(201).json({ ...doc, _id: result.insertedId });
}));

// PUT update collection (name + full requests array)
app.put('/api/collections/:id', withDB(async (req, res) => {
  const { name, requests, folders } = req.body;
  const update = { updatedAt: new Date() };
  if (name !== undefined) update.name = name.trim();
  if (requests !== undefined) update.requests = requests;
  if (folders !== undefined) update.folders = folders;
  const result = await db.collection('collections')
    .findOneAndUpdate({ _id: toId(req.params.id) }, { $set: update }, { returnDocument: 'after' });
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
}));

// PATCH rename collection
app.patch('/api/collections/:id', withDB(async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const result = await db.collection('collections')
    .findOneAndUpdate({ _id: toId(req.params.id) }, { $set: { name: name.trim(), updatedAt: new Date() } }, { returnDocument: 'after' });
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
}));

// DELETE collection
app.delete('/api/collections/:id', withDB(async (req, res) => {
  await db.collection('collections').deleteOne({ _id: toId(req.params.id) });
  res.json({ ok: true });
}));

// ── REQUEST OPERATIONS INSIDE A COLLECTION ────────────────

// POST add request to collection
app.post('/api/collections/:id/requests', withDB(async (req, res) => {
  const request = { ...req.body, id: new ObjectId().toHexString(), createdAt: new Date() };
  const result = await db.collection('collections').findOneAndUpdate(
    { _id: toId(req.params.id) },
    { $push: { requests: request }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!result) return res.status(404).json({ error: 'Collection not found' });
  res.status(201).json(request);
}));

// PUT update a specific request inside a collection
app.put('/api/collections/:colId/requests/:reqId', withDB(async (req, res) => {
  const update = { ...req.body, id: req.params.reqId, updatedAt: new Date() };
  const result = await db.collection('collections').findOneAndUpdate(
    { _id: toId(req.params.colId), 'requests.id': req.params.reqId },
    { $set: { 'requests.$': update, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(update);
}));

// DELETE a specific request inside a collection
app.delete('/api/collections/:colId/requests/:reqId', withDB(async (req, res) => {
  await db.collection('collections').updateOne(
    { _id: toId(req.params.colId) },
    { $pull: { requests: { id: req.params.reqId } }, $set: { updatedAt: new Date() } }
  );
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════
// ENVIRONMENTS
// ══════════════════════════════════════════════════════════

app.get('/api/environments', withDB(async (req, res) => {
  const envs = await db.collection('environments').find().sort({ name: 1 }).toArray();
  res.json(envs);
}));

app.post('/api/environments', withDB(async (req, res) => {
  const { name, vars = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const doc = { name: name.trim(), vars, createdAt: new Date(), updatedAt: new Date() };
  const result = await db.collection('environments').insertOne(doc);
  res.status(201).json({ ...doc, _id: result.insertedId });
}));

app.put('/api/environments/:id', withDB(async (req, res) => {
  const { name, vars } = req.body;
  const update = { updatedAt: new Date() };
  if (name !== undefined) update.name = name.trim();
  if (vars !== undefined) update.vars = vars;
  const result = await db.collection('environments')
    .findOneAndUpdate({ _id: toId(req.params.id) }, { $set: update }, { returnDocument: 'after' });
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
}));

app.delete('/api/environments/:id', withDB(async (req, res) => {
  await db.collection('environments').deleteOne({ _id: toId(req.params.id) });
  res.json({ ok: true });
}));

// ── HEALTH ────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true, ts: new Date() }));

// ── START ─────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Relay API running on http://localhost:${PORT}`));
}).catch(err => { console.error('DB connection failed:', err); process.exit(1); });
