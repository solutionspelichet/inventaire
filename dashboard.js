// ====== Config par défaut ======
const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbwO0P3Yo5kw9PPriJPXzUMipBrzlGTR_r-Ff6OyEUnsNu-I9q-rESbBq7l2m6KLA3RJ/exec'; // <-- colle ton /exec
const DEFAULT_SHEET_ID = '1AptbV2NbY0WQZpe_Xt1K2iVlDpgKADElamKQCg3GcXQ';


// ====== Helpers UI ======
const $ = (id) => document.getElementById(id);
const log = (m) => { const el = $('log'); if (el) el.textContent += m + '\n'; console.log(m); };

// ====== JSONP ======
function jsonp(url, params={}){
  return new Promise((resolve, reject)=>{
    const cbName = 'cb_' + Math.random().toString(36).slice(2);
    params.callback = cbName;
    const qs = Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const src = url + (url.includes('?') ? '&' : '?') + qs;
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onerror = () => { delete window[cbName]; reject(new Error('JSONP load error')); };
    window[cbName] = (data) => { delete window[cbName]; document.body.removeChild(s); resolve(data); };
    document.body.appendChild(s);
  });
}

// ====== Parsing ML ======
function parseML(data){
  const headers = data.headers || [];
  const rows = data.rows || [];
  if (!headers.length) return { days: [], teams: [], matrix: [] };

  const dayCols = []; const days = [];
  for (let i=1; i<headers.length; i++){
    const h = String(headers[i] || '');
    const m = h.match(/nombre colonne carton\s+(\d{4}-\d{2}-\d{2})$/i);
    if (m) { dayCols.push(i); days.push(m[1]); }
  }

  const teams = []; const matrix = [];
  for (const r of rows){
    const team = String(r[0] || '').trim();
    if (!team) continue;
    teams.push(team);
    const vals = [];
    for (let ci=0; ci<dayCols.length; ci++){
      const idx = dayCols[ci];
      let v = r[idx]; if (v == null || v === '') v = 0;
      const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g,'').replace(',', '.'));
      vals.push(isFinite(n) ? n : 0);
    }
    matrix.push(vals);
  }
  return { days, teams, matrix };
}

// ====== KPI ======
function updateKpis({days, teams, matrix}){
  const kTotal = matrix.flat().reduce((a,b)=>a+(b||0),0);
  const kTeams = teams.length;
  const lastDay = days[days.length-1] || '—';
  let lastTotal = 0;
  if (days.length){
    const c = days.length-1;
    for (let r=0;r<matrix.length;r++) lastTotal += (matrix[r][c]||0);
  }
  // top team
  let bestTeam = '—', bestVal = -1;
  for (let i=0;i<teams.length;i++){
    const s = (matrix[i]||[]).reduce((a,b)=>a+(b||0),0);
    if (s>bestVal){ bestVal=s; bestTeam=teams[i]; }
  }

  $('kpiTotal').textContent = kTotal.toFixed(2);
  $('kpiDays').textContent  = `${days.length} jours`;
  $('kpiTeams').textContent = kTeams;
  $('kpiTopTeam').textContent = `Meilleure équipe : ${bestTeam}`;
  $('kpiLastDay').textContent = lastDay;
  $('kpiLastTotal').textContent = `Total jour : ${lastTotal.toFixed(2)}`;
}

