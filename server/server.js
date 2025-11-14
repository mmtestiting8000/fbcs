import express from "express";
import session from "express-session";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";
import path from "path";
import { fileURLToPath } from "url";
import { stringify } from "csv-stringify/sync";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use(
  session({
    secret: "supersecret-session",
    resave: false,
    saveUninitialized: true,
  })
);

// ------------------------------
// SERVIR FRONTEND
// ------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------
// LOGIN
// ------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.user === "admin") return next();
  return res.status(401).json({ ok: false, message: "No autorizado" });
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "Cortes0202") {
    req.session.user = "admin";
    return res.json({ ok: true });
  }
  return res.json({ ok: false, message: "Credenciales incorrectas" });
});

// ------------------------------
// MONGODB
// ------------------------------
let commentsCollection;

async function connectDb() {
  const uri = process.env.MONGODB_URI;

  if (!uri) throw new Error("MONGODB_URI no está configurado");

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("fb_scraper");
  commentsCollection = db.collection("comments");
  console.log("Conectado a MongoDB");
}

// ------------------------------
// SCRAPER
// ------------------------------
app.post("/api/scrape", requireAuth, async (req, res) => {
  const { facebookUrl, commentsCount, apifyToken } = req.body;

  const token = apifyToken?.trim() !== "" ? apifyToken : process.env.APIFY_DEFAULT_TOKEN;

  if (!token) {
    return res.status(400).json({
      ok: false,
      message: "No hay token de Apify definido",
    });
  }

  try {
    const actorId = "apify/facebook-comments-scraper";

    // INPUT corregido
    const input = {
      startUrls: [{ url: facebookUrl }],
      maxComments: Number(commentsCount) || 50
    };

    // Ejecutar actor
    const runResp = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(token)}&waitForFinish=1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      }
    );

    if (!runResp.ok) {
      const txt = await runResp.text();
      console.error("Error Apify:", txt);
      return res.status(502).json({ ok: false, detail: txt });
    }

    const runData = await runResp.json();

    // Extraer dataset
    const datasetId = runData.data?.defaultDatasetId;
    if (!datasetId) {
      return res.status(502).json({ ok: false, detail: "Dataset no encontrado" });
    }

    const itemsResp = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}`
    );

    const items = await itemsResp.json();

    // Normalizar
    const normalized = items.map(it => ({
      postTitle: it.postTitle || "",
      text: it.text || "",
      likesCount: String(it.likesCount ?? 0),
      facebookUrl
    }));

    // Guardar en Mongo
    await commentsCollection.insertOne({
      createdAt: new Date(),
      facebookUrl,
      commentsCount: normalized.length,
      rawItems: items,
      normalized
    });

    return res.json({ ok: true, normalized });

  } catch (err) {
    console.error("Error interno:", err);
    return res.status(500).json({ ok: false, message: "Error interno", detail: err.message });
  }
});

// ------------------------------
// OBTENER ÚLTIMA INSTANCIA
// ------------------------------
app.get("/api/latest", requireAuth, async (req, res) => {
  const last = await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray();
  if (!last.length) return res.json({ ok: true, normalized: [] });

  return res.json({ ok: true, normalized: last[0].normalized });
});

// ------------------------------
// EXPORTAR CSV
// ------------------------------
app.get("/api/export-csv", requireAuth, async (req, res) => {
  const last = await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray();
  if (!last.length) return res.status(404).send("Sin datos");

  const csv = stringify(last[0].normalized, { header: true });

  res.setHeader("Content-Disposition", "attachment; filename=latest_comments.csv");
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

// ------------------------------
// INICIAR SERVIDOR
// ------------------------------
connectDb().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log("Servidor listo en puerto", PORT));
});
