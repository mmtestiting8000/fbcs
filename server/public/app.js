const loginSection = document.getElementById('login-section');
const scraperSection = document.getElementById('scraper-section');
const resultsTableBody = document.querySelector('#results-table tbody');

document.getElementById('login-btn').addEventListener('click', async () => {
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
    document.getElementById('login-msg').textContent = data.message;
  }
});

document.getElementById('scrape-btn').addEventListener('click', async () => {
  const facebookUrl = document.getElementById('facebookUrl').value;
  const commentsCount = document.getElementById('commentsCount').value;
  const apifyToken = document.getElementById('apifyToken').value;

  const msg = document.getElementById('scrape-msg');
  msg.textContent = "Procesando scraper...";

  const res = await fetch('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facebookUrl, commentsCount, apifyToken })
  });

  const data = await res.json();
  if (data.ok) {
    msg.style.color = "green";
    msg.textContent = "Scrape completado";
    renderTable(data.normalized);
  } else {
    msg.style.color = "red";
    msg.textContent = data.message;
  }
});

document.getElementById('export-btn').addEventListener('click', () => {
  window.location.href = '/api/export-csv';
});

async function loadLatest() {
  const res = await fetch('/api/latest');
  const data = await res.json();
  if (data.ok) renderTable(data.normalized);
}

function renderTable(items) {
  resultsTableBody.innerHTML = '';
  items.forEach(it => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${it.postTitle}</td>
      <td>${it.text}</td>
      <td>${it.likesCount}</td>
      <td><a href="${it.facebookUrl}" target="_blank">Link</a></td>
    `;
    resultsTableBody.appendChild(tr);
  });
}
