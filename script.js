// ===== Config =====
const API_URL = window.APP_CONFIG.API_URL;
const TZ = 'Europe/Zurich';

// ZXing
const { BrowserMultiFormatReader, NotFoundException, DecodeHintType, BarcodeFormat } = ZXing;

// ===== State =====
let scanning = false, lastCode = null, lastTime = 0;
let videoTrack = null, codeReader = null;
let currentFormats = null, currentHints = null;
let rafId = null;                // overlay loop
let fallbackTimer = null;        // déclenche Quagga si ZXing n'accroche pas
let usingQuagga = false;         // fallback actif ?

// ===== DOM =====
const els = {
  videoWrap: document.getElementById('videoWrap'),
  video: document.getElementById('preview'),
  overlay: document.getElementById('overlay'),
  focusMeter: document.getElementById('focusMeter'),

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

function setStatus(msg, ok=true){ els.status.textContent = msg||''; els.status.style.color = ok?'green':'crimson'; }
function todayISO(){ return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
els.dateMvt.value = todayISO();

// --- Détection Samsung S24 (S921/S926/S928) ---
function isSamsungS24() {
  const ua = navigator.userAgent || "";
  return /SM-S92(1|6|8)/i.test(ua) || (/S24/i.test(ua) && /Samsung/i.test(ua));
}

// --- Contraintes vidéo adaptées ---
function getVideoConstraints(selectedId) {
  const base = {
    facingMode: { ideal: 'environment' },
    width:  { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
    focusMode: 'continuous',
    advanced: [{ focusMode: 'continuous' }]
  };
  if (selectedId) base.deviceId = { exact: selectedId };

  // ⚠️ Sur S24, on passe en 1280x720 / 30fps pour stabiliser autofocus/torch
  if (isSamsungS24()) {
    base.width  = { ideal: 1280, max: 1280 };
    base.height = { ideal: 720,  max: 720  };
    base.frameRate = { ideal: 30, max: 30 };
  }
  return { video: base, audio: false };
}

// ===== Feedback (bip + vibration + flash cadre) =====
function feedback(){
  try{ // Web Audio beep ~120ms
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type='sine'; osc.frequency.value=880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime+0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.12);
    osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime+0.14);
  }catch{}
  if (navigator.vibrate) navigator.vibrate([50,30,50]);

  const c = els.overlay.getContext('2d');
  if (!c) return;
  const w=els.overlay.width, h=els.overlay.height;
  c.save(); c.strokeStyle='rgba(50,205,50,0.95)'; c.lineWidth=5; c.setLineDash([]); c.strokeRect(4,4,w-8,h-8); c.restore();
}

// ===== Hints / formats =====
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
  codeReader = new BrowserMultiFormatReader(hints, 250);
}
function is1DSelected(){
  const f = currentFormats||[];
  return f.length===1 && (f[0]===BarcodeFormat.EAN_13 || f[0]===BarcodeFormat.CODE_128 || f[0]===BarcodeFormat.CODE_39);
}

// ===== Permissions / cam list =====
async function ensurePermission(){
  const s = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
  s.getTracks().forEach(t=>t.stop());
}
async function listCamerasAfterPermission(){
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d=>d.kind==='videoinput');
  els.camSel.innerHTML='';
  cams.forEach((c,i)=>{ const o=document.createElement('option'); o.value=c.deviceId; o.textContent=c.label||`Caméra ${i+1}`; els.camSel.appendChild(o); });
  const back = cams.find(c=>/back|rear|environment/i.test(c.label));
  if (back) els.camSel.value = back.deviceId;
  return cams;
}
function waitForStream(){
  return new Promise(resolve=>{
    if (els.video.srcObject) return resolve();
    els.video.addEventListener('loadedmetadata', ()=>resolve(), { once:true });
  });
}

// ===== Torch / Zoom =====
function initCameraControls(){
  els.btnTorch.disabled=true; els.btnTorch.dataset.on='0'; els.btnTorch.textContent='Lampe OFF';
  els.zoomWrap.hidden=true;

  if (!els.video.srcObject) return;
  const tracks = els.video.srcObject.getVideoTracks();
  const track = tracks && tracks[0] ? tracks[0] : null;
  videoTrack = track;
  if (!track) return;

  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if ('torch' in (caps||{})) els.btnTorch.disabled=false;
  if ('zoom' in (caps||{})){
    const {min=1,max=1,step=0.1} = caps.zoom;
    els.zoomRange.min=min; els.zoomRange.max=max; els.zoomRange.step=step||0.1;
    try{
      const set = track.getSettings ? track.getSettings() : {};
      const cur = set.zoom ?? min;
      els.zoomRange.value=cur; els.zoomValue.textContent=`${Number(cur).toFixed(1)}×`;
    }catch{}
    els.zoomWrap.hidden=false;
  }
}

