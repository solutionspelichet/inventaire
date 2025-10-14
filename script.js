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
let macroMode = false;

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
  btnMacro: document.getElementById('btnMacro'),
  btnPhoto: document.getElementById('btnPhoto'),
  photoInput: document.getElementById('photoInput'),
  photoStatus: document.getElementById('photoStatus'),
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
function setPhotoStatus(msg){ els.photoStatus.textContent = msg||''; }
function todayISO(){ return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
els.dateMvt.value = todayISO();
function isSamsungS24(){ const ua=navigator.userAgent||""; return /SM-S92(1|6|8)/i.test(ua) || (/S24/i.test(ua)&&/Samsung/i.test(ua)); }

// ===== Feedback =====
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

// ===== Formats =====
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
function is1DMode(){ const v = els.codeType.value; return v==='EAN_13' || v==='CODE_128' || v==='CODE_39'; }

// ===== Validation EAN-13 =====
function ean13IsValid(code){
  if (!/^\d{13}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reduce((acc,d,i)=> acc + (i%2? d*3 : d), 0);
  const calc = (10 - (sum % 10)) % 10;
  return calc === check;
}

// ===== Permissions & cam list =====
async function ensurePermission(){
  const s = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
  s.getTracks().forEach(t=>t.stop());
}
async function listCameras(){
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d=>d.kind==='videoinput');
  els.camSel.innerHTML='';
  cams.forEach((c,i)=> {
    const opt=document.createElement('option');
    opt.value=c.deviceId; opt.textContent=c.label||`Caméra ${i+1}`;
    els.camSel.appendChild(opt);
  });
  const back = cams.find(c=>/back|rear|environment/i.test(c.label));
  els.camSel.value = back ? back.deviceId : (cams[0]?.deviceId || '');
  selectedDeviceId = els.camSel.value;
  return cams;
}

// ===== Macro helpers =====
async function pickUltraWideDeviceId() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const cams = devs.filter(d => d.kind === 'videoinput');
  const match = cams.find(c => /ultra|uw|0\.5|wide\s*angle/i.test(c.label));
  return match ? match.deviceId : null;
}

// ===== Stream open/attach =====
async function openStream(){
  const wantW = macroMode ? 3840 : selectedWidth;
  const wantH = macroMode ? 2160 : selectedHeight;

  let deviceToUse = selectedDeviceId;
  if (macroMode) {
    const uw = await pickUltraWideDeviceId();
    if (uw) deviceToUse = uw;
  }

  const isS24 = isSamsungS24();
  const base = {
    video: {
      deviceId: deviceToUse ? { exact: deviceToUse } : undefined,
      width:  isS24 ? { ideal: Math.min(wantW,1920), max: Math.min(wantW,1920) } : { ideal: wantW, max: wantW },
      height: isS24 ? { ideal: Math.min(wantH,1080), max: Math.min(wantH,1080) } : { ideal: wantH, max: wantH },
      frameRate: { ideal: 30, max: 30 }
    },
    audio: false
  };

  try {
    return await navigator.mediaDevices.getUserMedia(base);
  } catch(e) {
    // Dégrade si besoin
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { deviceId: deviceToUse?{exact:deviceToUse}:undefined, width:{ideal:1280,max:1280}, height:{ideal:720,max:720}, frameRate:{ideal:30,max:30} },
        audio:false
      });
    } catch(e2) {
      throw e2;
    }
  }
}
function attachStream(stream){
  try{ if (currentStream) currentStream.getTracks().forEach(t=>t.stop()); }catch{}
  currentStream = stream;
  els.video.srcObject = stream;
  const tr = stream.getVideoTracks()[0];
  videoTrack = tr || null;
  try{
    const s = tr.getSettings?.() || {};
    const c = tr.getCapabilities?.() || {};
    els.diag.textContent = `${s.width||'?'}×${s.height||'?'} | AF:${c.focusMode?'oui':'—'} | Zoom:${c.zoom?'oui':'—'} | Torch:${'torch' in c?'oui':'—'}`;
  }catch{ els.diag.textContent='—'; }
}

