// ===== Config =====
const API_URL = window.APP_CONFIG.API_URL;
const TZ = 'Europe/Zurich';

// Libs
const { BrowserMultiFormatReader, NotFoundException, DecodeHintType, BarcodeFormat } = ZXing;

// ===== State =====
let scanning = false;
let videoTrack = null;
let currentStream = null;
let codeReader = null;
let rafId = null;
let nativeScanId = null;
let usingQuagga = false;
let fallbackTimer = null;

let lastCode = null, lastTime = 0;

let selectedDeviceId = null;
let selectedWidth = 1920, selectedHeight = 1080;
let selectedEngine = 'auto';

// ===== DOM =====
const els = {
  videoWrap: document.getElementById('videoWrap'),
  video: document.getElementById('preview'),
  overlay: document.getElementById('overlay'),
  focusMeter: document.getElementById('focusMeter'),
  diag: document.getElementById('diag'),

  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  camSel: document.getElementById('cameraSelect'),
  resSel: document.getElementById('resSelect'),
  engineSel: document.getElementById('engineSelect'),

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
function isSamsungS24(){ const ua=navigator.userAgent||""; return /SM-S92(1|6|8)/i.test(ua) || (/S24/i.test(ua)&&/Samsung/i.test(ua)); }

// ===== Helpers =====
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

  const c = els.overlay.getContext('2d'); if (!c) return;
  const w=els.overlay.width, h=els.overlay.height;
  c.save(); c.strokeStyle='rgba(50,205,50,0.95)'; c.lineWidth=5; c.setLineDash([]); c.strokeRect(4,4,w-8,h-8); c.restore();
}

function buildHints(){
  const val = els.codeType.value;
  let formats;
  if (val==='QR_CODE') formats=[BarcodeFormat.QR_CODE];
  else if (val==='EAN_13') formats=[BarcodeFormat.EAN_13];
  else if (val==='CODE_128') formats=[BarcodeFormat.CODE_128];
  else if (val==='CODE_39') formats=[BarcodeFormat.CODE_39];
  else formats=[BarcodeFormat.QR_CODE, BarcodeFormat.EAN_13, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39];
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return { formats, hints };
}
function recreateReader(){ const {hints}=buildHints(); codeReader = new BrowserMultiFormatReader(hints, 200); }

function is1DMode(){
  const v = els.codeType.value;
  return v==='EAN_13' || v==='CODE_128' || v==='CODE_39';
}

function diagWrite(text){ els.diag.textContent = text; }

// ===== EAN-13 validation (éviter faux positifs 1D) =====
function ean13IsValid(code){
  if (!/^\d{13}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reduce((acc,d,i)=> acc + (i%2? d*3 : d), 0);
  const calc = (10 - (sum % 10)) % 10;
  return calc === check;
}

// ===== Permissions / cameras =====
async function ensurePermission(){
  const s = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
  s.getTracks().forEach(t=>t.stop());
}

async function listCameras(){
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d=>d.kind==='videoinput');
  els.camSel.innerHTML='';
  cams.forEach((c,i)=> {
    const opt = document.createElement('option');
    opt.value = c.deviceId;
    opt.textContent = c.label || `Caméra ${i+1}`;
    els.camSel.appendChild(opt);
  });
  // choisir la back si identifiable
  const back = cams.find(c=>/back|rear|environment/i.test(c.label));
  els.camSel.value = back ? back.deviceId : (cams[0]?.deviceId || '');
  selectedDeviceId = els.camSel.value;
  return cams;
}

// ===== Stream open/close =====
async function openStream(){
  const isS24 = isSamsungS24();
  const constraints = {
    video: {
      deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
      width:  { ideal: selectedWidth,  max: selectedWidth  },
      height: { ideal: selectedHeight, max: selectedHeight },
      frameRate: { ideal: 30, max: 30 },
      // le focus n'est pas standardisé, on tente quand même
      advanced: [{ focusMode: 'continuous' }]
    },
    audio: false
  };
  // Sur certains Honor, demander trop grand échoue -> on tente dégradé
  try{
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return stream;
  }catch(e){
    if (selectedWidth>1280){ // rétrograder
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: selectedDeviceId?{exact:selectedDeviceId}:undefined, width:{ideal:1280,max:1280}, height:{ideal:720,max:720}, frameRate:{ideal:30,max:30} },
        audio:false
      });
    return stream;
    }
    throw e;
  }
}