// Torch « double voie » (constraints puis ImageCapture)
async function setTorch(on){
  if (!videoTrack) return false;

  // 1) Tentative standard via applyConstraints
  try {
    const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    if (caps && 'torch' in caps) {
      await videoTrack.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    }
  } catch (e) { console.warn('Torch via constraints a échoué:', e); }

  // 2) Fallback via ImageCapture
  try {
    if ('ImageCapture' in window) {
      const ic = new ImageCapture(videoTrack);
      if (ic.setOptions) {
        await ic.setOptions({ torch: !!on });
        return true;
      }
      if (ic.getPhotoCapabilities) {
        const caps = await ic.getPhotoCapabilities();
        if (caps.fillLightMode && caps.fillLightMode.includes('flash')) {
          await ic.setOptions({ torch: !!on });
          return true;
        }
      }
    }
  } catch (e) { console.warn('Torch via ImageCapture a échoué:', e); }

  return false;
}
async function setZoom(v){
  if (!videoTrack?.getCapabilities) return false;
  const caps = videoTrack.getCapabilities(); if (!('zoom' in caps)) return false;
  try{ await videoTrack.applyConstraints({ advanced:[{ zoom:Number(v) }] }); els.zoomValue.textContent=`${Number(v).toFixed(1)}×`; return true; }catch{ return false; }
}
els.btnTorch.addEventListener('click', async ()=>{
  const on = els.btnTorch.dataset.on==='1';
  const ok = await setTorch(!on);
  if (ok){ els.btnTorch.dataset.on = on?'0':'1'; els.btnTorch.textContent = on?'Lampe OFF':'Lampe ON'; }
  else alert("Lampe non supportée sur cette caméra.");
});
els.zoomRange.addEventListener('input', e=> setZoom(e.target.value));

// ===== Overlay (cadre + netteté) aligné sur le CONTENEUR =====
function getRoi(w,h){
  const oneD = is1DSelected();
  if (oneD){
    const rw = Math.floor(w*0.86), rh=Math.floor(h*0.22);
    return { x: (w-rw)/2|0, y:(h-rh)/2|0, w:rw, h:rh };
  } else {
    const s = Math.floor(Math.min(w,h)*0.55);
    return { x:(w-s)/2|0, y:(h-s)/2|0, w:s, h:s };
  }
}
function drawReticle(ctx, roi){
  ctx.save(); ctx.strokeStyle='rgba(255,122,0,0.95)'; ctx.lineWidth=3; ctx.setLineDash([10,6]);
  ctx.strokeRect(roi.x, roi.y, roi.w, roi.h); ctx.restore();
}
function getActiveVideoEl(){
  if (usingQuagga){
    // Quagga insère son propre <video> dans videoWrap
    return els.videoWrap.querySelector('video');
  }
  return els.video;
}
function computeSharpness(videoEl, roi, tmpCanvas, tmpCtx){
  if (!videoEl || videoEl.readyState < 2) return 0;
  const targetW = 160, targetH = Math.max(90, Math.floor(roi.h*160/roi.w));
  tmpCanvas.width = targetW; tmpCanvas.height = targetH;
  tmpCtx.drawImage(videoEl, roi.x, roi.y, roi.w, roi.h, 0, 0, targetW, targetH);
  const { data, width, height } = tmpCtx.getImageData(0,0,targetW,targetH);
  const gray = new Float32Array(width*height);
  for (let i=0,j=0;i<data.length;i+=4,j++) gray[j] = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
  let sum=0,sum2=0,n=0;
  for (let y=1;y<height-1;y++){
    for (let x=1;x<width-1;x++){
      const idx=y*width+x;
      const lap=(gray[idx-1]+gray[idx+1]+gray[idx-width]+gray[idx+width])-4*gray[idx];
      sum+=lap; sum2+=lap*lap; n++;
    }
  }
  const mean=sum/n; return (sum2/n) - mean*mean;
}
function colorForSharpness(v){ return v>=120?'#32cd32':(v>=60?'#ffa500':'#ff3b30'); }

