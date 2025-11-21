const loginSection = document.getElementById("login-section");
const scraperSection = document.getElementById("scraper-section");
const loginMsg = document.getElementById("login-msg");
const scrapeMsg = document.getElementById("scrape-msg");
const resultsTableBody = document.querySelector("#results-table tbody");

// LOGIN
document.getElementById("login-btn").addEventListener("click", async () => {
  loginMsg.textContent = "";
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json();

  if (j.ok) {
    loginSection.style.display = "none";
    scraperSection.style.display = "block";
    loadLatest();
  } else loginMsg.textContent = j.message;
});

// SCRAPE
document.getElementById("scrape-btn").addEventListener("click", async () => {
  scrapeMsg.textContent = "Procesando...";
  const body = {
    startUrls: [{ url: document.getElementById("facebookUrl").value.trim() }],
    resultsLimit: Number(document.getElementById("resultsLimit").value) || 50,
    includeNestedComments: document.getElementById("includeNestedComments").checked,
    viewOption: document.getElementById("viewOption").value,
    apifyToken: document.getElementById("apifyToken").value.trim(),
  };

  const resp = await fetch("/api/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!data.ok) {
    scrapeMsg.textContent = "Error: " + (data.message || "");
    return;
  }

  scrapeMsg.textContent = "Listo — " + data.normalized.length;
  renderTable(data.normalized);
});

// LOAD LATEST
async function loadLatest() {
  const r = await fetch("/api/latest");
  const j = await r.json();
  if (j.ok) renderTable(j.normalized);
}

// CSV
document.getElementById("export-btn").addEventListener("click", () => {
  window.location.href = "/api/export-csv";
});

// RENDER TABLE (UPDATED)
function renderTable(items) {
  resultsTableBody.innerHTML = "";

  if (!items.length) {
    resultsTableBody.innerHTML = `<tr><td colspan="6">Sin datos</td></tr>`;
    return;
  }

  items.forEach((it) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(it.postTitle)}</td>
      <td>${escapeHtml(it.text)}</td>
      <td>${escapeHtml(it.likesCount)}</td>
      <td>${escapeHtml(it.profileName)}</td>
      <td>${escapeHtml(it.profileId)}</td>
      <td>
        ${it.profileUrl ? `<a href="${escapeAttr(it.profileUrl)}" target="_blank">Perfil</a>` : ""}
      </td>
    `;
    resultsTableBody.appendChild(tr);
  });
}

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}
function escapeAttr(s) {
  return String(s).replace(/"/g, "%22");
}
