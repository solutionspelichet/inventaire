// =====================
// app.js (PWA Frontend)
// =====================

// --- Helpers UI & logs ---
const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (m) => { try { console.log(m); } catch(_){} if (logEl) logEl.textContent += m + '\n'; };
const setBusy = (busy) => { const b = $('runBtn'); if (b) { b.disabled = busy; b.textContent = busy ? 'Traitement en cours…' : 'Lancer le traitement'; } };

// ======= IndexedDB helpers pour mémoriser le dernier fichier "suivi" =======
const DB_NAME = 'pelichet-cache';
const DB_STORE = 'files';
const KEY_SUIVI = 'last_suivi';

function idbOpen(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(key, value){
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function idbGet(key){
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// Sauvegarde le fichier "suivi" (nom + Blob)
async function saveLastSuivi(file){
  try{
    const buf = await file.arrayBuffer();
    const rec = { name: file.name, type: file.type || 'application/octet-stream', buf };
    await idbPut(KEY_SUIVI, rec);
    log(`💾 Suivi mémorisé localement: ${file.name}`);
  }catch(e){ log('⚠️ Sauvegarde suivi impossible: ' + e.message); }
}

// Recharge le dernier fichier "suivi" mémorisé → File
async function loadLastSuivi(){
  const rec = await idbGet(KEY_SUIVI);
  if (!rec || !rec.buf) return null;
  try{
    const blob = new Blob([rec.buf], { type: rec.type || 'application/octet-stream' });
    const f = new File([blob], rec.name || 'suivi.xlsx', { type: rec.type || 'application/octet-stream' });
    log(`📥 Suivi rechargé depuis le cache: ${rec.name || 'suivi.xlsx'}`);
    return f;
  }catch(e){
    log('⚠️ Recharge suivi impossible: ' + e.message);
    return null;
  }
}



// Log erreurs visibles
window.addEventListener('error', (e) => log('⛔ JS error: ' + (e?.error?.message || e.message || e.toString())));
window.addEventListener('unhandledrejection', (e) => log('⛔ Promise rejection: ' + (e?.reason?.message || e.reason || e.toString())));

// --- Config fixe ---
const SHEET_ID = '1AptbV2NbY0WQZpe_Xt1K2iVlDpgKADElamKQCg3GcXQ';
const GAS_URL  = 'https://script.google.com/macros/s/AKfycbwO0P3Yo5kw9PPriJPXzUMipBrzlGTR_r-Ff6OyEUnsNu-I9q-rESbBq7l2m6KLA3RJ/exec'; // <— remplace par ton /exec

// (optionnel) mémoriser le secret
document.addEventListener('DOMContentLoaded', () => {
  log('✅ App prête. Sélectionne les 2 fichiers.');
  const saved = localStorage.getItem('PWA_SECRET');
  if (saved && $('secret')) $('secret').value = saved;

  const btn = $('runBtn'); if (btn && !btn.onclick) btn.addEventListener('click', onRun);
  const tbtn = $('testBtn'); if (tbtn && !tbtn.onclick) tbtn.addEventListener('click', testConnexion);

  if ($('secret')) $('secret').addEventListener('change', e => localStorage.setItem('PWA_SECRET', e.target.value));
  const suiviInput = $('suiviFile');
  if (suiviInput && !suiviInput._wiredSave){
    suiviInput.addEventListener('change', async (e)=>{
      const f = e.target?.files?.[0];
      if (f) await saveLastSuivi(f);
    });
    suiviInput._wiredSave = true;
  }
});

// Test GET (indicatif ; en no-cors la réponse est opaque)
async function testConnexion(){
  try{
    if(!GAS_URL) { alert('Définis GAS_URL dans app.js'); return; }
    log('Ping Apps Script…');
    await fetch(GAS_URL, { method:'GET', mode:'no-cors' });
    log('GET envoyé (no-cors). Vérifie Apps Script > Exécutions si besoin.');
  }catch(e){ log('❌ Test: ' + e.message); alert(e.message); }
}


// Convertit un File en base64 (sans préfixe data:)
function fileToBase64(file){
  return new Promise((resolve, reject)=>{
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const base64 = s.split(',').pop(); // retire "data:...;base64,"
      resolve(base64 || '');
    };
    fr.onerror = () => reject(fr.error || new Error('FileReader error'));
    fr.readAsDataURL(file);
  });
}
function fmtBytes(n){ return n ? `${(n/1024/1024).toFixed(2)} MB` : '0'; }


// ==================
// Lecture / parsing
// ==================
async function readWorkbook(file) {
  const data = await file.arrayBuffer();
  return XLSX.read(data, { type: 'array' });
}

// Détecte si le classeur est en base "date1904" (Excel Mac)
function getWorkbookDate1904(workbook){
  try { return !!(workbook && workbook.Workbook && workbook.Workbook.WBProps && workbook.Workbook.WBProps.date1904); }
  catch { return false; }
}

// 1ère feuille → AOA ; supprime entête dupliquée ; supprime dernière ligne UNIQUEMENT si elle contient "total"
function cleanSheetToAOA(workbook) {
  const firstName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  if (!aoa.length) return aoa;

  const header = aoa[0].map(x => (x==null?'':String(x).trim()));

  // entête dupliquée (ligne 2 == entête)
  if (aoa.length >= 2) {
    const firstDataRow = aoa[1].map(x => (x==null?'':String(x).trim()));
    if (arraysEqual(header, firstDataRow)) aoa.splice(1, 1);
  }

  // ne supprime la dernière ligne que s'il y a clairement "total" quelque part
  if (aoa.length >= 2) {
    const last = aoa[aoa.length - 1];
    const hasTotalWord = last.some(cell => {
      const s = (cell==null ? '' : String(cell)).trim().toLowerCase();
      return /(^|[^a-z])total(s)?([^a-z]|$)|totaux|somme|sum|grand total|subtotal/.test(s);
    });
    if (hasTotalWord) aoa.splice(aoa.length - 1, 1);
  }
  return aoa;
}
function arraysEqual(a,b){ return a.length===b.length && a.every((v,i)=>String(v).trim()===String(b[i]).trim()); }
function aoaToObjects(aoa){
  if(!aoa || !aoa.length) return [];
  const headers = aoa[0].map(h => String(h||'').trim());
  return aoa.slice(1).map(row => { const o={}; headers.forEach((h,i)=>o[h]=row[i]); return o; });
}

// Normalisation robuste des contacts
function normContact(s){
  return (s==null ? '' : String(s))
    .normalize('NFKC')        // homogénéise accents/ligatures
    .replace(/\s+/g,' ')      // compresse espaces
    .trim()
    .toLocaleUpperCase('fr-FR');
}

// Parsing nombres/dates
function parseNumber(v){
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && isFinite(v)) return v;
  let s = String(v).trim();
  s = s.replace(/[\u202F\u00A0\s']/g, ''); // espaces fines, insécables, apostrophes
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) { s = s.replace(/\./g, '').replace(',', '.'); }
  else if (lastDot > lastComma) { s = s.replace(/,/g, ''); }
  else { if (s.includes(',')) s = s.replace(',', '.'); }
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

// Convertit en AAAA-MM-JJ ; gère ISO, JJ/MM/AAAA (±heure) et numéros Excel (1900 & 1904)
// Convertit en AAAA-MM-JJ ; gère ISO, JJ/MM/AAAA (±heure), numéros Excel (1900 & 1904),
// ET aussi les numéros Excel sous forme de CHAÎNES ("45199" ou "45199,25").
// Convertit en AAAA-MM-JJ ; gère ISO, JJ/MM/AAAA (±heure), numéros Excel (1900 & 1904)
// + tolère un suffixe de fuseau horaire en fin de chaîne comme " +02:00", " UTC+2", " GMT+01:00".
function parseDate(v, date1904=false) {
  if (v == null || v === '') return null;

  // 1) Numéro Excel (Number)
  if (typeof v === 'number' && isFinite(v)) {
    const serial = date1904 ? (v + 1462) : v;
    const ms = Math.round((serial - 25569) * 86400 * 1000); // base Excel 1899-12-30
    const d = new Date(ms);
    if (!isNaN(d)) return fmtYMD(d);
  }

  // 2) Chaîne → nettoyer les suffixes de fuseau à la fin (" +02:00", "UTC+2", "GMT+01:00")
  if (typeof v === 'string') {
    let s = v.trim();

    // supprime un éventuel suffixe timezone en fin de chaîne
    // ex: "29/09/2025 16:01:17 +02:00" -> "29/09/2025 16:01:17"
    //     "29/09/2025 16:01 UTC+2"     -> "29/09/2025 16:01"
    s = s.replace(/\s*(?:GMT|UTC)?\s*[+-]\d{2}:?\d{0,2}\s*$/i, '');

    // (cas chaînes numériques: serial Excel sous forme de texte "45199" ou "45199,5")
    const sNum = s.replace(',', '.');
    if (/^\d+(\.\d+)?$/.test(sNum)) {
      const serial = date1904 ? (parseFloat(sNum) + 1462) : parseFloat(sNum);
      if (isFinite(serial)) {
        const ms = Math.round((serial - 25569) * 86400 * 1000);
        const d = new Date(ms);
        if (!isNaN(d)) return fmtYMD(d);
      }
    }

    // 3) ISO-like en local
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?/);
    if (m) {
      const [_, YYYY, MM, DD, hh='0', mm='0', ss='0'] = m;
      const d = new Date(Number(YYYY), Number(MM)-1, Number(DD), Number(hh), Number(mm), Number(ss));
      if (!isNaN(d)) return fmtYMD(d);
    }

    // 4) JJ/MM/AAAA (±heure, ±secondes, ±millisecondes)
    m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})(?:\s+(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?(?:\.(\d{1,3}))?)?$/);
    if (m) {
      const [_, DD, MM, YYYY, hh='0', mm='0', ss='0'] = m;
      const d = new Date(Number(YYYY), Number(MM)-1, Number(DD), Number(hh), Number(mm), Number(ss));
      if (!isNaN(d)) return fmtYMD(d);
    }
  }

  // 5) ultime recours
  const d = new Date(v);
  return isNaN(d) ? null : fmtYMD(d);
}