function startOverlayLoop(){
  const canvas = els.overlay, ctx = canvas.getContext('2d');
  const tmpCanvas = document.createElement('canvas'), tmpCtx = tmpCanvas.getContext('2d');

  function loop(){
    rafId = requestAnimationFrame(loop);
    // Taille basée sur le CONTENEUR (pas la balise video)
    const rect = els.videoWrap.getBoundingClientRect();
    const w = canvas.width = rect.width|0, h = canvas.height = rect.height|0;
    if (!w||!h) return;

    ctx.clearRect(0,0,w,h);
    const roi = getRoi(w,h);
    drawReticle(ctx, roi);

    const now = performance.now();
    if (!startOverlayLoop._last || now-startOverlayLoop._last>200){
      startOverlayLoop._last = now;
      try{
        const vEl = getActiveVideoEl();
        const sharp = computeSharpness(vEl, roi, tmpCanvas, tmpCtx);
        els.focusMeter.textContent = `Net: ${sharp.toFixed(0)}`;
        els.focusMeter.style.boxShadow = `0 0 0 2px ${colorForSharpness(sharp)} inset`;
      }catch{}
    }
  }
  cancelAnimationFrame(rafId); loop();
}
function stopOverlayLoop(){
  cancelAnimationFrame(rafId); rafId=null;
  const c = els.overlay.getContext('2d');
  c && c.clearRect(0,0,els.overlay.width,els.overlay.height);
  els.focusMeter.textContent='Net: —'; els.focusMeter.style.boxShadow='none';
}

// ===== Quagga2 Fallback =====
function quaggaReaders(){
  if (is1DSelected()){
    const f = currentFormats[0];
    if (f===BarcodeFormat.EAN_13) return ['ean_reader'];
    if (f===BarcodeFormat.CODE_128) return ['code_128_reader'];
    if (f===BarcodeFormat.CODE_39) return ['code_39_reader'];
  }
  return ['ean_reader','code_128_reader','code_39_reader'];
}
function startQuagga(){
  if (usingQuagga) return;
  usingQuagga = true;
  try{ codeReader && codeReader.reset(); }catch{}

  // Cache notre <video> pour éviter le "double flux" visible
  els.video.style.display = 'none';

  Quagga.init({
    inputStream: {
      name: 'Live',
      type: 'LiveStream',
      target: els.videoWrap,
      constraints: { facingMode:'environment', width:{ideal:1920}, height:{ideal:1080} }
    },
    locator: { patchSize:'medium', halfSample:true },
    numOfWorkers: 2,
    frequency: 15,
    decoder: { readers: quaggaReaders() },
    locate: true,
    // Bande centrale pour les 1D
    area: { top: "39%", right: "7%", left: "7%", bottom: "39%" }
  }, (err)=>{
    if (err){ console.error(err); setStatus('Erreur Quagga: '+err.message, false); usingQuagga=false; els.video.style.display='block'; return; }
    Quagga.start();
    setStatus('Lecture 1D (fallback) en cours…');
  });

  Quagga.onDetected(onQuaggaDetected);
}
function stopQuagga(){
  if (!usingQuagga) return;
  try{ Quagga.stop(); }catch{}
  Quagga.offDetected(onQuaggaDetected);
  usingQuagga = false;
  // Ré-affiche notre <video> pour ZXing
  els.video.style.display = 'block';
}
function onQuaggaDetected(res){
  const code = res?.codeResult?.code;
  if (!code) return;
  els.codeValue.value = code;
  lastCode = code; lastTime = Date.now();
  setStatus('✅ Code 1D détecté (fallback)');
  feedback();
  stopQuagga(); // stop après détection
}

