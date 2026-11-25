# ReviewLens backend

Node + Express API. Saves studies and responses in MongoDB (`MONGODB_URI`); falls back to `data/db.json` when it is not set. See the main README one folder up for the full setup.

- `npm run dev`: http://localhost:3001 (restarts on changes)
- `npm start`: production
- `GET /api/health`: shows `{"ok":true,"storage":"mongodb"}` when everything is connected

Render: Root Directory `backend`, build `npm install`, start `npm start`.
Vercel: Root Directory `backend` (uses `vercel.json` + `api/index.js`).
Environment variables: see `.env.example`.

`src/app.js` API · `src/store.js` storage (MongoDB / Upstash Redis / JSON file) · `src/index.js` Node server · `api/index.js` Vercel entry.
