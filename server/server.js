import express from "express";
import cors from "cors";
import session from "express-session";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// ---------- config ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ACTOR_ID = process.env.ACTOR_ID || "apify~facebook-comments-scraper";
const APIFY_TOKEN_DEFAULT = process.env.APIFY_TOKEN_DEFAULT || "";
const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.DB_NAME || "fb_scraper";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "comments";
const SESSION_SECRET = process.env.SESSION_SECRET || "change_this";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "Cortes0202";

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  })
);

// serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// ---------- mongo (optional non-fatal) ----------
let mongoClient = null;
let commentsCollection = null;
let mongoConnected = false;

async function tryConnectMongo() {
  if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI not provided. Running without DB.");
    return;
  }
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db(DB_NAME);
    commentsCollection = db.collection(COLLECTION_NAME);
    mongoConnected = true;
    console.log("✅ Connected to MongoDB:", DB_NAME, COLLECTION_NAME);
  } catch (err) {
    mongoConnected = false;
    console.warn("⚠️ Could not connect to MongoDB:", err.message);
  }
}
await tryConnectMongo();

// ---------- helpers ----------
function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeItem(i, fallbackUrl) {
  return {
    postTitle: i?.postTitle ?? i?.post_title ?? i?.title ?? "",
    text: i?.text ?? i?.comment ?? i?.message ?? "",
    likesCount: String(i?.likesCount ?? i?.likes ?? i?.reactions ?? 0),
    facebookUrl:
      i?.facebookUrl ?? i?.facebook_url ?? i?.postUrl ?? i?.url ?? fallbackUrl ?? "",
  };
}

// keep last result in memory if mongo is not available
let LAST_NORMALIZED = [];

// ---------- auth ----------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  console.log("🔐 Login attempt:", username);
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.user = { username };
    console.log("✔️ Login success:", username);
    return res.json({ ok: true });
  }
  console.log("❌ Login failed for:", username);
  return res.status(401).json({ ok: false, message: "Credenciales inválidas" });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.user && req.session.user.username) return next();
  return res.status(401).json({ ok: false, message: "No autorizado" });
}

