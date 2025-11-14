import express from 'express';
if (!runResp.ok) {
const txt = await runResp.text();
return res.status(502).json({ ok: false, message: 'Error al ejecutar actor', detail: txt });
}


// La respuesta del run-sync devuelve el OUTPUT del actor en el cuerpo
const runOutput = await runResp.json();


// Según la mayoría de actors, output puede contener array de items o dataset
// Vamos a intentar extraer items en runOutput.items o runOutput.defaultKeyValueStore
let items = [];
if (Array.isArray(runOutput)) items = runOutput;
else if (Array.isArray(runOutput.items)) items = runOutput.items;
else if (Array.isArray(runOutput.output)) items = runOutput.output;
else if (runOutput && runOutput.content && Array.isArray(runOutput.content)) items = runOutput.content;
else {
// fallback: intentar obtener dataset vía endpoint /runs/last/dataset/items
try {
const actorPrefix = `https://api.apify.com/v2/acts/${actorId}/runs/last/dataset/items?token=${encodeURIComponent(token)}`;
const ds = await fetch(actorPrefix);
if (ds.ok) items = await ds.json();
} catch (e) {
console.warn('No se pudo obtener dataset via /runs/last/dataset/items', e.message);
}
}


// Normalizar y guardar en Mongo: cada comment -> { postTitle, text, likesCount, facebookUrl }
const normalized = [];
for (const it of items) {
normalized.push({
postTitle: it.postTitle || it.post_title || it.title || '',
text: it.text || it.comment || it.message || '',
likesCount: String(it.likesCount ?? it.likes ?? it.reactions ?? 0),
facebookUrl: it.facebookUrl || it.postUrl || facebookUrl
});
}


const doc = {
createdAt: new Date(),
facebookUrl,
commentsCount: Number(commentsCount) || normalized.length,
apifyTokenUsed: token ? 'provided' : 'none',
rawItems: items,
normalized
};


await commentsCollection.insertOne(doc);


// Respondemos con la última instancia normalizada (para mostrar en la tabla)
return res.json({ ok: true, normalized });


} catch (err) {
console.error(err);
return res.status(500).json({ ok: false, message: 'Error interno', error: err.message });
}
});


// Obtener la última instancia (para mostrar en la UI) - solo devuelve la última ejecución
app.get('/api/latest', requireAuth, async (req, res) => {
const last = await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray();
if (!last || last.length === 0) return res.json({ ok: true, normalized: [] });
return res.json({ ok: true, normalized: last[0].normalized, createdAt: last[0].createdAt });
});


// Exportar la última instancia a CSV
app.get('/api/export-csv', requireAuth, async (req, res) => {
const last = await commentsCollection.find().sort({ createdAt: -1 }).limit(1).toArray();
if (!last || last.length === 0) return res.status(404).send('No hay datos para exportar');
const rows = last[0].normalized || [];
const csv = stringify(rows, { header: true });
res.setHeader('Content-disposition', 'attachment; filename=latest_comments.csv');
res.setHeader('Content-Type', 'text/csv');
res.send(csv);
});


// Inicio del servidor
connectDb().then(() => {
app.listen(PORT, () => console.log(`Server escuchando en http://localhost:${PORT}`));
}).catch(err => {
console.error('No se pudo conectar con DB', err);
});
