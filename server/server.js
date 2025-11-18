app.post("/api/scrape", async (req, res) => {
  const { facebookUrl, commentsCount, apifyToken } = req.body;

  console.log("📌 /api/scrape ejecutado");
  console.log("➡ URL:", facebookUrl);
  console.log("➡ commentsCount:", commentsCount);
  console.log("➡ Token recibido:", apifyToken ? "SÍ" : "NO");
  console.log("➡ Token default en entorno:", process.env.APIFY_TOKEN_DEFAULT ? "SÍ" : "NO");

  try {
    const tokenToUse = apifyToken || process.env.APIFY_TOKEN_DEFAULT;

    if (!tokenToUse) {
      console.log("❌ ERROR: No hay token de Apify disponible");
      return res.json({ ok: false, message: "No token provided" });
    }

    console.log("🔄 Iniciando ejecución del actor en Apify...");

    const actorPayload = {
      runInput: {
        startUrls: [{ url: facebookUrl }],
        resultsLimit: parseInt(commentsCount) || 50
      }
    };

    console.log("➡ Payload enviado al actor:", actorPayload);

    const actorResponse = await fetch("https://api.apify.com/v2/acts/apify~facebook-scraper/runs?token=" + tokenToUse, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actorPayload)
    });

    console.log("📥 Respuesta HTTP status:", actorResponse.status);

    const actorData = await actorResponse.json();
    console.log("📥 Respuesta completa del actor:", actorData);

    if (!actorResponse.ok) {
      console.error("❌ La API de Apify regresó error");
      return res.json({ ok: false, message: actorData.error || "Error desconocido al iniciar actor" });
    }

    const runId = actorData.data.id;
    console.log("✅ Actor iniciado correctamente, runId:", runId);

    // Esperar a que finalice
    let finished = false;
    let runData = null;

    console.log("🔄 Esperando que termine el actor...");

    while (!finished) {
      const runStatusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${tokenToUse}`);
      runData = await runStatusRes.json();
      console.log("📡 Estado actor:", runData.data.status);

      if (["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"].includes(runData.data.status)) {
        finished = true;
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (runData.data.status !== "SUCCEEDED") {
      console.log("❌ El actor terminó en estado:", runData.data.status);
      return res.json({ ok: false, message: "El actor no terminó correctamente." });
    }

    console.log("✅ Actor terminó correctamente. Obteniendo dataset...");

    const datasetId = runData.data.defaultDatasetId;
    console.log("➡ Dataset ID:", datasetId);

    const datasetRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&format=json&token=${tokenToUse}`);
    const dataset = await datasetRes.json();

    console.log("📦 Datos obtenidos del dataset (primeros 3):", dataset.slice(0, 3));

    const normalized = dataset.map(item => ({
      postTitle: item?.post?.title || "",
      text: item?.text || "",
      likesCount: item?.likesCount || 0,
      facebookUrl: item?.url || ""
    }));

    console.log("📌 Normalized (primeros 3):", normalized.slice(0, 3));

    LAST_DATA = normalized;

    return res.json({ ok: true, normalized });

  } catch (err) {
    console.error("🔥 ERROR CRÍTICO EN SCRAPER:", err);
    return res.json({ ok: false, message: err.message || "Error inesperado" });
  }
});