function fmtYMD(d){ const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }

// ======================
// Traitements principaux
// ======================
function excelLetterToIndex(L) {
  L = String(L || '').trim().toUpperCase();
  let idx = 0;
  for (const ch of L) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

// Résumé/log de traitement
function logProcessSummary(label, summary){
  const { rowsRead, rowsAfterDedupe, daysCount, first5Days, last5Days, totalSum } = summary;
  log(`📊 ${label} | lus=${rowsRead} | après dédoublonnage=${rowsAfterDedupe} | jours=${daysCount} | total=${totalSum}`);
  if (first5Days.length) log(`   premiers jours: ${first5Days.join(', ')}`);
  if (last5Days.length)  log(`   derniers  jours: ${last5Days.join(', ')}`);
}

// Log dernier jour pour un tableau {headers, rows}
function logLastDay(label, table){
  try{
    const headers = table?.headers || [];
    const days = headers.slice(1);
    if (!days.length) { log(`ℹ️ ${label}: aucune date détectée`); return; }
    const last = days[days.length-1];
    const idx = headers.indexOf(last);
    let total = 0;
    for (const r of (table?.rows || [])) total += Number(r[idx] || 0);
    log(`ℹ️ ${label} – dernier jour: ${last} | total=${total}`);
  }catch(e){}
}

function processWorkbook(workbook, refs, is1904=false, labelForLogs='Fichier') {
  const aoa = cleanSheetToAOA(workbook);
  const rows = aoaToObjects(aoa);
  if (!rows.length) return { tableau: emptyTable(), summary: { rowsRead:0, rowsAfterDedupe:0, daysCount:0, first5Days:[], last5Days:[], totalSum:0 } };

  const headers = aoa[0];

  function colNameByLetter(inputId){
    const letter = $(inputId).value;
    const idx = excelLetterToIndex(letter);
    if (idx < 0 || idx >= headers.length) {
      throw new Error(`Lettre colonne hors plage: ${letter} (headers=${headers.length})`);
    }
    return headers[idx];
  }

  const colKey  = colNameByLetter(refs.key);
  const colUser = colNameByLetter(refs.user);
  const colSum  = colNameByLetter(refs.sum);
  const colDate = colNameByLetter(refs.date);
  // Debug: échantillons bruts de la colonne Date
try {
  const samples = [];
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const raw = rows[i][colDate];
    samples.push(`${typeof raw}:${String(raw)}`);
  }
  log(`🔎 [${labelForLogs}] Colonne Date='${colDate}' — exemples: ` + samples.join(' | '));
} catch(e) { /* ignore */ }

  // Dédoublonnage (garde le 1er). Si la clé est vide → on NE dédoublonne PAS.
  const seen = new Set(); 
  const dedupe = [];
  for (const r of rows) {
    const kRaw = r[colKey];
    const k = (kRaw == null ? '' : String(kRaw)).trim();
    if (!k) {
      dedupe.push(r);
    } else if (!seen.has(k)) {
      seen.add(k);
      dedupe.push(r);
    }
  }

  // Agrégation par jour (date = AAAA-MM-JJ)
  const perDayMap = new Map(); const usersSet = new Set(); const daysSet = new Set();
  for (const r of dedupe) {
    const u = normContact(r[colUser]); // normalisation Contact
    usersSet.add(u);
    const d = parseDate(r[colDate], is1904); if (!d) continue; daysSet.add(d);
    const val = parseNumber(r[colSum]); // parsing FR robuste
    const key = `${u}||${d}`;
    perDayMap.set(key, (perDayMap.get(key)||0) + val);
  }

  const days = Array.from(daysSet).sort();
  const headersOut = ['Contact', ...days.map(d => `nombre colonne carton ${d}`)];
  const rowsOut = [];
  for (const u of Array.from(usersSet).sort()) {
    const row = [u];
    for (const d of days) row.push(perDayMap.get(`${u}||${d}`) || 0);
    rowsOut.push(row);
  }

  const summary = {
    rowsRead: rows.length,
    rowsAfterDedupe: dedupe.length,
    daysCount: days.length,
    first5Days: days.slice(0,5),
    last5Days: days.slice(-5),
    totalSum: Array.from(perDayMap.values()).reduce((a,b)=>a+Number(b||0),0)
  };
  logProcessSummary(labelForLogs, summary);

  return { tableau: { headers: headersOut, rows: rowsOut }, summary };
}