// ---------- scrape endpoint (uses run-sync-get-dataset-items) ----------
app.post("/api/scrape", requireAuth, async (req, res) => {
  const input = req.body || {};
  console.log("📥 /api/scrape called with:", input);

  const facebookUrl = (input.startUrls && input.startUrls[0]?.url) || input.facebookUrl || "";
  // Accept both resultsLimit (preferred) or backwards-compatible commentsCount
  const resultsLimit = Number(input.resultsLimit ?? input.resultsLimit) || Number(input.commentsCount) || 50;
  const includeNestedComments = input.includeNestedComments === true || input.includeNestedComments === "true";
  const viewOption = input.viewOption || "RANKED_UNFILTERED";
  const token = (input.apifyToken && String(input.apifyToken).trim()) || APIFY_TOKEN_DEFAULT;

  // validations
  if (!facebookUrl || !isValidHttpUrl(facebookUrl)) {
    return res.status(400).json({ ok: false, message: "facebookUrl inválida o faltante" });
  }
  if (!token) {
    return res.status(400).json({ ok: false, message: "No hay token de Apify configurado" });
  }
  if (!Number.isFinite(resultsLimit) || resultsLimit <= 0 || resultsLimit > 5000) {
    return res.status(400).json({ ok: false, message: "resultsLimit debe ser entre 1 y 5000" });
  }

  const actorInput = {
    startUrls: [{ url: facebookUrl }],
    resultsLimit,
    includeNestedComments,
    viewOption,
  };

  console.log("➡ Sending to Apify actorId:", ACTOR_ID, "payload:", actorInput);

  const runSyncUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  try {
    const resp = await fetch(runSyncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actorInput),
    });

    console.log("📡 Apify HTTP status:", resp.status);

    const text = await resp.text().catch(() => "");
    let bodyJson = null;
    try { bodyJson = text ? JSON.parse(text) : null; } catch(e) { /* ignore */ }

    if (!resp.ok) {
      console.error("❌ Apify run returned non-ok:", resp.status, text);
      return res.status(502).json({
        ok: false,
        message: "Error al ejecutar actor en Apify",
        status: resp.status,
        apifyResponseText: text,
        apifyResponseJson: bodyJson,
      });
    }

    // The run-sync-get-dataset-items returns dataset items (array) when successful
    let items = [];
    if (Array.isArray(bodyJson)) items = bodyJson;
    else if (Array.isArray(bodyJson?.items)) items = bodyJson.items;
    else if (Array.isArray(bodyJson?.result)) items = bodyJson.result;
    else if (Array.isArray(bodyJson?.data)) items = bodyJson.data;
    else {
      // If weird format, try to extract dataset via defaultDatasetId
      const maybeDefaultDatasetId = bodyJson?.defaultDatasetId || bodyJson?.data?.defaultDatasetId;
      if (maybeDefaultDatasetId) {
        try {
          const dsUrl = `https://api.apify.com/v2/datasets/${encodeURIComponent(maybeDefaultDatasetId)}/items?token=${encodeURIComponent(token)}&format=json&clean=true`;
          console.log("➡ Fetching dataset fallback from:", dsUrl);
          const dsResp = await fetch(dsUrl);
          if (dsResp.ok) items = await dsResp.json();
          else console.warn("⚠️ Dataset fetch failed status:", dsResp.status);
        } catch (err) {
          console.warn("⚠️ Error fetching dataset fallback:", err.message);
        }
      }
    }

    console.log("ℹ️ Items extracted count before limiting:", items.length);

    // enforce server-side limit (Apify might ignore/more)
    const limited = items.slice(0, resultsLimit);

    const normalized = limited.map(it => normalizeItem(it, facebookUrl));

    // Save to Mongo if connected (store complete normalized)
    if (mongoConnected && commentsCollection) {
      try {
        await commentsCollection.insertOne({
          createdAt: new Date(),
          actorId: ACTOR_ID,
          facebookUrl,
          actorInput,
          resultsLimit,
          includeNestedComments,
          viewOption,
          rawCount: items.length,
          normalized
        });
        console.log("💾 Saved results to Mongo");
      } catch (err) {
        console.warn("⚠️ Failed to write to Mongo:", err.message);
      }
    } else {
      console.log("⚠️ Mongo not connected, skipping DB write");
    }

    LAST_NORMALIZED = normalized;

    return res.json({ ok: true, normalized, rawCount: items.length });

  } catch (err) {
    console.error("🔥 Unexpected error calling Apify:", err);
    return res.status(500).json({ ok: false, message: "Error interno", detail: err.message });
  }
});

// ---------- GET latest ----------
app.get("/api/latest", requireAuth, async (req, res) => {
  if (mongoConnected && commentsCollection) {
    try {
      const lastDoc = await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray();
      const normalized = lastDoc?.[0]?.normalized ?? LAST_NORMALIZED;
      return res.json({ ok: true, normalized });
    } catch (err) {
      console.warn("⚠️ Error reading latest from Mongo:", err.message);
      return res.json({ ok: true, normalized: LAST_NORMALIZED, warning: "Error reading DB" });
    }
  }
  return res.json({ ok: true, normalized: LAST_NORMALIZED, warning: "Mongo not connected" });
});

// ---------- export CSV ----------
app.get("/api/export-csv", requireAuth, async (req, res) => {
  const rows = (mongoConnected && commentsCollection)
    ? (await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray())?.[0]?.normalized ?? LAST_NORMALIZED
    : LAST_NORMALIZED;

  if (!rows || rows.length === 0) {
    return res.status(404).send("No hay datos para exportar");
  }

  const header = ["postTitle", "text", "likesCount", "facebookUrl"];
  const escape = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

  let csv = header.join(",") + "\n";
  for (const r of rows) {
    csv += [escape(r.postTitle), escape(r.text), escape(r.likesCount), escape(r.facebookUrl)].join(",") + "\n";
  }

  res.setHeader("Content-Disposition", "attachment; filename=latest_comments.csv");
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

// ---------- serve frontend fallback ----------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