function attachStream(stream){
  // stop ancien
  try{ if (currentStream) currentStream.getTracks().forEach(t=>t.stop()); }catch{}
  currentStream = stream;
  els.video.srcObject = stream;

  const tr = stream.getVideoTracks()[0];
  videoTrack = tr || null;

  // diag
  try{
    const s = tr.getSettings?.() || {};
    const c = tr.getCapabilities?.() || {};
    diagWrite(`${s.width||'?'}×${s.height||'?'} | AF:${c.focusMode ? 'oui' : '—'} | Zoom:${c.zoom?'oui':'—'} | Torch:${'torch' in c?'oui':'—'}`);
  }catch{ diagWrite('—'); }
}

// ===== Torch / Zoom =====
function initCamControls(){
  els.btnTorch.disabled = true;
  els.zoomWrap.hidden = true;
  if (!videoTrack) return;
  const caps = videoTrack.getCapabilities?.() || {};
  // torch
  if ('torch' in caps) els.btnTorch.disabled = false;
  // zoom
  if ('zoom' in caps){
    const {min=1,max=1,step=0.1} = caps.zoom;
    els.zoomRange.min=min; els.zoomRange.max=max; els.zoomRange.step=step||0.1;
    const cur = videoTrack.getSettings?.().zoom ?? min;
    els.zoomRange.value = cur; els.zoomValue.textContent = `${Number(cur).toFixed(1)}×`;
    els.zoomWrap.hidden = false;
  }
}

async function setTorch(on){
  if (!videoTrack?.getCapabilities) return false;
  const caps = videoTrack.getCapabilities();
  if (!('torch' in caps)) return false;
  try{
    await videoTrack.applyConstraints({ advanced:[{ torch: !!on }] });
    return true;
  }catch{ return false; }
}
async function setZoom(v){
  if (!videoTrack?.getCapabilities) return false;
  const caps = videoTrack.getCapabilities();
  if (!('zoom' in caps)) return false;
  try{
    await videoTrack.applyConstraints({ advanced: [{ zoom: Number(v) }] });
    els.zoomValue.textContent = `${Number(v).toFixed(1)}×`;
    return true;
  }catch{ return false; }
}
els.btnTorch.addEventListener('click', async ()=>{
  const on = els.btnTorch.dataset.on==='1';
  const ok = await setTorch(!on);
  if (ok){ els.btnTorch.dataset.on = on?'0':'1'; els.btnTorch.textContent = on?'Lampe OFF':'Lampe ON'; }
  else alert("Lampe non supportée par cette caméra.");
});
els.zoomRange.addEventListener('input', e=> setZoom(e.target.value));

// Double-tap pour zoom x1/x2/x3
let lastTap = 0;
els.videoWrap.addEventListener('touchend', () => {
  const now = Date.now();
  if (now-lastTap < 300){
    const step = Number(els.zoomRange.step)||0.1;
    const cur = Number(els.zoomRange.value);
    let next = cur < 1.8 ? 2 : (cur < 2.8 ? 3 : 1);
    if (Number.isFinite(next)) { els.zoomRange.value = next; setZoom(next); }
  }
  lastTap = now;
}, { passive:true });

