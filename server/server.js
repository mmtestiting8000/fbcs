import express from "express";
import session from "express-session";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";
import path from "path";
import { fileURLToPath } from "url";
import { Parser } from "json2csv";

dotenv.config();

// --------------------------
//  CONFIGURACIONES BASE
// --------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "defaultsecret",
  resave: false,
  saveUninitialized: false,
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------
// MONGO (NO BLOQUEA LA APP)
// --------------------------
let mongoClient = null;
let mongoCollection = null;

async function connectDb() {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI no definido");

    mongoClient = new MongoClient(uri);
    await mongoClient.connect();

    const db = mongoClient.db("fb_scraper");
    mongoCollection = db.collection("results");

    console.log("MongoDB conectado");
  } catch (err) {
    console.log("⚠️ No se pudo conectar a Mongo:", err.message);
    mongoClient = null;
    mongoCollection = null;
  }
}
connectDb();

// --------------------------
// LOGIN
// --------------------------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "admin") {
    req.session.logged = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: "Credenciales incorrectas" });
});

// Middleware auth
function requireLogin(req, res, next) {
  if (!req.session.logged)
    return res.status(403).json({ ok: false, message: "No autorizado" });
  next();
}

// --------------------------
// RUTA DE SCRAPING CON APIFY
// --------------------------
app.post("/api/scrape", requireLogin, async (req, res) => {
  try {
    const { facebookUrl, commentsCount, apifyToken } = req.body;

    const token = apifyToken?.trim() || process.env.APIFY_TOKEN_DEFAULT;
    if (!token) {
      return res.status(400).json({
        ok: false,
        message: "Token de Apify no configurado."
      });
    }

    if (!facebookUrl) {
      return res.status(400).json({ ok: false, message: "Falta la URL de Facebook" });
    }

    // 1️⃣ Iniciar el actor de Apify
    const startRun = await fetch(
      `https://api.apify.com/v2/acts/apify~facebook-comments-scraper/runs?token=${token}`,
      {
        method: "POST",
        body: JSON.stringify({
          startUrls: [{ url: facebookUrl }],
          resultsLimit: commentsCount ? Number(commentsCount) : 50
        })
      }
    );
    const startData = await startRun.json();

    if (!startData.data?.id) {
      return res.status(500).json({
        ok: false,
        message: "No se pudo iniciar el actor",
        detail: startData
      });
    }

    const runId = startData.data.id;

    // 2️⃣ Esperar a que termine el actor
    let runFinished = false;
    let runResult = null;

    while (!runFinished) {
      await new Promise(r => setTimeout(r, 3000));
      const check = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`
      );
      const data = await check.json();

      if (data.data?.status === "SUCCEEDED") {
        runFinished = true;
        runResult = data.data;
      } else if (["FAILED", "ABORTED", "TIMED-OUT"].includes(data.data?.status)) {
        return res.status(500).json({
          ok: false,
          message: "Actor falló",
          detail: data
        });
      }
    }

    // 3️⃣ Obtener dataset final
    const datasetId = runResult.defaultDatasetId;

    const itemsRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${token}`
    );
    const items = await itemsRes.json();

    // Normalización
    const normalized = items.map(i => ({
      postTitle: i.postTitle || "",
      text: i.text || "",
      likesCount: i.likesCount || 0,
      facebookUrl: facebookUrl
    }));

    // Guardar en Mongo si existe conexión
    if (mongoCollection) {
      await mongoCollection.insertOne({
        date: new Date(),
        facebookUrl,
        items: normalized
      });
    } else {
      console.log("⚠️ Mongo no conectado, no se guardó en DB.");
    }

    return res.json({ ok: true, normalized });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: "Error inesperado",
      detail: err.message
    });
  }
});

// --------------------------
// Último scrape almacenado
// --------------------------
app.get("/api/latest", requireLogin, async (req, res) => {
  try {
    if (!mongoCollection) {
      return res.json({ ok: true, normalized: [] });
    }

    const doc = await mongoCollection.findOne({}, { sort: { date: -1 } });
    if (!doc) return res.json({ ok: true, normalized: [] });

    return res.json({ ok: true, normalized: doc.items });

  } catch (err) {
    return res.status(500).json({ ok: false, message: "Error", detail: err });
  }
});

// --------------------------
// CSV Export
// --------------------------
app.get("/api/export-csv", requireLogin, async (req, res) => {
  try {
    if (!mongoCollection) {
      return res.status(400).send("Mongo no conectado");
    }

    const doc = await mongoCollection.findOne({}, { sort: { date: -1 } });
    if (!doc) return res.status(400).send("No hay datos");

    const parser = new Parser();
    const csv = parser.parse(doc.items);

    res.setHeader("Content-Disposition", "attachment; filename=data.csv");
    res.setHeader("Content-Type", "text/csv");
    return res.send(csv);

  } catch (err) {
    return res.status(500).send("Error exportando CSV");
  }
});

// --------------------------
// Servir frontend
// --------------------------
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor en puerto " + PORT));
