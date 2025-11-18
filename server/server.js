import express from "express";
import cors from "cors";
import session from "express-session";
import fetch from "node-fetch";      
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { Parser } from "json2csv";

dotenv.config();

// ------------------------------------
// PATHS
// ------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------------
// VARIABLES DE ENTORNO
// ------------------------------------
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL; // Render env variable

// ------------------------------------
// APP
// ------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// Sesiones simples (NO usar MemoryStore en producción, pero Render solo tiene 1 instancia)
app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecret",
    resave: false,
    saveUninitialized: false,
  })
);

// ------------------------------------
// CONEXIÓN MONGO (OPCIONAL)
// ------------------------------------
let db = null;

async function connectDb() {
  try {
    if (!MONGO_URL) {
      console.log("⚠️  No hay MONGO_URL. El servidor funcionará sin DB.");
      return;
    }

    const client = new MongoClient(MONGO_URL);
    await client.connect();
    db = client.db();
    console.log("Mongo conectado ✔️");
  } catch (err) {
    console.log("⚠️  No se pudo conectar a Mongo, el server seguirá funcionando.");
    console.error(err.message);
    db = null; // evita crash
  }
}

await connectDb();

// ------------------------------------
// LOGIN SIMPLE ADMIN
// ------------------------------------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username === (process.env.ADMIN_USER || "admin") &&
    password === (process.env.ADMIN_PASS || "1234")
  ) {
    req.session.auth = true;
    return res.json({ ok: true });
  }

  return res.json({ ok: false, message: "Credenciales incorrectas" });
});

// Middleware de auth
function auth(req, res, next) {
  if (req.session.auth) return next();
  return res.status(401).json({ ok: false, message: "No autorizado" });
}

// ------------------------------------
// SCRAPER: Apify Actor OR fallback
// ------------------------------------
app.post("/api/scrape", auth, async (req, res) => {
  const { facebookUrl, commentsCount, apifyToken } = req.body;

  if (!facebookUrl) {
    return res.json({ ok: false, message: "URL requerida" });
  }

  try {
    console.log("Scraper solicitado:", facebookUrl);

    let finalData = [];

    if (apifyToken) {
      console.log("Usando Apify Actor…");

      const run = await fetch(
        `https://api.apify.com/v2/acts/apify~facebook-comments-scraper/run?token=${apifyToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startUrls: [{ url: facebookUrl }],
            resultsLimit: Number(commentsCount) || 50,
          }),
        }
      );

      const json = await run.json();

      if (!json.data?.defaultDatasetId) {
        return res.json({
          ok: false,
          message: "Error en Apify Actor (dataset no encontrado)",
        });
      }

      const datasetId = json.data.defaultDatasetId;
      const datasetRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`
      );
      finalData = await datasetRes.json();
    } else {
      console.log("No Token. Usando scraper interno básico…");

      finalData = [
        {
          postTitle: "Demo sin Apify",
          text: "Necesitas token Apify para comentarios reales.",
          likesCount: 0,
          facebookUrl,
        },
      ];
    }

    // Normalización para la tabla
    const normalized = finalData.map((it) => ({
      postTitle: it.postTitle || it.title || "",
      text: it.text || it.comment || "",
      likesCount: it.likesCount || it.likes || 0,
      facebookUrl: it.url || facebookUrl,
    }));

    // Guardar en Mongo opcional
    if (db) {
      await db.collection("results").insertOne({
        createdAt: new Date(),
        normalized,
      });
    } else {
      console.log("⚠️  Mongo no está conectado, no se guardó el resultado.");
    }

    return res.json({ ok: true, normalized });
  } catch (err) {
    console.error("Error en scraper:", err);
    return res.json({ ok: false, message: "Error inesperado" });
  }
});

// ------------------------------------
// OBTENER ÚLTIMO RESULTADO GUARDADO
// ------------------------------------
app.get("/api/latest", auth, async (req, res) => {
  if (!db) {
    return res.json({
      ok: true,
      normalized: [],
      message: "Mongo no conectado (modo simple)",
    });
  }

  const last = await db
    .collection("results")
    .find({})
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  return res.json({ ok: true, normalized: last[0]?.normalized || [] });
});

// ------------------------------------
// EXPORTAR CSV
// ------------------------------------
app.get("/api/export-csv", auth, async (req, res) => {
  if (!db) {
    return res.send("Mongo no conectado, no hay nada que exportar.");
  }

  const last = await db
    .collection("results")
    .find({})
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  const normalized = last[0]?.normalized || [];

  const parser = new Parser();
  const csv = parser.parse(normalized);

  res.setHeader("Content-Disposition", "attachment; filename=export.csv");
  res.set("Content-Type", "text/csv");
  res.send(csv);
});

// ------------------------------------
// SERVIR FRONTEND
// ------------------------------------
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// ------------------------------------
// INICIAR SERVER
// ------------------------------------
app.listen(PORT, () => {
  console.log(`Servidor online en puerto ${PORT}`);
});