// ===== Start/Stop/Restart =====
async function start(){
  try{
    recreateReader();
    els.video.setAttribute('playsinline','true'); els.video.muted=true;

    await ensurePermission();
    const cams = await listCamerasAfterPermission();
    if (!cams.length){ setStatus("Aucune caméra détectée.", false); return; }
    const selectedId = els.camSel.value || cams[0].deviceId;

    const constraints = getVideoConstraints(selectedId);

    await codeReader.decodeFromConstraints(constraints, els.video, (result, err) => {
      if (usingQuagga) return;
      if (result){
        const code = result.getText();
        const now = Date.now();
        if (code===lastCode && (now-lastTime)<8000){
          alert("Attention : même code scanné à la suite. Voulez-vous l'enregistrer à nouveau ?");
        }
        els.codeValue.value = code;
        lastCode = code; lastTime = now;
        setStatus('✅ Code détecté');
        feedback();
        if (fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer=null; }
      } else if (err && !(err instanceof NotFoundException)){
        console.warn(err);
      }
    });

    await waitForStream();
    initCameraControls();
    startOverlayLoop();

    // Fallback timing
    const timeoutMs = is1DSelected() ? 2500 : 4000;
    fallbackTimer = setTimeout(()=>{
      const onlyQR = currentFormats?.length===1 && currentFormats[0]===BarcodeFormat.QR_CODE;
      if (!usingQuagga && !onlyQR) startQuagga();
    }, timeoutMs);

    scanning = true; els.btnStart.disabled=true; els.btnStop.disabled=false;
    setStatus(is1DSelected()
      ? "Caméra démarrée (1D). Gardez le code horizontal, 60–80% de la largeur, bonne lumière."
      : "Caméra démarrée (Auto). Les QR lisent d'abord; 1D passe en fallback si besoin."
    );
  }catch(e){
    console.error(e);
    setStatus("Impossible de démarrer la caméra. Vérifiez l'autorisation et réessayez.", false);
  }
}
function stop(){
  try{ codeReader && codeReader.reset(); }catch{}
  stopQuagga();
  if (fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer=null; }
  const s = els.video.srcObject;
  if (s && s.getTracks) s.getTracks().forEach(t=>t.stop());
  els.video.srcObject=null; videoTrack=null;

  stopOverlayLoop();

  els.btnStart.disabled=false; els.btnStop.disabled=true;
  els.btnTorch.disabled=true; els.zoomWrap.hidden=true;
  els.btnTorch.dataset.on='0'; els.btnTorch.textContent='Lampe OFF';

  scanning=false; setStatus("Caméra arrêtée");
}
function restartScan(){ stop(); start(); }

// ===== Events =====
els.camSel.addEventListener('change', ()=>{ if (scanning) restartScan(); });
els.codeType.addEventListener('change', ()=>{ if (scanning) restartScan(); });
els.btnStart.addEventListener('click', start);
els.btnStop.addEventListener('click', stop);

// ===== Listes & Envoi =====
async function loadListes(){
  try{
    setStatus("Chargement des listes…");
    const r = await fetch(`${API_URL}?action=listes`);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error||"Erreur listes");
    fill(els.depart, j.depart); fill(els.destination, j.destination);
    setStatus("Listes chargées");
  }catch(e){ setStatus("Erreur listes: "+e.message, false); }
}
function fill(sel, arr){ sel.innerHTML=''; arr.forEach(v=>{ const o=document.createElement('option'); o.value=v; o.textContent=v; sel.appendChild(o); }); }

els.submit.addEventListener('click', async ()=>{
  try{
    const code = els.codeValue.value.trim(), type=els.codeType.value, dep=els.depart.value, dst=els.destination.value, dateMvt=els.dateMvt.value;
    if (!code) throw new Error("Code manquant");
    if (!dep) throw new Error("Lieu de départ manquant");
    if (!dst) throw new Error("Lieu de destination manquant");

    const maxFutureDays=7, today=new Date(todayISO()), userD=new Date(dateMvt);
    if ((userD - today)/86400000 > maxFutureDays) throw new Error("Date trop loin dans le futur (>7 jours)");

    const tzLocal = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, dateStyle:'short', timeStyle:'medium' }).format(new Date());
    const data = new URLSearchParams({
      code_scanné: code, type_code: type, lieu_depart: dep, lieu_destination: dst, date_mouvement: dateMvt,
      timestamp_utc: new Date().toISOString(), timestamp_local: tzLocal, device_id: navigator.userAgent, user_id:'', notes: els.notes.value || ''
    });

    const resp = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: data.toString() });
    const j = await resp.json();
    if (!j.ok) throw new Error(j.error||"Erreur API");

    setStatus("✅ Enregistré dans Google Sheets"); els.notes.value='';
    restartScan(); // relance propre après sauvegarde
  }catch(e){ setStatus("❌ "+e.message, false); }
});

// Init
window.addEventListener('load', loadListes);
