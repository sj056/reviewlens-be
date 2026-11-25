// ReviewLens backend as a normal Node server (local, Render, Railway, Fly…).
//   PORT          default 3001
//   FRONTEND_DIST optional: folder with the built frontend to serve from the same address
//                 (default ../frontend/dist if it exists, so one server can run everything)
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import app, { ROOT, storageKind } from './app.js';
 
const PORT = Number(process.env.PORT || 3001);
const DIST = path.resolve(process.env.FRONTEND_URL || path.join(ROOT, '..', 'frontend', 'dist'));

if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
  console.log(`Serving the frontend from ${DIST}`);
} else {
  app.get('/', (_req, res) => res.json({ service: 'ReviewLens API', health: '/api/health' }));
}

app.listen(PORT, () => {
  console.log(`ReviewLens API on http://localhost:${PORT} (storage: ${storageKind})`);
  if (!process.env.RESEARCHER_PASSWORD) console.log('  ! using the default researcher password "reviewlens" – set RESEARCHER_PASSWORD');
});
