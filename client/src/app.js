const API_BASE = (location.hostname === 'localhost') ? 'http://localhost:3000' : '';


function qs(sel) { return document.querySelector(sel); }


function show(html) { qs('#root').innerHTML = html; }


function loginForm() {
show(`
<h2>Login admin</h2>
<input id="username" placeholder="usuario" value="admin" /> <br/>
<input id="password" placeholder="contraseña" type="password" /> <br/>
<button id="login">Entrar</button>
<div id="msg"></div>
`);
qs('#login').onclick = async () => {
const username = qs('#username').value;
const password = qs('#password').value;
const resp = await fetch(`${API_BASE}/api/login`, {
method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username, password }), credentials: 'include'
});
if (resp.ok) return mainPage();
const j = await resp.json(); qs('#msg').innerText = j.message || 'error';
};
}


async function fetchLatestAndRender() {
const r = await fetch(`${API_BASE}/api/latest`, { credentials: 'include' });
const j = await r.json();
const rows = j.normalized || [];
const table = rows.map(r => `<tr><td>${escape(r.postTitle)}</td><td>${escape(r.text)}</td><td>${escape(r.likesCount)}</td><td><a href="${escape(r.facebookUrl)}" target="_blank">link</a></td></tr>`).join('');
return `
<h3>Última instancia (${j.createdAt || '—'})</h3>
<table border="1"><thead><tr><th>postTitle</th><th>text</th><th>likesCount</th><th>facebookUrl</th></tr></thead><tbody>${table}</tbody></table>
<button id="export">Descargar CSV</button>
`;
}


function escape(s){ return (s+'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


function mainPage() {
show(`
<h2>FB