// ===== Torch / Zoom =====
function initCamControls(){
  els.btnTorch.disabled = true; els.btnTorch.dataset.on='0'; els.btnTorch.textContent='Lampe OFF';
  els.zoomWrap.hidden = true;
  if (!videoTrack) return;
  const caps = videoTrack.getCapabilities?.() || {};
  if ('torch' in caps) els.btnTorch.disabled = false;
  if ('zoom' in caps){
    const {min=1,max=1,step=0.1} = caps.zoom;
    els.zoomRange.min=min; els.zoomRange.max=max; els.zoomRange.step=step||0.1;
    const cur = videoTrack.getSettings?.().zoom ?? min;
    els.zoomRange.value = cur; els.zoomValue.textContent = `${Number(cur).toFixed(1)}×`;
    els.zoomWrap.hidden=false;
  }
}
async function setTorch(on){
  if (!videoTrack?.getCapabilities) return false;
  const caps = videoTrack.getCapabilities();
  if (!('torch' in caps)) return false;
  try{ await videoTrack.applyConstraints({ advanced:[{ torch: !!on }] }); return true; }catch{ return false; }
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
  else alert("Lampe non supportée par cette caméra (utilisez le flash natif en mode photo).");
});
els.zoomRange.addEventListener('input', e=> setZoom(e.target.value));

// ===== Overlay (cadre + netteté) =====
function getRoi(w,h){
  if (is1DMode()){ const rw=(w*0.86)|0, rh=(h*0.22)|0; return { x:((w-rw)/2)|0, y:((h-rh)/2)|0, w:rw, h:rh }; }
  const s=(Math.min(w,h)*0.55)|0; return { x:((w-s)/2)|0, y:((h-s)/2)|0, w:s, h:s };
}
function drawReticle(ctx, roi){ ctx.save(); ctx.strokeStyle='rgba(255,122,0,0.95)'; ctx.lineWidth=3; ctx.setLineDash([10,6]); ctx.strokeRect(roi.x,roi.y,roi.w,roi.h); ctx.restore(); }
function computeSharpness(videoEl, roi, tmpCanvas, tmpCtx){
  if (!videoEl || videoEl.readyState<2) return 0;
  const targetW=160, targetH=Math.max(90, (roi.h*160/roi.w)|0);
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
  const off=document.createElement('canvas'), offCtx=off.getContext('2d');
  function loop(){
    rafId=requestAnimationFrame(loop);
    const rect=els.videoWrap.getBoundingClientRect();
    const w=canvas.width=rect.width|0, h=canvas.height=rect.height|0;
    if (!w||!h) return;
    ctx.clearRect(0,0,w,h);
    const roi=getRoi(w,h); drawReticle(ctx,roi);
    const now=performance.now();
    if (!startOverlayLoop._last || now-startOverlayLoop._last>200){
      startOverlayLoop._last=now;
      try{ const sharp=computeSharpness(els.video, roi, off, offCtx); els.focusMeter.textContent=`Net: ${sharp.toFixed(0)}`; }catch{}
    }
  }
  cancelAnimationFrame(rafId); loop();
}
function stopOverlayLoop(){ cancelAnimationFrame(rafId); rafId=null; const c=els.overlay.getContext('2d'); c&&c.clearRect(0,0,els.overlay.width,els.overlay.height); els.focusMeter.textContent='Net: —'; }

// ===== Live engines (robust) =====
let detector=null;
async function setupDetector(){
  if (!('BarcodeDetector' in window)) return false;
  const val=els.codeType.value;
  let formats=['qr_code','ean_13','code_128','code_39'];
  if (val==='QR_CODE') formats=['qr_code'];
  if (val==='EAN_13')  formats=['ean_13'];
  if (val==='CODE_128') formats=['code_128'];
  if (val==='CODE_39') formats=['code_39'];
  try{
    const supported=await BarcodeDetector.getSupportedFormats();
    const list=formats.filter(f=>supported.includes(f));
    if (!list.length) return false;
    detector=new BarcodeDetector({formats:list});
    return true;
  }catch{ return false; }
}
function stopNativeLoop(){ if (nativeScanId){ cancelAnimationFrame(nativeScanId); nativeScanId=null; } }

// petit pré-traitement image (contraste/levels) pour 1D
function enhanceInto(srcVideo, roi){
  const cv=document.createElement('canvas'), cx=cv.getContext('2d');
  cv.width=roi.w; cv.height=roi.h;
  cx.drawImage(srcVideo, roi.x,roi.y,roi.w,roi.h, 0,0,roi.w,roi.h);
  const img=cx.getImageData(0,0,roi.w,roi.h);
  const d=img.data;
  // niveaux + léger sharpen (unsharp mask cheap)
  // niveaux
  for(let i=0;i<d.length;i+=4){
    let r=d[i], g=d[i+1], b=d[i+2];
    // contraste gamma ~0.9
    r = Math.min(255, Math.max(0, (r-10)*1.15));
    g = Math.min(255, Math.max(0, (g-10)*1.15));
    b = Math.min(255, Math.max(0, (b-10)*1.15));
    d[i]=r; d[i+1]=g; d[i+2]=b;
  }
  cx.putImageData(img,0,0);
  return cv;
}