function emptyTable(){ return { headers:['Contact'], rows:[] } }

// =====================
// Fusion & dérivés
// =====================
function mergeTablesByContactAndHeaders(A, B) {
  const headers = Array.from(new Set([...(A.headers||[]), ...(B.headers||[])]));
  const ci = headers.indexOf('Contact'); if (ci>0){ headers.splice(ci,1); headers.unshift('Contact'); }

  const idxA = indexMap(A.headers||[]), idxB = indexMap(B.headers||[]);
  const norm = (s) => normContact(s);

  const contacts = new Set([...(A.rows||[]).map(r=>norm(r[0])), ...(B.rows||[]).map(r=>norm(r[0]))]);
  const mapA = new Map(); (A.rows||[]).forEach(r => mapA.set(norm(r[0]), r));
  const mapB = new Map(); (B.rows||[]).forEach(r => mapB.set(norm(r[0]), r));

  const outRows = [];
  for (const c of Array.from(contacts).sort()) {
    const row = Array(headers.length).fill(0); row[0] = c;
    const ra = mapA.get(c), rb = mapB.get(c);
    if (ra) sumRowIntoParsed(row, ra, headers, idxA);
    if (rb) sumRowIntoParsed(row, rb, headers, idxB);
    for (let i=1;i<row.length;i++) row[i] = parseNumber(row[i]);
    outRows.push(row);
  }
  return { headers, rows: outRows };
}

