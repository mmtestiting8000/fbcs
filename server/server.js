import express from "express";
import cors from "cors";
import session from "express-session";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// -------------------- config --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const ACTOR_ID = process.env.ACTOR_ID || "us5srxAYnsrkgUv2v"; // your actor id
const APIFY_TOKEN_DEFAULT = process.env.APIFY_TOKEN_DEFAULT || "";
const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.DB_NAME || "fb_scraper";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "comments";
const SESSION_SECRET = process.env.SESSION_SECRET || "change_this";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "Cortes0202";

// -------------------- app --------------------
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

// -------------------- mongo (optional, non-fatal) --------------------
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

// -------------------- helpers --------------------
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
    facebookUrl: i?.facebookUrl ?? i?.facebook_url ?? i?.url ?? fallbackUrl ?? "",
  };
}

// Keep last result in memory as fallback when Mongo isn't available
let LAST_NORMALIZED = [];

// -------------------- auth --------------------
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

// -------------------- scrape endpoint --------------------
app.post("/api/scrape", requireAuth, async (req, res) => {
  const input = req.body || {};
  console.log("📥 /api/scrape called with:", input);

  const facebookUrl = input.facebookUrl || input.startUrl || "";
  const resultsLimit = Number(input.resultsLimit ?? input.resultsLimit ?? input.resultsLimit ?? input.resultsLimit) || Number(input.resultsLimit) || Number(input.resultsLimit) || Number(input.resultsLimit) || Number(input.resultsLimit) || Number(input.commentsCount) || 50;
  // We accept either resultsLimit or commentsCount (backwards compat). Prefer resultsLimit.
  const token = (input.apifyToken && String(input.apifyToken).trim()) || APIFY_TOKEN_DEFAULT;
  const includeNestedComments = !!input.includeNestedComments;
  const viewOption = input.viewOption || "RANKED_UNFILTERED";

  // Validate
  if (!facebookUrl || !isValidHttpUrl(facebookUrl)) {
    return res.status(400).json({ ok: false, message: "facebookUrl inválida o faltante" });
  }
  if (!token) {
    return res.status(400).json({ ok: false, message: "No hay token de Apify configurado (ni en la petición ni en APIFY_TOKEN_DEFAULT)" });
  }
  if (resultsLimit <= 0 || resultsLimit > 5000) {
    return res.status(400).json({ ok: false, message: "resultsLimit debe ser 1..5000" });
  }

  // Build actor input exactly as your actor expects
  const actorInput = {
    startUrls: [{ url: facebookUrl }],
    resultsLimit: resultsLimit,
    includeNestedComments: includeNestedComments,
    viewOption: viewOption,
  };

  console.log("➡ Sending to Apify actorId:", ACTOR_ID, "payload:", actorInput);

  const runSyncUrl = `https://api.apify.com/v2/actors/${encodeURIComponent(ACTOR_ID)}/run-sync?token=${encodeURIComponent(token)}`;

  try {
    const resp = await fetch(runSyncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actorInput),
      // no credentials required
    });

    console.log("📡 Apify HTTP status:", resp.status);

    const bodyText = await resp.text().catch(() => "");
    let bodyJson = null;
    try { bodyJson = bodyText ? JSON.parse(bodyText) : null; } catch (e) { /* not JSON */ }

    if (!resp.ok) {
      console.error("❌ Apify run-sync returned non-ok:", resp.status, bodyText);
      return res.status(502).json({
        ok: false,
        message: "Error al ejecutar actor en Apify",
        status: resp.status,
        apifyResponseText: bodyText,
        apifyResponseJson: bodyJson,
      });
    }

    // resp.ok -> bodyJson should contain output (items or dataset). Try to extract items.
    let items = [];

    // Common patterns:
    //  - run-sync returns an array of items directly (bodyJson is array)
    //  - or bodyJson.output or bodyJson.items
    if (Array.isArray(bodyJson)) items = bodyJson;
    else if (Array.isArray(bodyJson?.items)) items = bodyJson.items;
    else if (Array.isArray(bodyJson?.output)) items = bodyJson.output;
    else if (Array.isArray(bodyJson?.result)) items = bodyJson.result;
    // fallback: some actors put results in bodyJson.defaultDatasetId -> fetch dataset
    else if (bodyJson?.defaultDatasetId || bodyJson?.data?.defaultDatasetId) {
      const datasetId = bodyJson.defaultDatasetId || bodyJson.data.defaultDatasetId;
      try {
        const dsUrl = `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(token)}&format=json&clean=true`;
        console.log("➡ Fetching dataset items from:", dsUrl);
        const dsResp = await fetch(dsUrl);
        if (dsResp.ok) items = await dsResp.json();
        else {
          console.warn("⚠️ Could not fetch dataset items, status:", dsResp.status);
        }
      } catch (err) {
        console.warn("⚠️ Error fetching dataset items:", err.message);
      }
    } else {
      // As a last attempt, try bodyJson.data or bodyJson.output?.items
      if (Array.isArray(bodyJson?.data)) items = bodyJson.data;
      else if (Array.isArray(bodyJson?.output?.items)) items = bodyJson.output.items;
    }

    console.log("ℹ️ Items extracted count before limiting:", items.length);

    // Limit server-side (Apify might return more)
    const limited = items.slice(0, resultsLimit);

    // Normalize items into the shape you provided
    const normalized = limited.map(it => normalizeItem(it, facebookUrl));

    // Save in Mongo if connected (store full normalized)
    if (mongoConnected && commentsCollection) {
      try {
        await commentsCollection.insertOne({
          createdAt: new Date(),
          facebookUrl,
          actorId: ACTOR_ID,
          actorInput,
          resultsLimit,
          includeNestedComments,
          viewOption,
          rawItemsCount: items.length,
          normalized
        });
        console.log("💾 Saved results to Mongo");
      } catch (err) {
        console.warn("⚠️ Failed to write to Mongo:", err.message);
      }
    } else {
      console.log("⚠️ Mongo not connected, skipping DB write");
    }

    // store last
    LAST_NORMALIZED = normalized;

    return res.json({ ok: true, normalized, rawCount: items.length });

  } catch (err) {
    console.error("🔥 Unexpected error calling Apify:", err);
    return res.status(500).json({ ok: false, message: "Error interno", detail: err.message });
  }
});

// -------------------- get latest --------------------
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

// -------------------- export CSV --------------------
app.get("/api/export-csv", requireAuth, async (req, res) => {
  const rows = (mongoConnected && commentsCollection)
    ? (await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray())?.[0]?.normalized ?? LAST_NORMALIZED
    : LAST_NORMALIZED;

  if (!rows || rows.length === 0) {
    return res.status(404).send("No hay datos para exportar");
  }

  // Build CSV manually and stream
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

// -------------------- serve frontend fallback --------------------
app.get("*", (req, res) => {
  // let static middleware handle files first; fallback to index.html
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -------------------- start --------------------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
