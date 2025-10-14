// ===== Config =====
const API_URL = window.APP_CONFIG.API_URL;
const TZ = 'Europe/Zurich';

// ===== ZXing import =====
const { BrowserMultiFormatReader, NotFoundException, DecodeHintType, BarcodeFormat } = ZXing;

// ===== State =====
let scanning = false, lastCode = null, lastTime = 0;
let currentDeviceId = null;
let videoTrack = null;
let codeReader = null;       // recréé à chaque changement de format
let currentFormats = null;   // formats actifs
let currentHints = null;

// ===== DOM =====
const els = {
  video: document.getElementById('preview'),
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  camSel: document.getElementById('cameraSelect'),
  btnTorch: document.getElementById('btnTorch'),
  zoomWrap: document.getElementById('zoomWrap'),
  zoomRange: document.getElementById('zoomRange'),
  zoomValue: document.getElementById('zoomValue'),

  codeValue: document.getElementById('codeValue'),
  codeType: document.getElementById('codeType'),
  depart: document.getElementById('depart'),
  destination: document.getElementById('destination'),
  dateMvt: document.getElementById('dateMvt'),
  notes: document.getElementById('notes'),
  submit: document.getElementById('btnSubmit'),
  status: document.getElementById('status')
};

function setStatus(msg, ok=true){
  els.status.textContent = msg || '';
  els.status.style.color = ok ? 'green' : 'crimson';
}
function todayISO(){
  const d = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}
els.dateMvt.value = todayISO();

// ===== Formats & hints =====
function buildHintsFromUI(){
  const val = els.codeType.value;
  let formats;
  if (val === 'QR_CODE') formats = [BarcodeFormat.QR_CODE];
  else if (val === 'EAN_13') formats = [BarcodeFormat.EAN_13];
  else if (val === 'CODE_128') formats = [BarcodeFormat.CODE_128];
  else if (val === 'CODE_39') formats = [BarcodeFormat.CODE_39];
  else formats = [BarcodeFormat.QR_CODE, BarcodeFormat.EAN_13, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39];

  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return { formats, hints };
}

function recreateReader(){
  const { formats, hints } = buildHintsFromUI();
  currentFormats = formats;
  currentHints = hints;
  // 300 ms throttle
  codeReader = new BrowserMultiFormatReader(hints, 300);
}

// ===== Permissions & cam list =====
async function ensurePermission(){
  try{
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach(t => t.stop());
    return true;
  }catch(e){
    setStatus("Autorisez la caméra dans les réglages du site.", false);
    throw e;
  }
}

async function listCamerasAfterPermission(){
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  els.camSel.innerHTML = '';
  cams.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || `Caméra ${i+1}`;
    els.camSel.appendChild(o);
  });
  const back = cams.find(c => /back|rear|environment/i.test(c.label));
  if (back) els.camSel.value = back.deviceId;
  return cams;
}

