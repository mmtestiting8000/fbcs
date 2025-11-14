import express from 'express';
import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';
import cors from 'cors';
import bodyParser from 'body-parser';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { stringify } from 'csv-stringify/sync';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Servir frontend estático
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI;
const APIFY_TOKEN_DEFAULT = process.env.APIFY_TOKEN_DEFAULT || '';

if (!MONGO_URI) {
  console.error('MONGODB_URI no definido en variables de entorno');
  process.exit(1);
}

let mongoClient;
let commentsCollection;

async function connectDb() {
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  commentsCollection = db.collection('comments');
  console.log('Conectado a MongoDB');
}

// LOGIN simple
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'Cortes0202') {
    req.session.user = { username };
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: 'Credenciales inválidas' });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.user && req.session.user.username === 'admin') return next();
  return res.status(401).json({ ok: false, message: 'No autorizado' });
}

// Ejecutar scraper
app.post('/api/scrape', requireAuth, async (req, res) => {
  try {
    const { facebookUrl, commentsCount, apifyToken } = req.body;
    if (!facebookUrl) return res.status(400).json({ ok: false, message: 'facebookUrl requerido' });

    const token = apifyToken && apifyToken.trim() !== '' ? apifyToken.trim() : APIFY_TOKEN_DEFAULT;
    if (!token) return res.status(400).json({ ok: false, message: 'No hay token de Apify disponible' });

    const input = {
      startUrls: [{ url: facebookUrl }],
      maxComments: Number(commentsCount) || 50
    };

    const actorId = 'apify~facebook-comments-scraper';
    const runSyncUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync?token=${encodeURIComponent(token)}`;

    const runResp = await fetch(runSyncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });

    if (!runResp.ok) {
      const txt = await runResp.text();
      return res.status(502).json({ ok: false, message: 'Error al ejecutar actor', detail: txt });
    }

    const runOutput = await runResp.json();

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
        console.warn('No se pudo obtener dataset via /runs/last/dataset/items', e.message);
      }
    }

    const normalized = items.map(it => ({
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

    await commentsCollection.insertOne(doc);

    return res.json({ ok: true, normalized });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'Error interno', error: err.message });
  }
});

// Última instancia
app.get('/api/latest', requireAuth, async (req, res) => {
  const last = await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray();
  if (!last || last.length === 0) return res.json({ ok: true, normalized: [] });
  return res.json({ ok: true, normalized: last[0].normalized, createdAt: last[0].createdAt });
});

// Exportar CSV
app.get('/api/export-csv', requireAuth, async (req, res) => {
  const last = await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray();
  if (!last || last.length === 0) return res.status(404).send('No hay datos para exportar');
  const rows = last[0].normalized || [];
  const csv = stringify(rows, { header: true });
  res.setHeader('Content-disposition', 'attachment; filename=latest_comments.csv');
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

// Iniciar servidor
connectDb()
  .then(() => app.listen(PORT, () => console.log(`Server escuchando en http://localhost:${PORT}`)))
  .catch(err => console.error('No se pudo conectar con DB', err));