function startNativeLoop(){
  stopNativeLoop();
  const loop=async ()=>{
    nativeScanId=requestAnimationFrame(loop);
    const rect=els.videoWrap.getBoundingClientRect(); const w=rect.width|0, h=rect.height|0;
    if (!w||!h || !els.video.videoWidth) return;
    const roi=getRoi(w,h);

    // Prétraitement pour améliorer les 1D
    const processed = is1DMode() ? enhanceInto(els.video, roi) : null;
    const source = processed || els.video;

    try{
      const dets=await detector.detect(source);
      if (dets && dets.length){
        const code=dets[0].rawValue; if (!code) return;
        if (els.codeType.value==='EAN_13' && !ean13IsValid(code)) return;
        // anti-doublon trop rapproché
        const now=Date.now(); if (code===lastCode && now-lastTime<800) return;
        els.codeValue.value=code; lastCode=code; lastTime=now;
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
  codeReader.decodeFromVideoElement(els.video,(result,err)=>{
    if (result){
      const code=result.getText();
      if (els.codeType.value==='EAN_13' && !ean13IsValid(code)) return;
      const now=Date.now(); if (code===lastCode && now-lastTime<800) return;
      els.codeValue.value=code; lastCode=code; lastTime=now;
      setStatus('✅ Code détecté (ZXing)'); feedback();
      if (fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer=null; }
    } else if (err && !(err instanceof NotFoundException)){
      console.warn(err);
    }
  });
}
function stopZXing(){ try{ codeReader && codeReader.reset(); }catch{} }

// Quagga (1D live)
function quaggaReaders(){
  const v=els.codeType.value;
  if (v==='EAN_13') return ['ean_reader'];
  if (v==='CODE_128') return ['code_128_reader'];
  if (v==='CODE_39') return ['code_39_reader'];
  return ['ean_reader','code_128_reader','code_39_reader'];
}
function startQuagga(){
  if (usingQuagga) return; usingQuagga=true;
  stopNativeLoop(); stopZXing();

  const constraints = {
    deviceId: selectedDeviceId?{exact:selectedDeviceId}:undefined,
    width:{ideal:1280}, height:{ideal:720} // plus stable pour Samsung en 1D
  };

  setTimeout(()=>{
    Quagga.init({
      inputStream:{ name:'Live', type:'LiveStream', target:els.videoWrap, constraints },
      locator:{ patchSize:'medium', halfSample:true },
      numOfWorkers:2, frequency:15,
      decoder:{ readers: quaggaReaders() },
      locate:true,
      area:{ top:"39%", right:"7%", left:"7%", bottom:"39%" }
    }, (err)=>{
      if (err){ console.error(err); setStatus('Erreur Quagga: '+err.message,false); usingQuagga=false; return; }
      Quagga.start(); setStatus('Lecture 1D (Quagga)…');
    });
    Quagga.onDetected((res)=>{
      const code=res?.codeResult?.code; if (!code) return;
      if (els.codeType.value==='EAN_13' && !ean13IsValid(code)) return;
      const now=Date.now(); if (code===lastCode && now-lastTime<800) return;
      els.codeValue.value=code; lastCode=code; lastTime=now;
      setStatus('✅ Code détecté (Quagga)'); feedback(); stopQuagga();
    });
  }, isSamsungS24()? 300 : 50);
}
function stopQuagga(){ if (!usingQuagga) return; try{ Quagga.stop(); }catch{} Quagga.offDetected(()=>{}); usingQuagga=false; }

// ===== Start/Stop (live) =====
async function start(){
  try{
    await ensurePermission();
    const cams=await listCameras();
    if (!cams.length){ setStatus("Aucune caméra détectée.", false); return; }

    const [w,h]=els.resSel.value.split('x').map(n=>parseInt(n,10));
    selectedWidth=w; selectedHeight=h;
    selectedEngine=els.engineSel.value;

    const stream=await openStream();
    attachStream(stream);

    els.video.setAttribute('playsinline','true'); els.video.muted=true;
    await new Promise(r=> els.video.onloadedmetadata = r );

    initCamControls();
    startOverlayLoop();

    const hasNative = await setupDetector();
    if (selectedEngine==='native' || (selectedEngine==='auto' && hasNative)){
      startNativeLoop();
    } else if (selectedEngine==='zxing' || (selectedEngine==='auto' && !hasNative)) {
      startZXing();
    } else {
      startQuagga();
    }

    if (selectedEngine!=='quagga'){
      const t = is1DMode() ? 2500 : 4000;
      fallbackTimer=setTimeout(()=>{
        const onlyQR = els.codeType.value==='QR_CODE';
        if (!usingQuagga && !onlyQR) startQuagga();
      }, t);
    }

    scanning=true; els.btnStart.disabled=true; els.btnStop.disabled=false;
    setStatus('Caméra démarrée');
  }catch(e){
    console.error(e);
    setStatus("Impossible de démarrer la caméra. Vérifiez l'autorisation et réessayez.", false);
  }
}
function stop(){
  stopNativeLoop(); stopZXing(); stopQuagga();
  if (fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer=null; }
  try{ if (currentStream) currentStream.getTracks().forEach(t=>t.stop()); }catch{}
  currentStream=null; videoTrack=null;
  stopOverlayLoop();

  els.btnStart.disabled=false; els.btnStop.disabled=true;
  els.btnTorch.disabled=true; els.zoomWrap.hidden=true;
  els.btnTorch.dataset.on='0'; els.btnTorch.textContent='Lampe OFF';
  setStatus("Caméra arrêtée");
  scanning=false;
}
function restart(){ stop(); start(); }

// ===== Photo pipeline (fiable) =====
function quaggaReadersImage(){
  const v=els.codeType.value;
  if (v==='EAN_13') return ['ean_reader'];
  if (v==='CODE_128') return ['code_128_reader'];
  if (v==='CODE_39') return ['code_39_reader'];
  return ['ean_reader','code_128_reader','code_39_reader'];
}

function drawImageFitted(img, maxSide=1600, rotateQuarterTurns=0, enhance=true){
  const sw = img.width || img.naturalWidth, sh = img.height || img.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const tw = Math.round(sw * scale), th = Math.round(sh * scale);

  const cv = document.createElement('canvas'), cx = cv.getContext('2d');

  // handle rotation by 90° increments
  if (rotateQuarterTurns % 2 === 1){
    cv.width = th; cv.height = tw;
    cx.translate(cv.width/2, cv.height/2);
    cx.rotate((Math.PI/2) * rotateQuarterTurns);
    cx.drawImage(img, -tw/2, -th/2, tw, th);
  } else {
    cv.width = tw; cv.height = th;
    cx.drawImage(img, 0, 0, tw, th);
  }

  if (enhance){
    // simple levels + mild sharpen
    const id = cx.getImageData(0,0,cv.width,cv.height);
    const d = id.data;
    for (let i=0;i<d.length;i+=4){
      d[i] = Math.min(255, Math.max(0, (d[i]-8)*1.12));
      d[i+1] = Math.min(255, Math.max(0, (d[i+1]-8)*1.12));
      d[i+2] = Math.min(255, Math.max(0, (d[i+2]-8)*1.12));
    }
    cx.putImageData(id,0,0);
  }
  return cv;
}

async function detectFromImageBitmap(bitmap){
  // 1) Natif si dispo
  if ('BarcodeDetector' in window){
    try{
      const val=els.codeType.value;
      let formats=['qr_code','ean_13','code_128','code_39'];
      if (val==='QR_CODE') formats=['qr_code'];
      if (val==='EAN_13')  formats=['ean_13'];
      if (val==='CODE_128') formats=['code_128'];
      if (val==='CODE_39') formats=['code_39'];
      const supported = await BarcodeDetector.getSupportedFormats();
      const list = formats.filter(f=>supported.includes(f));
      const det = new BarcodeDetector({ formats:list.length?list:undefined });
      const res = await det.detect(bitmap);
      if (res && res.length){
        const code = res[0].rawValue;
        if (els.codeType.value==='EAN_13' && !ean13IsValid(code)) return null;
        return code || null;
      }
    }catch{}
  }
  return null;
}

async function detectFromCanvasWithZXing(canvas){
  try{
    // ZXing ne lit pas direct le canvas → on crée un <img>
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const img = new Image();
    await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; img.src=dataUrl; });
    recreateReader();
    const result = await codeReader.decodeFromImageElement(img);
    const text = result?.getText?.() || result?.text || null;
    if (text && els.codeType.value==='EAN_13' && !ean13IsValid(text)) return null;
    return text;
  }catch{ return null; }
}

async function detectFromCanvasWithQuagga(canvas){
  return new Promise((resolve)=>{
    const src = canvas.toDataURL('image/jpeg', 0.9);
    Quagga.decodeSingle({
      src,
      numOfWorkers: 0,
      decoder: { readers: quaggaReadersImage() },
      locate: true,
      inputStream: { size: 1280 }
    }, (res)=>{
      const code = res?.codeResult?.code || null;
      if (code && els.codeType.value==='EAN_13' && !ean13IsValid(code)) return resolve(null);
      resolve(code);
    });
  });
}

async function scanPhotoFile(file){
  try{
    setPhotoStatus('Analyse de la photo…');

    // createImageBitmap (rapide) – certaines HEIC ne sont pas supportées → fallback <img>
    let bitmap = null;
    try { bitmap = await createImageBitmap(file); } catch {}

    // On tente d'abord le natif sur bitmap
    if (bitmap){
      let code = await detectFromImageBitmap(bitmap);
      if (code){
        els.codeValue.value = code; lastCode=code; lastTime=Date.now();
        setPhotoStatus('✅ Code détecté (photo, natif)'); feedback(); return;
      }
    }

    // Fallback : charger en <img>, dessiner dans un canvas optimisé (taille/rotation), plusieurs essais
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; img.src=url; });

    const rotations = [0,1,2,3];       // 0°, 90°, 180°, 270°
    const scales = [1600, 1200, 900];  // redimensionnement côté plus long
    const pipelines = [
      async (cv)=> await detectFromCanvasWithZXing(cv),
      async (cv)=> els.codeType.value!=='QR_CODE' ? await detectFromCanvasWithQuagga(cv) : null
    ];

    for (const rot of rotations){
      for (const sc of scales){
        const cv = drawImageFitted(img, sc, rot, true);
        for (const pipe of pipelines){
          const code = await pipe(cv);
          if (code){
            els.codeValue.value = code; lastCode=code; lastTime=Date.now();
            setPhotoStatus('✅ Code détecté (photo)'); feedback();
            URL.revokeObjectURL(url);
            return;
          }
        }
      }
    }

    URL.revokeObjectURL(url);
    setPhotoStatus('❌ Aucun code détecté sur la photo');

  }catch(e){
    console.error(e);
    setPhotoStatus("❌ Erreur pendant l'analyse de la photo");
  }
}