// ====== Rendu tableau ======
function renderTable({days, teams, matrix}){
  const wrap = $('tableWrap');
  if (!wrap) return;
  if (!days.length) { wrap.innerHTML = '<p><em>Pas de colonnes “nombre colonne carton …” trouvées.</em></p>'; return; }

  let html = '<table><thead><tr><th>Contact</th>';
  for (const d of days) html += `<th>${d}</th>`;
  html += '<th>Total</th></tr></thead><tbody>';

  for (let i=0;i<teams.length;i++){
    const t = teams[i];
    const row = matrix[i] || [];
    const sum = row.reduce((a,b)=>a+(b||0),0);
    html += `<tr><td>${t}</td>`;
    for (const v of row) html += `<td>${v.toFixed(2)}</td>`;
    html += `<td><strong>${sum.toFixed(2)}</strong></td></tr>`;
  }

  // total colonnes
  const colTotals = new Array(days.length).fill(0);
  for (let c=0;c<days.length;c++){
    for (let r=0;r<matrix.length;r++){
      colTotals[c] += (matrix[r][c] || 0);
    }
  }
  const grandTotal = colTotals.reduce((a,b)=>a+b,0);

  html += `<tfoot><tr><th>Total</th>`;
  for (const v of colTotals) html += `<th>${v.toFixed(2)}</th>`;
  html += `<th>${grandTotal.toFixed(2)}</th></tr></tfoot>`;

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ====== Chart (palette Pelichet) ======
let chartInst = null;
function renderChart({days, teams, matrix}){
  const ctx = $('chart');
  if (!ctx || !days.length) return;

  // palette Pelichet
  const base = [
    '#F07A24','#404040','#8C8C8C','#BFBFBF',
    '#FFB37A','#737373','#D9D9D9','#595959',
    '#FFC699','#A6A6A6'
  ];
  const ds = teams.map((t,i)=>({
    label:t,
    data:matrix[i]||[],
    backgroundColor: base[i % base.length],
    borderColor: '#ffffff',
    borderWidth:1
  }));

  if (chartInst) chartInst.destroy();
  chartInst = new Chart(ctx, {
    type:'bar',
    data:{ labels:days, datasets:ds },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      plugins:{ legend:{ position:'bottom' } },
      scales:{ x:{ stacked:true }, y:{ stacked:true, beginAtZero:true } }
    }
  });
}

// ====== Dernier fichier “suivi” ======
async function updateLatestSuiviLink(gasUrl){
  try{
    const res = await jsonp(gasUrl, { action: 'latestSuivi' });
    const a = $('downloadSuivi');
    if (res?.ok && res.latest?.found && res.latest?.url){
      a.href = res.latest.url;
      a.textContent = `Dernier suivi : ${res.latest.name}`;
      log(`Dernier suivi → ${res.latest.name}`);
    } else {
      a.href = '#';
      a.textContent = 'Aucun fichier “suivi” trouvé';
    }
  }catch(e){ log('latestSuivi error: '+e.message); }
}

// ====== Chargement ML ======
async function loadML(gasUrl, sheetId){
  const res = await jsonp(gasUrl, { action: 'ml', sheetId });
  if (!res || !res.ok) { log('Erreur lecture ML'); return; }
  const parsed = parseML(res.data || {});
  updateKpis(parsed);
  renderTable(parsed);
  renderChart(parsed);
  log(`ML chargé: équipes=${parsed.teams.length}, jours=${parsed.days.length}`);
}

// ====== Boot ======
document.addEventListener('DOMContentLoaded', ()=>{
  const gasInput = $('gasUrl');
  const sheetInput = $('sheetId');
  const btn = $('refreshBtn');
  const toggleLog = $('toggleLog');

  if (gasInput) gasInput.value = DEFAULT_GAS_URL;
  if (sheetInput) sheetInput.value = DEFAULT_SHEET_ID;

  if (btn) btn.addEventListener('click', async ()=>{
    const gasUrl = gasInput.value.trim();
    const sheetId = sheetInput.value.trim();
    if (!gasUrl || !sheetId) { alert('Renseigne Apps Script URL et Sheet ID'); return; }
    const logEl = $('log'); if (logEl) logEl.textContent = '';
    await loadML(gasUrl, sheetId);
    await updateLatestSuiviLink(gasUrl);
  });

  if (toggleLog) toggleLog.addEventListener('click', ()=>{
    const el = $('log'); if (!el) return;
    el.style.display = (el.style.display==='none' || !el.style.display) ? 'block' : 'none';
  });

  // auto
  if (btn) btn.click();
});
