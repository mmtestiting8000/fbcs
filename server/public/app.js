const loginSection = document.getElementById('login-section');
const scraperSection = document.getElementById('scraper-section');
const loginBtn = document.getElementById('login-btn');
const loginMsg = document.getElementById('login-msg');

const scrapeBtn = document.getElementById('scrape-btn');
const scrapeMsg = document.getElementById('scrape-msg');
const exportBtn = document.getElementById('export-btn');
const resultsTableBody = document.querySelector('#results-table tbody');

// --- Login ---
loginBtn.addEventListener('click', async () => {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();
  if (data.ok) {
    loginSection.style.display = 'none';
    scraperSection.style.display = 'block';
    loadLatest();
  } else {
    loginMsg.textContent = data.message || 'Error de login';
  }
});

// --- Ejecutar Scraper ---
scrapeBtn.addEventListener('click', async () => {
  scrapeMsg.style.color = 'green';
  scrapeMsg.textContent = '';
  
  const facebookUrl = document.getElementById('facebookUrl').value;
  const commentsCount = document.getElementById('commentsCount').value;
  const apifyToken = document.getElementById('apifyToken').value;

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facebookUrl, commentsCount, apifyToken })
    });

    const data = await res.json();

    if (data.ok) {
      scrapeMsg.textContent = 'Scrape completado!';
      renderTable(data.normalized);
    } else {
      // Mostrar detalle del error
      scrapeMsg.style.color = 'red';
      console.error('Error de Apify:', data.detail || data.message);
      scrapeMsg.textContent = `Error al ejecutar actor: ${data.detail || data.message}`;
    }
  } catch (err) {
    scrapeMsg.style.color = 'red';
    console.error('Error inesperado:', err);
    scrapeMsg.textContent = `Error inesperado: ${err.message}`;
  }
});

// --- Exportar CSV ---
exportBtn.addEventListener('click', () => {
  window.location.href = '/api/export-csv';
});

// --- Cargar última instancia ---
async function loadLatest() {
  const res = await fetch('/api/latest');
  const data = await res.json();
  if (data.ok) {
    renderTable(data.normalized);
  }
}

// --- Renderizar tabla ---
function renderTable(items) {
  resultsTableBody.innerHTML = '';
  items.forEach(it => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${it.postTitle || ''}</td>
      <td>${it.text || ''}</td>
      <td>${it.likesCount || 0}</td>
      <td><a href="${it.facebookUrl}" target="_blank">Link</a></td>
    `;
    resultsTableBody.appendChild(tr);
  });
}