// UI Photo
els.btnPhoto?.addEventListener('click', ()=>{
  if (scanning) stop(); // libère la cam pour l’app photo
  setPhotoStatus('');
  els.photoInput.click();
});
els.photoInput?.addEventListener('change', async (e)=>{
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  await scanPhotoFile(file);
});

// ===== Lists & Submit =====
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
    const code=els.codeValue.value.trim(), type=els.codeType.value, dep=els.depart.value, dst=els.destination.value, dateMvt=els.dateMvt.value;
    if (!code) throw new Error("Code manquant");
    if (!dep) throw new Error("Lieu de départ manquant");
    if (!dst) throw new Error("Lieu de destination manquant");

    const maxFutureDays=7, today=new Date(new Date().toDateString()), userD=new Date(dateMvt);
    if ((userD - today)/86400000 > maxFutureDays) throw new Error("Date trop loin dans le futur (>7 jours)");

    const tzLocal = new Intl.DateTimeFormat('en-GB',{ timeZone:TZ, dateStyle:'short', timeStyle:'medium' }).format(new Date());
    const data = new URLSearchParams({
      code_scanné: code, type_code: type, lieu_depart: dep, lieu_destination: dst, date_mouvement: dateMvt,
      timestamp_utc: new Date().toISOString(), timestamp_local: tzLocal, device_id: navigator.userAgent, user_id:'', notes: els.notes.value||''
    });

    const resp = await fetch(API_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:data.toString() });
    const j = await resp.json();
    if (!j.ok) throw new Error(j.error||"Erreur API");

    setStatus("✅ Enregistré dans Google Sheets"); els.notes.value='';
    // tu peux cliquer "Démarrer la caméra" ensuite, ou rester en mode photo
  }catch(e){ setStatus("❌ "+e.message, false); }
});

// ===== Events (live) =====
els.btnStart.addEventListener('click', start);
els.btnStop.addEventListener('click', stop);
els.camSel.addEventListener('change', ()=>{ selectedDeviceId = els.camSel.value; if (scanning) restart(); });
els.resSel.addEventListener('change', ()=>{ if (scanning) restart(); });
els.engineSel.addEventListener('change', ()=>{ if (scanning) restart(); });
els.codeType.addEventListener('change', ()=>{ if (scanning) restart(); });
els.btnMacro.addEventListener('click', async ()=>{
  macroMode = !macroMode;
  els.btnMacro.classList.toggle('active', macroMode);
  if (scanning) restart();
});

// Init
window.addEventListener('load', loadListes);
