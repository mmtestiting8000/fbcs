// ---------------------------
// IMPORTS
// ---------------------------
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// ---------------------------
// APP BASE
// ---------------------------
const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------
// LOGIN ADMIN
// ---------------------------

// Si no existen variables en Render, se usan valores de prueba.
// Puedes cambiarlos en "Environment Variables" de Render.
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "1234";

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;

    console.log("🔐 Intento de login:", username);

    if (username === ADMIN_USER && password === ADMIN_PASS) {
        console.log("✔️ Login correcto");
        return res.json({ ok: true });
    }

    console.log("❌ Login inválido");
    return res.json({ ok: false, message: "Usuario o contraseña incorrectos" });
});

// ---------------------------
// MONGO CONNECTION
// ---------------------------
let collection = null;
let mongoConnected = false;

async function connectDB() {
    try {
        const client = new MongoClient(process.env.MONGODB_URI);
        await client.connect();
        const db = client.db("fb-scraper");
        collection = db.collection("results");
        mongoConnected = true;
        console.log("MongoDB conectado correctamente.");
    } catch (err) {
        console.error("⚠️ No se pudo conectar con MongoDB:", err.message);
        mongoConnected = false;
    }
}

await connectDB();

// ---------------------------
// VARIABLES EN MEMORIA
// ---------------------------
let LAST_DATA = [];

// ---------------------------
// SCRAPER ENDPOINT
// ---------------------------
app.post("/api/scrape", async (req, res) => {
    console.log("📥 /api/scrape llamado con:", req.body);

    const { facebookUrl, commentsCount, apifyToken } = req.body;
    const token = apifyToken || process.env.APIFY_TOKEN_DEFAULT;

    if (!facebookUrl) {
        return res.json({ ok: false, message: "Falta facebookUrl" });
    }

    try {
        console.log("🔵 Ejecutando actor Apify con token:", token);

        const run = await fetch(
            `https://api.apify.com/v2/actor-tasks/FB-COMMENTS-SCRAPER/run-sync?token=${token}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    startUrls: [{ url: facebookUrl }],
                    maxComments: Number(commentsCount) || 50
                })
            }
        );

        console.log("📡 Respuesta Apify status:", run.status);

        if (!run.ok) {
            const textErr = await run.text();
            console.error("❌ Error completo de Apify:", textErr);
            return res.json({
                ok: false,
                message: "Apify devolvió un error (ver logs en servidor)."
            });
        }

        const apifyData = await run.json();
        console.log("📦 Apify JSON recibido:", apifyData);

        const items = apifyData?.data?.map?.(i => ({
            postTitle: i?.postTitle || "",
            text: i?.text || "",
            likesCount: i?.likesCount || 0,
            facebookUrl: i?.url || facebookUrl
        })) || [];

        LAST_DATA = items;

        if (mongoConnected) {
            await collection.insertOne({
                createdAt: new Date(),
                facebookUrl,
                commentsCount,
                results: items
            });
        } else {
            console.log("⚠️ Mongo no conectado, guardando solo en memoria.");
        }

        return res.json({ ok: true, normalized: items });

    } catch (err) {
        console.error("🔥 ERROR EN SCRAPER:", err);
        return res.json({ ok: false, message: "Error interno en el scraper." });
    }
});

// ---------------------------
// OBTENER ÚLTIMA EJECUCIÓN
// ---------------------------
app.get("/api/latest", async (req, res) => {
    if (mongoConnected) {
        const last = await collection
            .find({})
            .sort({ createdAt: -1 })
            .limit(1)
            .toArray();

        if (last.length > 0) {
            return res.json({ ok: true, normalized: last[0].results });
        }
    }

    return res.json({ ok: true, normalized: LAST_DATA });
});

// ---------------------------
// EXPORT CSV
// ---------------------------
app.get("/api/export-csv", (req, res) => {
    let csv = "postTitle,text,likesCount,facebookUrl\n";

    LAST_DATA.forEach(row => {
        csv += `"${row.postTitle.replace(/"/g, "'")}","${row.text.replace(/"/g, "'")}",${row.likesCount},"${row.facebookUrl}"\n`;
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=export.csv");
    res.send(csv);
});

// ---------------------------
// SERVIR FRONTEND
// ---------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------
// PORT
// ---------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor iniciado en puerto", PORT));