function waitForStream(){
  return new Promise(resolve => {
    if (els.video.srcObject) return resolve();
    els.video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

function initCameraControls(){
  els.btnTorch.disabled = true;
  els.btnTorch.dataset.on = '0';
  els.btnTorch.textContent = 'Lampe OFF';
  els.zoomWrap.hidden = true;

  if (!els.video.srcObject) return;

  const tracks = els.video.srcObject.getVideoTracks();
  videoTrack = tracks && tracks[0] ? tracks[0] : null;
  if (!videoTrack) return;

  const caps = typeof videoTrack.getCapabilities === 'function' ? videoTrack.getCapabilities() : {};

  // Torch
  if (caps && 'torch' in caps) els.btnTorch.disabled = false;

  // Zoom
  if (caps && 'zoom' in caps) {
    const { min=1, max=1, step=0.1 } = caps.zoom;
    els.zoomRange.min = min;
    els.zoomRange.max = max;
    els.zoomRange.step = step || 0.1;
    try{
      const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
      const current = settings.zoom ?? min;
      els.zoomRange.value = current;
      els.zoomValue.textContent = `${Number(current).toFixed(1)}×`;
    }catch{}
    els.zoomWrap.hidden = false;
  }
}

// ===== Torch & Zoom handlers =====
async function setTorch(on){
  if (!videoTrack || !videoTrack.getCapabilities) return false;
  const caps = videoTrack.getCapabilities();
  if (!('torch' in caps)) return false;
  try{
    await videoTrack.applyConstraints({ advanced: [{ torch: !!on }] });
    return true;
  }catch(e){ console.warn('Torch error:', e); return false; }
}
async function setZoom(value){
  if (!videoTrack || !videoTrack.getCapabilities) return false;
  const caps = videoTrack.getCapabilities();
  if (!('zoom' in caps)) return false;
  try{
    await videoTrack.applyConstraints({ advanced: [{ zoom: Number(value) }] });
    els.zoomValue.textContent = `${Number(value).toFixed(1)}×`;
    return true;
  }catch(e){ console.warn('Zoom error:', e); return false; }
}
els.btnTorch.addEventListener('click', async () => {
  const on = els.btnTorch.dataset.on === '1';
  const ok = await setTorch(!on);
  if (ok){
    els.btnTorch.dataset.on = on ? '0' : '1';
    els.btnTorch.textContent = on ? 'Lampe OFF' : 'Lampe ON';
  } else {
    alert("Lampe non supportée sur cette caméra.");
  }
});
els.zoomRange.addEventListener('input', (e) => setZoom(e.target.value));

// ===== Start/Stop scan =====
async function start(){
  try{
    recreateReader();

    els.video.setAttribute('playsinline','true');
    els.video.muted = true;

    await ensurePermission();
    const cams = await listCamerasAfterPermission();
    if (!cams.length) { setStatus("Aucune caméra détectée.", false); return; }

    const selectedId = els.camSel.value || cams[0].deviceId;

    // Très haute résolution pour aider les 1D
    const constraints = {
      video: {
        deviceId: selectedId ? { exact: selectedId } : undefined,
        facingMode: { ideal: 'environment' },
        width:  { ideal: 2560 },
        height: { ideal: 1440 },
        focusMode: 'continuous',
        advanced: [{ focusMode: 'continuous' }]
      },
      audio: false
    };

    await codeReader.decodeFromConstraints(constraints, els.video, (result, err) => {
      if (result) {
        const code = result.getText();
        const now = Date.now();
        if (code === lastCode && (now - lastTime) < 8000) {
          alert("Attention : même code scanné à la suite. Voulez-vous l'enregistrer à nouveau ?");
        }
        els.codeValue.value = code;
        lastCode = code; lastTime = now;
      } else if (err && !(err instanceof NotFoundException)) {
        console.warn(err);
      }
    });

    await waitForStream();
    initCameraControls();

    scanning = true;
    els.btnStart.disabled = true;
    els.btnStop.disabled = false;

    // Message de guidance selon format
    if (currentFormats && currentFormats.length === 1 && currentFormats[0] !== BarcodeFormat.QR_CODE) {
      setStatus("Caméra démarrée. Astuce: tenez le code 1D bien horizontal, plein cadre (60–80%), bonne lumière.");
    } else {
      setStatus("Caméra démarrée (Auto). Essayez un QR puis vos codes 1D.");
    }
  }catch(e){
    console.error(e);
    setStatus("Impossible de démarrer la caméra. Vérifiez l'autorisation et réessayez.", false);
  }
}

function stop(){
  try{ if (codeReader) codeReader.reset(); }catch{}
  const s = els.video.srcObject;
  if (s && s.getTracks) s.getTracks().forEach(t => t.stop());
  els.video.srcObject = null;
  videoTrack = null;

  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  els.btnTorch.disabled = true;
  els.zoomWrap.hidden = true;
  els.btnTorch.dataset.on = '0';
  els.btnTorch.textContent = 'Lampe OFF';

  scanning = false;
  setStatus("Caméra arrêtée");
}

// Changer de caméra ou de format => restart
els.camSel.addEventListener('change', () => { if (scanning) { stop(); start(); } });
els.codeType.addEventListener('change', () => { if (scanning) { stop(); start(); } });

els.btnStart.addEventListener('click', start);
els.btnStop.addEventListener('click', stop);

// ===== Listes depuis l’API =====
async function loadListes(){
  try{
    setStatus("Chargement des listes…");
    const res = await fetch(`${API_URL}?action=listes`);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "Erreur listes");
    fill(els.depart, j.depart);
    fill(els.destination, j.destination);
    setStatus("Listes chargées");
  }catch(e){
    setStatus("Erreur listes: " + e.message, false);
  }
}
function fill(sel, arr){
  sel.innerHTML = '';
  arr.forEach(v => {
    const o = document.createElement('option');
    o.value = v; o.textContent = v; sel.appendChild(o);
  });
}

// ===== Envoi vers Google Sheets =====
els.submit.addEventListener('click', async () => {
  try{
    const code = els.codeValue.value.trim();
    const type = els.codeType.value;
    const dep  = els.depart.value;
    const dst  = els.destination.value;
    const dateMvt = els.dateMvt.value;

    if (!code) throw new Error("Code manquant");
    if (!dep) throw new Error("Lieu de départ manquant");
    if (!dst) throw new Error("Lieu de destination manquant");

    // Date future max +7 jours (paramétrable)
    const maxFutureDays = 7;
    const today = new Date(todayISO());
    const userD = new Date(dateMvt);
    const diffDays = (userD - today) / 86400000;
    if (diffDays > maxFutureDays) throw new Error("Date trop loin dans le futur (>7 jours)");

    const tzLocal = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, dateStyle:'short', timeStyle:'medium' }).format(new Date());

    const data = new URLSearchParams({
      code_scanné: code,
      type_code: type,
      lieu_depart: dep,
      lieu_destination: dst,
      date_mouvement: dateMvt,
      timestamp_utc: new Date().toISOString(),
      timestamp_local: tzLocal,
      device_id: navigator.userAgent,
      user_id: '',
      notes: els.notes.value || ''
    });

    const res = await fetch(API_URL, {
      method:'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: data.toString()
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "Erreur API");

    setStatus("✅ Enregistré dans Google Sheets");
    els.notes.value = '';
  }catch(e){
    console.error(e);
    setStatus("❌ " + e.message, false);
  }
});

// Init
window.addEventListener('load', loadListes);
