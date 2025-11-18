// Simple UI interactions + validations
const loginSection = document.getElementById("login-section");
const scraperSection = document.getElementById("scraper-section");
const loginMsg = document.getElementById("login-msg");
const scrapeMsg = document.getElementById("scrape-msg");
const resultsTableBody = document.querySelector("#results-table tbody");

// login
document.getElementById("login-btn").addEventListener("click", async () => {
  loginMsg.textContent = "";
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  if (!username || !password) {
    loginMsg.textContent = "Usuario y contraseña requeridos";
    return;
  }

  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  const j = await res.json();
  if (j.ok) {
    loginSection.style.display = "none";
    scraperSection.style.display = "block";
    loadLatest();
  } else {
    loginMsg.textContent = j.message || "Error de login";
  }
});

// scrape
document.getElementById("scrape-btn").addEventListener("click", async () => {
  scrapeMsg.style.color = "black";
  scrapeMsg.textContent = "Iniciando...";
  const facebookUrl = document.getElementById("facebookUrl").value.trim();
  const resultsLimit = Number(document.getElementById("resultsLimit").value) || 50;
  const includeNestedComments = document.getElementById("includeNestedComments").checked;
  const viewOption = document.getElementById("viewOption").value;
  const apifyToken = document.getElementById("apifyToken").value.trim();

  // basic validation
  if (!facebookUrl) {
    scrapeMsg.style.color = "red";
    scrapeMsg.textContent = "Introduce la URL del post de Facebook.";
    return;
  }
  if (!/^https?:\/\//i.test(facebookUrl)) {
    scrapeMsg.style.color = "red";
    scrapeMsg.textContent = "URL inválida (debe incluir http/https).";
    return;
  }
  if (resultsLimit <= 0 || resultsLimit > 5000) {
    scrapeMsg.style.color = "red";
    scrapeMsg.textContent = "resultsLimit debe ser entre 1 y 5000.";
    return;
  }

  try {
    const body = {
      facebookUrl,
      resultsLimit,
      includeNestedComments,
      viewOption,
      apifyToken: apifyToken || undefined,
    };

    const resp = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (data.ok) {
      scrapeMsg.style.color = "green";
      scrapeMsg.textContent = `Scrape completado — ${data.normalized?.length || 0} comentarios (raw: ${data.rawCount || "-"})`;
      renderTable(data.normalized || []);
    } else {
      scrapeMsg.style.color = "red";
      const msg = data.message || data.apifyResponseText || JSON.stringify(data.apifyResponseJson) || "Error al scrapear";
      scrapeMsg.textContent = msg;
      console.error("Scrape error:", data);
    }
  } catch (err) {
    scrapeMsg.style.color = "red";
    scrapeMsg.textContent = "Error de conexión: " + err.message;
  }
});

// load latest
async function loadLatest() {
  try {
    const res = await fetch("/api/latest");
    const j = await res.json();
    if (j.ok) renderTable(j.normalized || []);
  } catch (err) { console.warn("Error loading latest:", err); }
}

// export CSV button
document.getElementById("export-btn").addEventListener("click", () => {
  window.location.href = "/api/export-csv";
});

// render
function renderTable(items) {
  resultsTableBody.innerHTML = "";
  if (!items || items.length === 0) {
    resultsTableBody.innerHTML = "<tr><td colspan='4'>No hay datos</td></tr>";
    return;
  }

  items.forEach(it => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(it.postTitle)}</td>
      <td>${escapeHtml(it.text)}</td>
      <td>${escapeHtml(it.likesCount)}</td>
      <td><a href="${escapeAttr(it.facebookUrl)}" target="_blank">Abrir</a></td>
    `;
    resultsTableBody.appendChild(tr);
  });
}

function escapeHtml(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "%22");
}