function indexMap(h){ const m={}; (h||[]).forEach((name,i)=>m[name]=i); return m; }
function sumRowIntoParsed(targetRow, srcRow, headers, srcIdxMap){
  for (let i=1;i<headers.length;i++){
    const name = headers[i];
    const si = srcIdxMap[name];
    const v = (si==null) ? 0 : parseNumber(srcRow[si]);
    targetRow[i] = parseNumber(targetRow[i]) + v;
  }
}

function multiplyValues(table, k){
  const headers = table.headers.slice();
  const rows = table.rows.map(r=>{
    const out = r.slice();
    for (let i=1;i<out.length;i++) out[i] = parseNumber(out[i]) * k;
    return out;
  });
  return { headers, rows };
}

// ------------------------------
// Lancer le traitement complet
// ------------------------------
async function onRun() {
  setBusy(true);
  try {
    log('--- Début ---');

    let sFile = $('suiviFile')?.files?.[0];
    const eFile = $('extractFile')?.files?.[0];
    const secret = $('secret') ? $('secret').value.trim() : '';

    if (!sFile) {
  log('ℹ️ Aucun fichier suivi sélectionné — tentative de recharge depuis le cache…');
  sFile = await loadLastSuivi();
}
if (!sFile) { alert('Sélectionne le fichier de suivi (.xlsx)'); throw new Error('Suivi manquant'); }
    if (!eFile) { alert('Sélectionne le fichier d’extraction (.xlsx)'); throw new Error('Extraction manquante'); }
    if (!GAS_URL) { alert('Définis GAS_URL dans app.js'); throw new Error('URL Apps Script absente'); }

    log('Lecture fichiers… (dans le navigateur)');
    const sWorkbook = await readWorkbook(sFile);
    const eWorkbook = await readWorkbook(eFile);

    const s1904 = getWorkbookDate1904(sWorkbook);
    const e1904 = getWorkbookDate1904(eWorkbook);
    log(`ℹ️ Suivi : date1904=${s1904 ? 'TRUE' : 'FALSE'}`);
    log(`ℹ️ Extraction : date1904=${e1904 ? 'TRUE' : 'FALSE'}`);

    log('Nettoyage & calcul tableaux (suivi / extraction)…');
    const sData = processWorkbook(sWorkbook, { key:'s_key', user:'s_user', sum:'s_sum', date:'s_date' }, s1904, 'Suivi');
    const eData = processWorkbook(eWorkbook, { key:'e_key', user:'e_user', sum:'e_sum', date:'e_date' }, e1904, 'Extraction');

    // Logs "dernier jour"
    logLastDay('Suivi', sData.tableau);
    logLastDay('Extraction', eData.tableau);

    log('Calcul resultats (addition alignée)…');
    const resultats = mergeTablesByContactAndHeaders(sData.tableau, eData.tableau);
    const ml = multiplyValues(resultats, 0.35);

    // Pré-contrôle pour éviter d’écraser le Sheet si vide
    const dayCount = (resultats.headers?.length || 1) - 1;
    const rowCount = (resultats.rows?.length || 0);
    log(`🧪 Pré-contrôle → contacts: ${rowCount}, jours: ${dayCount}`);
    if (dayCount <= 0 || rowCount <= 0) {
      alert("Aucune donnée exploitable détectée (0 jour ou 0 contact). Envoi annulé pour ne pas vider le Google Sheet.");
      return;
    }

    // Taille max conseillée 50 MB
const MAX_MB = 50;

let suiviB64 = null, extractB64 = null;
if (sFile) {
  if (sFile.size > MAX_MB*1024*1024) throw new Error(`Fichier suivi trop gros (> ${MAX_MB} MB)`);
  log(`📤 Prépare upload Drive - suivi: ${sFile.name} (${fmtBytes(sFile.size)})`);
  suiviB64 = await fileToBase64(sFile);
}
if (eFile) {
  if (eFile.size > MAX_MB*1024*1024) throw new Error(`Fichier extraction trop gros (> ${MAX_MB} MB)`);
  // Décommente si tu veux aussi sauver l'extraction :
  // log(`📤 Prépare upload Drive - extraction: ${eFile.name} (${fmtBytes(eFile.size)})`);
  // extractB64 = await fileToBase64(eFile);
}

const payload = {
  secret,
  sheetId: SHEET_ID,
  resultats: { headers: resultats.headers, rows: resultats.rows },
  ml: { headers: ml.headers, rows: ml.rows },
  // === Drive upload ===
  saveSuivi: true, // mettre à false si tu ne veux pas uploader
  suiviFile: suiviB64 ? { name: sFile.name, mime: sFile.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: suiviB64 } : null,
  // saveExtraction: true,
  // extractionFile: extractB64 ? { name: eFile.name, mime: eFile.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: extractB64 } : null,
};

    
    

    log('Envoi vers Google Sheets (Apps Script)…');
    await fetch(GAS_URL, {
      method: 'POST',
      mode: 'no-cors',            // on n’essaie pas de lire la réponse (CORS)
      redirect: 'follow',
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });

    log('✅ Requête envoyée (no-cors). Vérifie le Google Sheet (onglets "resultats" et "ML").');
    alert('Envoi effectué. Ouvre le Google Sheet pour vérifier.');
  } catch (e) {
    log('❌ ' + e.message);
    alert('Erreur : ' + e.message);
  } finally {
    setBusy(false);
    log('--- Fin ---');
  }
}

// Expose global (fallback onclick dans index.html)
window.onRun = onRun;
window.testConnexion = testConnexion;
