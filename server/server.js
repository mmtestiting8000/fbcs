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

// ---------- mongo ----------
let mongoClient = null;
let commentsCollection = null;
let mongoConnected = false;

async function tryConnectMongo() {
  if (!MONGODB_URI) {
    console.warn("⚠️ MONGODB_URI not provided.");
    return;
  }
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    commentsCollection = mongoClient.db(DB_NAME).collection(COLLECTION_NAME);
    mongoConnected = true;
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.warn("⚠️ MongoDB error:", err.message);
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

// UPDATED: ahora incluye profilePicture
function normalizeItem(i, fallbackUrl) {
  const profileId = i?.profileId ?? "";

  return {
    postTitle: i?.postTitle ?? "",
    text: i?.text ?? "",
    likesCount: String(i?.likesCount ?? 0),
    facebookUrl: i?.facebookUrl ?? fallbackUrl ?? "",
    profileId,
    profileName: i?.profileName ?? "",
    profilePicture: i?.profilePicture ?? "",
    profileUrl: profileId ? `https://facebook.com/${profileId}` : "",
  };
}

let LAST_NORMALIZED = [];

// ---------- auth ----------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.user = { username };
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: "Credenciales inválidas" });
});

function requireAuth(req, res, next) {
  if (req.session?.user?.username) return next();
  return res.status(401).json({ message: "No autorizado" });
}

// ---------- scrape endpoint ----------
app.post("/api/scrape", requireAuth, async (req, res) => {
  try {
    const input = req.body || {};
    const facebookUrl =
      input.startUrls?.[0]?.url || input.facebookUrl || "";

    const resultsLimit =
      Number(input.resultsLimit) ||
      Number(input.commentsCount) ||
      50;

    const includeNestedComments =
      input.includeNestedComments === true ||
      input.includeNestedComments === "true";

    const viewOption = input.viewOption || "RANKED_UNFILTERED";

    const token =
      String(input.apifyToken || APIFY_TOKEN_DEFAULT).trim();

    if (!isValidHttpUrl(facebookUrl)) {
      return res.status(400).json({ ok: false, message: "URL inválida" });
    }
    if (!token) {
      return res.status(400).json({ ok: false, message: "Token Apify faltante" });
    }

    const actorInput = {
      startUrls: [{ url: facebookUrl }],
      resultsLimit,
      includeNestedComments,
      viewOption,
    };

    const runSyncUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(
      ACTOR_ID
    )}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

    const apifyResp = await fetch(runSyncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actorInput),
    });

    const text = await apifyResp.text();
    let bodyJson = null;
    try {
      bodyJson = JSON.parse(text);
    } catch {}

    if (!apifyResp.ok) {
      return res.status(502).json({
        ok: false,
        message: "Error ejecutando el actor",
        status: apifyResp.status,
        apifyResponseText: text,
      });
    }

    let items = Array.isArray(bodyJson) ? bodyJson : [];

    const limited = items.slice(0, resultsLimit);

    const normalized = limited.map((x) =>
      normalizeItem(x, facebookUrl)
    );

    if (mongoConnected) {
      await commentsCollection.insertOne({
        createdAt: new Date(),
        facebookUrl,
        normalized,
      });
    }

    LAST_NORMALIZED = normalized;

    return res.json({ ok: true, normalized, rawCount: items.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- GET latest ----------
app.get("/api/latest", requireAuth, async (req, res) => {
  if (!mongoConnected) {
    return res.json({ ok: true, normalized: LAST_NORMALIZED });
  }

  const doc = await commentsCollection
    .find()
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  return res.json({
    ok: true,
    normalized: doc?.[0]?.normalized ?? LAST_NORMALIZED,
  });
});

// ---------- export CSV ----------
app.get("/api/export-csv", requireAuth, async (req, res) => {
  const rows =
    mongoConnected
      ? (await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray())?.[0]?.normalized ??
        LAST_NORMALIZED
      : LAST_NORMALIZED;

  const header = [
    "postTitle",
    "text",
    "likesCount",
    "facebookUrl",
    "profileName",
    "profileId",
    "profileUrl",
    "profilePicture",
  ];

  const escape = (s) =>
    `"${String(s ?? "").replace(/"/g, '""')}"`;

  let csv = header.join(",") + "\n";
  for (const r of rows) {
    csv += [
      escape(r.postTitle),
      escape(r.text),
      escape(r.likesCount),
      escape(r.facebookUrl),
      escape(r.profileName),
      escape(r.profileId),
      escape(r.profileUrl),
      escape(r.profilePicture),
    ].join(",") + "\n";
  }

  res.setHeader("Content-Disposition", "attachment; filename=latest_comments.csv");
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
