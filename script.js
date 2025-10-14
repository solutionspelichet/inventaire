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
let currentStream = null;
let selectedDeviceId = null;

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

// ===== Helpers =====
function setStatus(msg, ok=true){ els.status.textContent = msg||''; els.status.style.color = ok?'green':'crimson'; }
function todayISO(){ return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
els.dateMvt.value = todayISO();

// Samsung S24 ?
function isSamsungS24() {
  const ua = navigator.userAgent || "";
  return /SM-S92(1|6|8)/i.test(ua) || (/S24/i.test(ua) && /Samsung/i.test(ua));
}

// ===== Feedback (bip + vibration + flash cadre) =====
function feedback(){
  try{
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

// ===== Permissions / cameras =====
async function ensurePermission(){
  const s = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
  s.getTracks().forEach(t=>t.stop());
}
async function listCamerasAfterPermission(){
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d=>d.kind==='videoinput');
  els.camSel.innerHTML='';
  cams.forEach((c,i)=>{ const o=document.createElement('option'); o.value=c.deviceId; o.textContent=c.label||`Caméra ${i+1}`; els.camSel.appendChild(o); });
  // Sélectionne arrière si dispo
  const back = cams.find(c=>/back|rear|environment/i.test(c.label));
  if (back) els.camSel.value = back.deviceId;
  selectedDeviceId = els.camSel.value || (cams[0] && cams[0].deviceId) || null;
  return cams;
}

// ===== Torch / Zoom =====
function initCameraControls(){
  els.btnTorch.disabled=true; els.btnTorch.dataset.on='0'; els.btnTorch.textContent='Lampe OFF';
  els.zoomWrap.hidden=true;

  if (!currentStream) return;
  const tracks = currentStream.getVideoTracks();
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

// Torch standard + fallback ImageCapture + fallback « torch d’écran »
let screenTorchOn = false;
function screenTorch(enable){
  let overlay = document.getElementById('screenTorch');
  if (enable){
    if (!overlay){
      overlay = document.createElement('div');
      overlay.id = 'screenTorch';
      Object.assign(overlay.style, {
        position:'absolute', inset:'0', background:'#ffffff',
        opacity:'0.95', pointerEvents:'none' // laisse les boutons cliquables hors zone
      });
      els.videoWrap.appendChild(overlay);
    }
    overlay.style.display = 'block'; screenTorchOn = true;
  }else{
    if (overlay){ overlay.style.display = 'none'; }
    screenTorchOn = false;
  }
}
async function setTorch(on){
  // 1) Essayez le vrai torch
  if (videoTrack?.getCapabilities){
    try{
      const caps = videoTrack.getCapabilities();
      if ('torch' in caps){
        await videoTrack.applyConstraints({ advanced:[{ torch: !!on }] });
        screenTorch(false);
        return true;
      }
    }catch(e){ console.warn('Torch via constraints:', e); }
  }
  // 2) Fallback ImageCapture
  try{
    if ('ImageCapture' in window && videoTrack){
      const ic = new ImageCapture(videoTrack);
      if (ic.setOptions){ await ic.setOptions({ torch: !!on }); screenTorch(false); return true; }
    }
  }catch(e){ console.warn('Torch via ImageCapture:', e); }

  // 3) Dernier recours : « torch d’écran »
  screenTorch(!!on);
  return false; // on retourne false pour indiquer que le vrai flash n'est pas dispo
}
async function setZoom(v){
  if (!videoTrack?.getCapabilities) return false;
  const caps = videoTrack.getCapabilities(); if (!('zoom' in caps)) return false;
  try{ await videoTrack.applyConstraints({ advanced:[{ zoom:Number(v) }] }); els.zoomValue.textContent=`${Number(v).toFixed(1)}×`; return true; }catch{ return false; }
}
els.btnTorch.addEventListener('click', async ()=>{
  const on = els.btnTorch.dataset.on==='1';
  const ok = await setTorch(!on);
  els.btnTorch.dataset.on = on?'0':'1';
  els.btnTorch.textContent = (!on) ? (ok?'Lampe ON':'Lampe (écran) ON') : 'Lampe OFF';
});
els.zoomRange.addEventListener('input', e=> setZoom(e.target.value));

// ===== Overlay (cadre + netteté) =====
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
        const vEl = usingQuagga
          ? els.videoWrap.querySelector('video')   // vidéo insérée par Quagga
          : els.video;
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

// ===== Flux caméra (on gère le stream nous-mêmes) =====
async function openStreamForDevice(deviceId){
  // On force deviceId EXCLUSIF (et on enlève facingMode pour que Samsung respecte le choix)
  const constraints = {
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: isSamsungS24() ? { ideal: 1280, max: 1280 } : { ideal: 1920 },
      height:isSamsungS24() ? { ideal: 720,  max: 720  } : { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 }
    },
    audio: false
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return stream;
}
function attachStream(stream){
  // Stop ancien stream
  if (currentStream){ try{ currentStream.getTracks().forEach(t=>t.stop()); }catch{} }
  currentStream = stream;
  els.video.srcObject = stream;
  const tracks = stream.getVideoTracks();
  videoTrack = tracks && tracks[0] ? tracks[0] : null;
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

  // ZXing lit sur le même <video> (même stream). On reset ZXing mais on garde le stream.
  try{ codeReader && codeReader.reset(); }catch{}

  // Important : sur S24, laissez un petit délai avant de (re)lier Quagga
  const delay = isSamsungS24() ? 300 : 50;

  setTimeout(()=> {
    Quagga.init({
      inputStream: {
        name: 'Live',
        type: 'LiveStream',
        target: els.videoWrap,
        constraints: {
          // ⚠️ forcer le même deviceId que l'utilisateur a choisi
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment'
        }
      },
      locator: { patchSize:'medium', halfSample:true },
      numOfWorkers: 2,
      frequency: 15,
      decoder: { readers: quaggaReaders() },
      locate: true,
      area: { top: "39%", right: "7%", left: "7%", bottom: "39%" }
    }, (err)=>{
      if (err){ console.error(err); setStatus('Erreur Quagga: '+err.message, false); usingQuagga=false; return; }
      Quagga.start();
      setStatus('Lecture 1D (fallback) en cours…');
    });
    Quagga.onDetected(onQuaggaDetected);
  }, delay);
}
function stopQuagga(){
  if (!usingQuagga) return;
  try{ Quagga.stop(); }catch{}
  Quagga.offDetected(onQuaggaDetected);
  usingQuagga = false;
}
function onQuaggaDetected(res){
  const code = res?.codeResult?.code;
  if (!code) return;
  els.codeValue.value = code;
  lastCode = code; lastTime = Date.now();
  setStatus('✅ Code 1D détecté (fallback)');
  feedback();
  stopQuagga();
}

// ===== Start/Stop/Restart =====
async function start(){
  try{
    recreateReader();
    els.video.setAttribute('playsinline','true'); els.video.muted=true;

    await ensurePermission();
    const cams = await listCamerasAfterPermission();
    if (!cams.length){ setStatus("Aucune caméra détectée.", false); return; }
    selectedDeviceId = els.camSel.value || (cams[0] && cams[0].deviceId) || null;

    // Ouvre explicitement le flux pour CE deviceId
    const stream = await openStreamForDevice(selectedDeviceId);
    attachStream(stream);

    // Lancer ZXing sur NOTRE élément vidéo (et pas via getUserMedia interne)
    await codeReader.decodeFromVideoElement(els.video, (result, err) => {
      if (usingQuagga) return; // si fallback actif, on ignore ZXing
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

    initCameraControls();
    startOverlayLoop();

    // Fallback timing (évite écran noir sur S24 en laissant respirer le capteur)
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
  try{ if (currentStream) currentStream.getTracks().forEach(t=>t.stop()); }catch{}
  currentStream = null; videoTrack = null;

  stopOverlayLoop(); screenTorch(false);

  els.btnStart.disabled=false; els.btnStop.disabled=true;
  els.btnTorch.disabled=true; els.zoomWrap.hidden=true;
  els.btnTorch.dataset.on='0'; els.btnTorch.textContent='Lampe OFF';

  scanning=false; setStatus("Caméra arrêtée");
}
function restartScan(){ stop(); start(); }

// ===== Events =====
els.camSel.addEventListener('change', ()=>{ selectedDeviceId = els.camSel.value; if (scanning) restartScan(); });
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
