import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import session from 'express-session';
import { stringify } from 'csv-stringify/sync';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'fb_scraper';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'comments';
const DEFAULT_APIFY_TOKEN = process.env.APIFY_TOKEN_DEFAULT || '';

app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false,
  saveUninitialized: true
}));

let db;
let commentsCollection;

// --- Conectar a MongoDB ---
async function connectDb() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  commentsCollection = db.collection(COLLECTION_NAME);
  console.log('Conectado a MongoDB');
}

// --- Middleware de autenticación ---
function requireAuth(req, res, next) {
  if (req.session && req.session.user === 'admin') return next();
  return res.status(401).json({ ok: false, message: 'No autorizado' });
}

// --- Login ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'Cortes0202') {
    req.session.user = 'admin';
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: 'Credenciales incorrectas' });
});

// --- Scraper ---
app.post('/api/scrape', requireAuth, async (req, res) => {
  const { facebookUrl, commentsCount, apifyToken } = req.body;
  const token = apifyToken || DEFAULT_APIFY_TOKEN;

  if (!facebookUrl) return res.status(400).json({ ok: false, message: 'Debe proporcionar una URL de Facebook' });

  const actorId = 'apify/facebook-comments-scraper';
  const runSyncUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync?token=${encodeURIComponent(token)}`;

  try {
    const input = {
      startUrls: [{ url: facebookUrl }],
      maxComments: Number(commentsCount) || 50
    };

    const runResp = await fetch(runSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    });

    if (!runResp.ok) {
      const txt = await runResp.text();
      return res.status(502).json({ ok: false, message: 'Error al ejecutar actor', detail: txt });
    }

    const runOutput = await runResp.json();

    // Extraer items del output
    let items = [];
    if (Array.isArray(runOutput)) items = runOutput;
    else if (Array.isArray(runOutput.items)) items = runOutput.items;
    else if (Array.isArray(runOutput.output)) items = runOutput.output;
    else if (runOutput && runOutput.content && Array.isArray(runOutput.content)) items = runOutput.content;
    else {
      try {
        const actorPrefix = `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items?token=${encodeURIComponent(token)}`;
        const ds = await fetch(actorPrefix);
        if (ds.ok) items = await ds.json();
      } catch (e) {
        console.warn('No se pudo obtener dataset vía /runs/last/dataset/items', e.message);
      }
    }

    // Limitar al número de comentarios solicitado
    const max = Number(commentsCount) || 50;
    const limitedItems = items.slice(0, max);

    // Normalizar datos
    const normalized = limitedItems.map(it => ({
      postTitle: it.postTitle || it.post_title || it.title || '',
      text: it.text || it.comment || it.message || '',
      likesCount: String(it.likesCount ?? it.likes ?? it.reactions ?? 0),
      facebookUrl: it.facebookUrl || it.postUrl || facebookUrl
    }));

    const doc = {
      createdAt: new Date(),
      facebookUrl,
      commentsCount: Number(commentsCount) || normalized.length,
      apifyTokenUsed: token ? 'provided' : 'none',
      rawItems: items,
      normalized
    };

    try {
      await commentsCollection.insertOne(doc);
    } catch (e) {
      console.error('Error guardando en MongoDB:', e);
      return res.status(500).json({ ok: false, message: 'Error guardando en MongoDB', error: e.message });
    }

    return res.json({ ok: true, normalized });

  } catch (err) {
    console.error('Error ejecutando scraper:', err);
    return res.status(500).json({ ok: false, message: 'Error interno', error: err.message });
  }
});

// --- Obtener última instancia ---
app.get('/api/latest', requireAuth, async (req, res) => {
  const last = await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray();
  if (!last || last.length === 0) return res.json({ ok: true, normalized: [] });
  return res.json({ ok: true, normalized: last[0].normalized, createdAt: last[0].createdAt });
});

// --- Exportar CSV ---
app.get('/api/export-csv', requireAuth, async (req, res) => {
  const last = await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray();
  if (!last || last.length === 0) return res.status(404).send('No hay datos para exportar');
  const rows = last[0].normalized || [];
  const csv = stringify(rows, { header: true });
  res.setHeader('Content-disposition', 'attachment; filename=latest_comments.csv');
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

// --- Inicio del servidor ---
connectDb().then(() => {
  app.listen(PORT, () => console.log(`Server escuchando en http://localhost:${PORT}`));
}).catch(err => {
  console.error('No se pudo conectar con DB', err);
});