// ===== Overlay (cadre + netteté) =====
function getRoi(w,h){
  if (is1DMode()){
    const rw = Math.floor(w*0.86), rh=Math.floor(h*0.22);
    return { x:(w-rw)/2|0, y:(h-rh)/2|0, w:rw, h:rh };
  }
  const s = Math.floor(Math.min(w,h)*0.55);
  return { x:(w-s)/2|0, y:(h-s)/2|0, w:s, h:s };
}
function drawReticle(ctx, roi){
  ctx.save(); ctx.strokeStyle='rgba(255,122,0,0.95)'; ctx.lineWidth=3; ctx.setLineDash([10,6]);
  ctx.strokeRect(roi.x,roi.y,roi.w,roi.h); ctx.restore();
}
function computeSharpness(videoEl, roi, tmpCanvas, tmpCtx){
  if (!videoEl || videoEl.readyState<2) return 0;
  const targetW=160, targetH=Math.max(90, Math.floor(roi.h*160/roi.w));
  tmpCanvas.width=targetW; tmpCanvas.height=targetH;
  tmpCtx.drawImage(videoEl, roi.x,roi.y,roi.w,roi.h, 0,0,targetW,targetH);
  const { data, width, height } = tmpCtx.getImageData(0,0,targetW,targetH);
  const gray=new Float32Array(width*height);
  for (let i=0,j=0;i<data.length;i+=4,j++) gray[j]=0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
  let sum=0,sum2=0,n=0;
  for (let y=1;y<height-1;y++) for (let x=1;x<width-1;x++){
    const idx=y*width+x;
    const lap=(gray[idx-1]+gray[idx+1]+gray[idx-width]+gray[idx+width])-4*gray[idx];
    sum+=lap; sum2+=lap*lap; n++;
  }
  const mean=sum/n; return (sum2/n)-mean*mean;
}
function startOverlayLoop(){
  const canvas=els.overlay, ctx=canvas.getContext('2d');
  const tmpCanvas=document.createElement('canvas'), tmpCtx=tmpCanvas.getContext('2d');
  function loop(){
    rafId = requestAnimationFrame(loop);
    const rect = els.videoWrap.getBoundingClientRect();
    const w = canvas.width = rect.width|0, h = canvas.height = rect.height|0;
    if (!w||!h) return;
    ctx.clearRect(0,0,w,h);
    const roi=getRoi(w,h); drawReticle(ctx,roi);
    const now = performance.now();
    if (!startOverlayLoop._last || now - startOverlayLoop._last > 200){
      startOverlayLoop._last = now;
      try{
        const sharp = computeSharpness(els.video, roi, tmpCanvas, tmpCtx);
        els.focusMeter.textContent = `Net: ${sharp.toFixed(0)}`;
      }catch{}
    }
  }
  cancelAnimationFrame(rafId); loop();
}
function stopOverlayLoop(){ cancelAnimationFrame(rafId); rafId=null; const c=els.overlay.getContext('2d'); c&&c.clearRect(0,0,els.overlay.width,els.overlay.height); els.focusMeter.textContent='Net: —'; }

// ===== Engines =====

// Native
let detector = null;
async function setupDetector(){
  if (!('BarcodeDetector' in window)) return false;
  const val=els.codeType.value;
  let formats=['qr_code','ean_13','code_128','code_39'];
  if (val==='QR_CODE') formats=['qr_code'];
  if (val==='EAN_13')  formats=['ean_13'];
  if (val==='CODE_128') formats=['code_128'];
  if (val==='CODE_39') formats=['code_39'];
  try{
    const supported = await BarcodeDetector.getSupportedFormats();
    const list = formats.filter(f=>supported.includes(f));
    if (!list.length) return false;
    detector = new BarcodeDetector({ formats:list });
    return true;
  }catch{ return false; }
}
function stopNativeLoop(){ if (nativeScanId){ cancelAnimationFrame(nativeScanId); nativeScanId=null; } }
function startNativeLoop(){
  stopNativeLoop();
  const off = document.createElement('canvas'), ctx = off.getContext('2d');
  const loop = async ()=>{
    nativeScanId = requestAnimationFrame(loop);
    const rect=els.videoWrap.getBoundingClientRect();
    const w=rect.width|0, h=rect.height|0;
    if (!w||!h || !els.video.videoWidth) return;
    const roi=getRoi(w,h);
    off.width=roi.w; off.height=roi.h;
    ctx.drawImage(els.video, roi.x,roi.y,roi.w,roi.h, 0,0,roi.w,roi.h);
    try{
      const dets = await detector.detect(off);
      if (dets && dets.length){
        const code = dets[0].rawValue;
        if (!code) return;
        if (els.codeType.value==='EAN_13' && !ean13IsValid(code)) return; // filtre
        els.codeValue.value = code; lastCode=code; lastTime=Date.now();
        setStatus('✅ Code détecté (natif)'); feedback();
        if (fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer=null; }
      }
    }catch{}
  };
  loop();
}

// ZXing
function startZXing(){
  recreateReader();
  codeReader.decodeFromVideoElement(els.video,(result, err)=>{
    if (result){
      const code = result.getText();
      if (els.codeType.value==='EAN_13' && !ean13IsValid(code)) return;
      els.codeValue.value = code; lastCode=code; lastTime=Date.now();
      setStatus('✅ Code détecté (ZXing)'); feedback();
      if (fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer=null; }
    } else if (err && !(err instanceof NotFoundException)){
      console.warn(err);
    }
  });
}
function stopZXing(){ try{ codeReader && codeReader.reset(); }catch{} }

// Quagga (1D)
function quaggaReaders(){
  const v=els.codeType.value;
  if (v==='EAN_13') return ['ean_reader'];
  if (v==='CODE_128') return ['code_128_reader'];
  if (v==='CODE_
