// ===== Config =====
const API_URL = window.APP_CONFIG.API_URL;
const TZ = 'Europe/Zurich';
const { BrowserMultiFormatReader, NotFoundException, DecodeHintType, BarcodeFormat } = ZXing;

// ===== State =====
let scanning=false, videoTrack=null, currentStream=null, codeReader=null;
let rafId=null, nativeScanId=null, usingQuagga=false, fallbackTimer=null;
let lastCode=null, lastTime=0;
let selectedDeviceId=null, selectedWidth=1920, selectedHeight=1080, selectedEngine='auto', macroMode=false;

// ===== DOM =====
const els={
  videoWrap:document.getElementById('videoWrap'),
  video:document.getElementById('preview'),
  overlay:document.getElementById('overlay'),
  focusMeter:document.getElementById('focusMeter'),
  diag:document.getElementById('diag'),
  btnStart:document.getElementById('btnStart'),
  btnStop:document.getElementById('btnStop'),
  camSel:document.getElementById('cameraSelect'),
  resSel:document.getElementById('resSelect'),
  engineSel:document.getElementById('engineSelect'),
  btnTorch:document.getElementById('btnTorch'),
  zoomWrap:document.getElementById('zoomWrap'),
  zoomRange:document.getElementById('zoomRange'),
  zoomValue:document.getElementById('zoomValue'),
  btnMacro:document.getElementById('btnMacro'),
  btnPhoto:document.getElementById('btnPhoto'),
  photoInput:document.getElementById('photoInput'),
  photoStatus:document.getElementById('photoStatus'),
  codeValue:document.getElementById('codeValue'),
  codeType:document.getElementById('codeType'),
  depart:document.getElementById('depart'),
  destination:document.getElementById('destination'),
  dateMvt:document.getElementById('dateMvt'),
  notes:document.getElementById('notes'),
  submit:document.getElementById('btnSubmit'),
  status:document.getElementById('status')
};
function setStatus(m,ok=true){ els.status.textContent=m||''; els.status.style.color=ok?'green':'crimson'; }
function setPhotoStatus(m){ els.photoStatus.textContent=m||''; }
function todayISO(){ return new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(new Date()); }
els.dateMvt.value=todayISO();
function isSamsungS24(){ const ua=navigator.userAgent||""; return /SM-S92(1|6|8)/i.test(ua) || (/S24/i.test(ua)&&/Samsung/i.test(ua)); }

// ===== Feedback =====
function feedback(){
  try{ const ctx=new (window.AudioContext||window.webkitAudioContext)(); const o=ctx.createOscillator(), g=ctx.createGain(); o.type='sine'; o.frequency.value=880; g.gain.setValueAtTime(0.0001,ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.3,ctx.currentTime+0.01); g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+0.12); o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime+0.14);}catch{}
  if (navigator.vibrate) navigator.vibrate([50,30,50]);
}

// ===== Formats / helpers =====
function buildHints(){
  const v=els.codeType.value;
  let formats;
  if (v==='QR_CODE') formats=[BarcodeFormat.QR_CODE];
  else if (v==='EAN_13') formats=[BarcodeFormat.EAN_13];
  else if (v==='CODE_128') formats=[BarcodeFormat.CODE_128];
  else if (v==='CODE_39') formats=[BarcodeFormat.CODE_39];
  else formats=[BarcodeFormat.QR_CODE, BarcodeFormat.EAN_13, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39];
  const hints=new Map(); hints.set(DecodeHintType.POSSIBLE_FORMATS,formats); hints.set(DecodeHintType.TRY_HARDER,true);
  return {hints};
}
function recreateReader(){ const {hints}=buildHints(); codeReader=new BrowserMultiFormatReader(hints,200); }
function is1D(){ const v=els.codeType.value; return v==='EAN_13'||v==='CODE_128'||v==='CODE_39'; }
function ean13Valid(code){ if(!/^\d{13}$/.test(code))return false; const ds=code.split('').map(Number); const chk=ds.pop(); const sum=ds.reduce((a,d,i)=>a+(i%2?d*3:d),0); const calc=(10-(sum%10))%10; return calc===chk; }

// ===== Camera =====
async function ensurePermission(){ const s=await navigator.mediaDevices.getUserMedia({video:true,audio:false}); s.getTracks().forEach(t=>t.stop()); }
async function listCameras(){
  const devs=await navigator.mediaDevices.enumerateDevices();
  const cams=devs.filter(d=>d.kind==='videoinput');
  els.camSel.innerHTML=''; cams.forEach((c,i)=>{ const o=document.createElement('option'); o.value=c.deviceId; o.textContent=c.label||`Caméra ${i+1}`; els.camSel.appendChild(o); });
  const back=cams.find(c=>/back|rear|environment/i.test(c.label));
  els.camSel.value= back? back.deviceId : (cams[0]?.deviceId||'');
  selectedDeviceId=els.camSel.value; return cams;
}
async function pickUltraWideDeviceId(){ const devs=await navigator.mediaDevices.enumerateDevices(); const cams=devs.filter(d=>d.kind==='videoinput'); const m=cams.find(c=>/ultra|uw|0\.5|wide\s*angle/i.test(c.label)); return m?m.deviceId:null; }

async function openStream(){
  const wantW= macroMode?3840:selectedWidth, wantH= macroMode?2160:selectedHeight;
  let deviceToUse=selectedDeviceId; if (macroMode){ const uw=await pickUltraWideDeviceId(); if (uw) deviceToUse=uw; }
  const isS24=isSamsungS24();
  const base={ video:{
      deviceId: deviceToUse?{exact:deviceToUse}:undefined,
      width:  isS24?{ideal:1280,max:1280}:{ideal:wantW,max:wantW},
      height: isS24?{ideal:720,max:720}:{ideal:wantH,max:wantH},
      frameRate:{ideal:30,max:30}
    }, audio:false };
  try{ return await navigator.mediaDevices.getUserMedia(base); }
  catch(e){ return await navigator.mediaDevices.getUserMedia({video:{deviceId:deviceToUse?{exact:deviceToUse}:undefined,width:{ideal:1280,max:1280},height:{ideal:720,max:720}},audio:false}); }
}
function attachStream(stream){
  try{ if(currentStream) currentStream.getTracks().forEach(t=>t.stop()); }catch{}
  currentStream=stream; els.video.srcObject=stream; const tr=stream.getVideoTracks()[0]; videoTrack=tr||null;
  try{ const s=tr.getSettings?.()||{}; const c=tr.getCapabilities?.()||{}; els.diag.textContent=`${s.width||'?'}×${s.height||'?'} | AF:${c.focusMode?'oui':'—'} | Zoom:${c.zoom?'oui':'—'} | Torch:${'torch' in c?'oui':'—'}`; }catch{ els.diag.textContent='—'; }
}
function initCamControls(){
  els.btnTorch.disabled=true; els.btnTorch.dataset.on='0'; els.btnTorch.textContent='Lampe OFF';
  els.zoomWrap.hidden=true;
  if(!videoTrack) return;
  const caps=videoTrack.getCapabilities?.()||{};
  if('torch' in caps) els.btnTorch.disabled=false;
  if('zoom' in caps){ const {min=1,max=1,step=0.1}=caps.zoom; els.zoomRange.min=min; els.zoomRange.max=max; els.zoomRange.step=step||0.1; const cur=videoTrack.getSettings?.().zoom??min; els.zoomRange.value=cur; els.zoomValue.textContent=`${Number(cur).toFixed(1)}×`; els.zoomWrap.hidden=false; }
}
async function setTorch(on){ if(!videoTrack?.getCapabilities) return false; const caps=videoTrack.getCapabilities(); if(!('torch'in caps)) return false; try{ await videoTrack.applyConstraints({advanced:[{torch:!!on}]}); return true;}catch{return false;} }
async function setZoom(v){ if(!videoTrack?.getCapabilities) return false; const caps=videoTrack.getCapabilities(); if(!('zoom'in caps)) return false; try{ await videoTrack.applyConstraints({advanced:[{zoom:Number(v)}]}); els.zoomValue.textContent=`${Number(v).toFixed(1)}×`; return true;}catch{return false;} }
els.btnTorch.addEventListener('click', async ()=>{ const on=els.btnTorch.dataset.on==='1'; const ok=await setTorch(!on); if(ok){ els.btnTorch.dataset.on=on?'0':'1'; els.btnTorch.textContent=on?'Lampe OFF':'Lampe ON'; } else alert("Lampe non supportée par cette caméra."); });
els.zoomRange.addEventListener('input', e=> setZoom(e.target.value));

// ===== Overlay & netteté =====
function getRoi(w,h){ if(is1D()){ const rw=(w*0.86)|0, rh=(h*0.22)|0; return {x:((w-rw)/2)|0,y:((h-rh)/2)|0,w:rw,h:rh}; } const s=(Math.min(w,h)*0.55)|0; return {x:((w-s)/2)|0,y:((h-s)/2)|0,w:s,h:s}; }
function drawReticle(ctx,roi){ ctx.save(); ctx.strokeStyle='rgba(255,122,0,0.95)'; ctx.lineWidth=3; ctx.setLineDash([10,6]); ctx.strokeRect(roi.x,roi.y,roi.w,roi.h); ctx.restore(); }
function startOverlayLoop(){
  const canvas=els.overlay, ctx=canvas.getContext('2d'), off=document.createElement('canvas'), offCtx=off.getContext('2d');
  function lapVar(video,roi){ if(!video||video.readyState<2)return 0; const tw=160, th=Math.max(90,(roi.h*160/roi.w)|0); off.width=tw; off.height=th; offCtx.drawImage(video,roi.x,roi.y,roi.w,roi.h,0,0,tw,th); const {data,width,height}=offCtx.getImageData(0,0,tw,th); let sum=0,sum2=0,n=0; for(let y=1;y<height-1;y++){ for(let x=1;x<width-1;x++){ const idx=(y*width+x)*4; const g=.299*data[idx]+.587*data[idx+1]+.114*data[idx+2]; const gL=.299*data[idx-4]+.587*data[idx-3]+.114*data[idx-2]; const gR=.299*data[idx+4]+.587*data[idx+5]+.114*data[idx+6]; const gT=.299*data[idx-width*4]+.587*data[idx-width*4+1]+.114*data[idx-width*4+2]; const gB=.299*data[idx+width*4]+.587*data[idx+width*4+1]+.114*data[idx+width*4+2]; const lap=(gL+gR+gT+gB)-4*g; sum+=lap; sum2+=lap*lap; n++; }} const mean=sum/n; return (sum2/n)-mean*mean; }
  function loop(){ rafId=requestAnimationFrame(loop); const rect=els.videoWrap.getBoundingClientRect(); const w=canvas.width=rect.width|0, h=canvas.height=rect.height|0; if(!w||!h) return; ctx.clearRect(0,0,w,h); const roi=getRoi(w,h); drawReticle(ctx,roi); const now=performance.now(); if(!startOverlayLoop._last||now-startOverlayLoop._last>200){ startOverlayLoop._last=now; try{ els.focusMeter.textContent=`Net: ${lapVar(els.video,roi).toFixed(0)}`; }catch{} } }
  cancelAnimationFrame(rafId); loop();
}
function stopOverlayLoop(){ cancelAnimationFrame(rafId); rafId=null; const c=els.overlay.getContext('2d'); c&&c.clearRect(0,0,els.overlay.width,els.overlay.height); els.focusMeter.textContent='Net: —'; }

// ===== Engines (Live) =====
let detector=null;
async function setupDetector(){
  if(!('BarcodeDetector'in window)) return false;
  const v=els.codeType.value;
  let formats=['qr_code','ean_13','code_128','code_39'];
  if(v==='QR_CODE')formats=['qr_code']; if(v==='EAN_13')formats=['ean_13']; if(v==='CODE_128')formats=['code_128']; if(v==='CODE_39')formats=['code_39'];
  try{ const sup=await BarcodeDetector.getSupportedFormats(); const list=formats.filter(f=>sup.includes(f)); if(!list.length) return false; detector=new BarcodeDetector({formats:list}); return true; }catch{ return false; }
}
function stopNativeLoop(){ if(nativeScanId){ cancelAnimationFrame(nativeScanId); nativeScanId=null; } }

// ROI → ImageBitmap pour le natif (fiable Honor/Android)
async function roiToBitmap(videoEl){
  const rect=els.videoWrap.getBoundingClientRect(); const w=rect.width|0, h=rect.height|0;
  if(!w||!h || !videoEl.videoWidth) return null;
  const roi=getRoi(w,h);
  const cv=document.createElement('canvas'), cx=cv.getContext('2d');
  cv.width=roi.w; cv.height=roi.h;
  cx.drawImage(videoEl, roi.x,roi.y,roi.w,roi.h, 0,0,roi.w,roi.h);
  try{ return await createImageBitmap(cv); }catch{ return cv; } // fallback: canvas
}

function startNativeLoop(){
  stopNativeLoop();
  const tick=async ()=>{
    nativeScanId=requestAnimationFrame(tick);
    try{
      const src=await roiToBitmap(els.video);
      if(!src) return;
      const dets=await detector.detect(src);
      if(dets && dets.length){
        const code=dets[0].rawValue; if(!code) return;
        if(els.codeType.value==='EAN_13' && !ean13Valid(code)) return;
        const now=Date.now(); if(code===lastCode && now-lastTime<800) return;
        els.codeValue.value=code; lastCode=code; lastTime=now; setStatus('✅ Code détecté (natif)'); feedback();
        if(fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer=null; }
      }
    }catch{}
  };
  tick();
}

// ZXing
function startZXing(){
  recreateReader();
  codeReader.decodeFromVideoElement(els.video,(result,err)=>{
    if(result){
      const code=result.getText();
      if(els.codeType.value==='EAN_13' && !ean13Valid(code)) return;
      const now=Date.now(); if(code===lastCode && now-lastTime<800) return;
      els.codeValue.value=code; lastCode=code; lastTime=now; setStatus('✅ Code détecté (ZXing)'); feedback();
      if(fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer=null; }
    } else if (err && !(err instanceof NotFoundException)){ console.warn(err); }
  });
}
function stopZXing(){ try{ codeReader&&codeReader.reset(); }catch{} }

// Quagga (1D)
function quaggaReaders(){ const v=els.codeType.value; if(v==='EAN_13')return['ean_reader']; if(v==='CODE_128')return['code_128_reader']; if(v==='CODE_39')return['code_39_reader']; return['ean_reader','code_128_reader','code_39_reader']; }
function startQuagga(){
  if(usingQuagga) return; usingQuagga=true; stopNativeLoop(); stopZXing();
  Quagga.init({
    inputStream:{ name:'Live', type:'LiveStream', target:els.videoWrap, constraints:{ deviceId:selectedDeviceId?{exact:selectedDeviceId}:undefined, width:{ideal:1280}, height:{ideal:720} } },
    locator:{ patchSize:'medium', halfSample:true },
    numOfWorkers:2, frequency:15,
    decoder:{ readers:quaggaReaders() },
    locate:true,
    area:{ top:"39%", right:"7%", left:"7%", bottom:"39%" }
  }, (err)=>{
    if(err){ console.error(err); setStatus('Erreur Quagga: '+err.message,false); usingQuagga=false; return; }
    Quagga.start(); setStatus('Lecture 1D (Quagga)…');
  });
  Quagga.onDetected((res)=>{
    const code=res?.codeResult?.code; if(!code) return;
    if(els.codeType.value==='EAN_13' && !ean13Valid(code)) return;
    const now=Date.now(); if(code===lastCode && now-lastTime<800) return;
    els.codeValue.value=code; lastCode=code; lastTime=now; setStatus('✅ Code détecté (Quagga)'); feedback(); stopQuagga();
  });
}
function stopQuagga(){ if(!usingQuagga) return; try{ Quagga.stop(); }catch{} Quagga.offDetected(()=>{}); usingQuagga=false; }

// ===== Start/Stop =====
async function start(){
  try{
    await ensurePermission();
    const cams=await listCameras(); if(!cams.length){ setStatus("Aucune caméra détectée.",false); return; }
    const [w,h]=els.resSel.value.split('x').map(n=>parseInt(n,10)); selectedWidth=w; selectedHeight=h; selectedEngine=els.engineSel.value;
    const stream=await openStream(); attachStream(stream);
    els.video.setAttribute('playsinline','true'); els.video.muted=true;
    await new Promise(r=> els.video.onloadedmetadata=r );
    initCamControls(); startOverlayLoop();
    const hasNative=await setupDetector();
    if(selectedEngine==='native' || (selectedEngine==='auto' && hasNative)) startNativeLoop();
    else if(selectedEngine==='zxing' || (selectedEngine==='auto' && !hasNative)) startZXing();
    else startQuagga();
    if(selectedEngine!=='quagga'){ const t=is1D()?1800:3000; fallbackTimer=setTimeout(()=>{ if(!usingQuagga && is1D()) startQuagga(); }, t); }
    scanning=true; els.btnStart.disabled=true; els.btnStop.disabled=false; setStatus('Caméra démarrée');
  }catch(e){ console.error(e); setStatus("Impossible de démarrer la caméra. Vérifiez l'autorisation et réessayez.",false); }
}
function stop(){
  stopNativeLoop(); stopZXing(); stopQuagga(); if(fallbackTimer){ clearTimeout(fallbackTimer); fallbackTimer=null; }
  try{ if(currentStream) currentStream.getTracks().forEach(t=>t.stop()); }catch{}
  currentStream=null; videoTrack=null; stopOverlayLoop();
  els.btnStart.disabled=false; els.btnStop.disabled=true; els.btnTorch.disabled=true; els.zoomWrap.hidden=true; els.btnTorch.dataset.on='0'; els.btnTorch.textContent='Lampe OFF';
  setStatus("Caméra arrêtée"); scanning=false;
}
function restart(){ stop(); start(); }

// ===== Photo (fiable) =====
function quaggaReadersImage(){ const v=els.codeType.value; if(v==='EAN_13')return['ean_reader']; if(v==='CODE_128')return['code_128_reader']; if(v==='CODE_39')return['code_39_reader']; return['ean_reader','code_128_reader','code_39_reader']; }
function drawImageFitted(img, maxSide=1600, rot=0){ const sw=img.width||img.naturalWidth, sh=img.height||img.naturalHeight; const scale=Math.min(1, maxSide/Math.max(sw,sh)); const tw=(sw*scale)|0, th=(sh*scale)|0; const cv=document.createElement('canvas'), cx=cv.getContext('2d'); if(rot%2===1){ cv.width=th; cv.height=tw; cx.translate(cv.width/2,cv.height/2); cx.rotate((Math.PI/2)*rot); cx.drawImage(img,-tw/2,-th/2,tw,th);} else { cv.width=tw; cv.height=th; cx.drawImage(img,0,0,tw,th);} // petit boost de contraste
  const id=cx.getImageData(0,0,cv.width,cv.height), d=id.data; for(let i=0;i<d.length;i+=4){ d[i]=Math.min(255,Math.max(0,(d[i]-8)*1.12)); d[i+1]=Math.min(255,Math.max(0,(d[i+1]-8)*1.12)); d[i+2]=Math.min(255,Math.max(0,(d[i+2]-8)*1.12)); } cx.putImageData(id,0,0); return cv; }
async function detectBitmap(bitmap){ if(!('BarcodeDetector'in window)) return null; try{ const v=els.codeType.value; let fm=['qr_code','ean_13','code_128','code_39']; if(v==='QR_CODE')fm=['qr_code']; if(v==='EAN_13')fm=['ean_13']; if(v==='CODE_128')fm=['code_128']; if(v==='CODE_39')fm=['code_39']; const sup=await BarcodeDetector.getSupportedFormats(); const list=fm.filter(f=>sup.includes(f)); const det=new BarcodeDetector({formats:list.length?list:undefined}); const r=await det.detect(bitmap); if(r&&r.length){ const t=r[0].rawValue; if(els.codeType.value==='EAN_13' && !ean13Valid(t)) return null; return t||null; } }catch{} return null; }
async function detectZXingFromCanvas(cv){ try{ const url=cv.toDataURL('image/jpeg',0.92); const img=new Image(); await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; img.src=url; }); recreateReader(); const r=await codeReader.decodeFromImageElement(img); const t=r?.getText?.()||r?.text||null; if(t && els.codeType.value==='EAN_13' && !ean13Valid(t)) return null; return t; }catch{ return null; } }
async function detectQuaggaFromCanvas(cv){ return new Promise((resolve)=>{ const src=cv.toDataURL('image/jpeg',0.9); Quagga.decodeSingle({src, numOfWorkers:0, decoder:{readers:quaggaReadersImage()}, locate:true, inputStream:{size:1280}}, (res)=>{ const t=res?.codeResult?.code||null; if(t && els.codeType.value==='EAN_13' && !ean13Valid(t)) return resolve(null); resolve(t); }); }); }
async function scanPhotoFile(file){
  try{
    setPhotoStatus('Analyse de la photo…');
    let bitmap=null; try{ bitmap=await createImageBitmap(file);}catch{}
    if(bitmap){ const t=await detectBitmap(bitmap); if(t){ els.codeValue.value=t; lastCode=t; lastTime=Date.now(); setPhotoStatus('✅ Code détecté (photo)'); feedback(); return; } }
    const url=URL.createObjectURL(file); const img=new Image(); await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; img.src=url; });
    const rotations=[0,1,2,3], scales=[1600,1200,900]; for(const rot of rotations){ for(const sc of scales){ const cv=drawImageFitted(img,sc,rot); const t1=await detectZXingFromCanvas(cv); if(t1){ els.codeValue.value=t1; lastCode=t1; lastTime=Date.now(); setPhotoStatus('✅ Code détecté (photo)'); feedback(); URL.revokeObjectURL(url); return; } if(els.codeType.value!=='QR_CODE'){ const t2=await detectQuaggaFromCanvas(cv); if(t2){ els.codeValue.value=t2; lastCode=t2; lastTime=Date.now(); setPhotoStatus('✅ Code détecté (photo)'); feedback(); URL.revokeObjectURL(url); return; } } } }
    URL.revokeObjectURL(url); setPhotoStatus('❌ Aucun code détecté sur la photo');
  }catch(e){ console.error(e); setPhotoStatus("❌ Erreur pendant l'analyse de la photo"); }
}

// UI Photo (avec fallback si click bloqué par le navigateur)
els.btnPhoto.addEventListener('click', ()=>{
  if (scanning) stop();
  setPhotoStatus('');
  const input=els.photoInput;
  let opened=false;
  const onFocus=()=>{ opened=true; window.removeEventListener('focus', onFocus); };
  window.addEventListener('focus', onFocus);
  input.click();
  setTimeout(()=>{ if(!opened && !input.files?.length){ // fallback: afficher l’input
    input.hidden=false; input.style.position='static'; input.style.opacity='1'; input.style.border='1px solid #ddd';
    setPhotoStatus("Si la caméra ne s'ouvre pas, touchez le champ ci-dessous pour prendre la photo.");
  }}, 800);
});
els.photoInput.addEventListener('change', async (e)=>{ const f=e.target.files&&e.target.files[0]; if(!f) return; await scanPhotoFile(f); });

// ===== Lists & Submit =====
async function loadListes(){ try{ setStatus("Chargement des listes…"); const r=await fetch(`${API_URL}?action=listes`); const j=await r.json(); if(!j.ok) throw new Error(j.error||"Erreur listes"); fill(els.depart,j.depart); fill(els.destination,j.destination); setStatus("Listes chargées"); }catch(e){ setStatus("Erreur listes: "+e.message,false); } }
function fill(sel,arr){ sel.innerHTML=''; (arr||[]).forEach(v=>{ const o=document.createElement('option'); o.value=v; o.textContent=v; sel.appendChild(o); }); }
els.submit.addEventListener('click', async ()=>{ try{ const code=els.codeValue.value.trim(), type=els.codeType.value, dep=els.depart.value, dst=els.destination.value, dateMvt=els.dateMvt.value; if(!code) throw new Error("Code manquant"); if(!dep) throw new Error("Lieu de départ manquant"); if(!dst) throw new Error("Lieu de destination manquant"); const maxFutureDays=7, today=new Date(new Date().toDateString()), userD=new Date(dateMvt); if((userD-today)/86400000>maxFutureDays) throw new Error("Date trop loin dans le futur (>7 jours)"); const tzLocal=new Intl.DateTimeFormat('en-GB',{timeZone:TZ,dateStyle:'short',timeStyle:'medium'}).format(new Date()); const data=new URLSearchParams({ code_scanné:code, type_code:type, lieu_depart:dep, lieu_destination:dst, date_mouvement:dateMvt, timestamp_utc:new Date().toISOString(), timestamp_local:tzLocal, device_id:navigator.userAgent, user_id:'', notes:els.notes.value||'' }); const resp=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:data.toString()}); const j=await resp.json(); if(!j.ok) throw new Error(j.error||"Erreur API"); setStatus("✅ Enregistré dans Google Sheets"); els.notes.value=''; }catch(e){ setStatus("❌ "+e.message,false); } });

// ===== Events =====
els.btnStart.addEventListener('click', start);
els.btnStop.addEventListener('click', stop);
els.camSel.addEventListener('change', ()=>{ selectedDeviceId=els.camSel.value; if(scanning) restart(); });
els.resSel.addEventListener('change', ()=>{ if(scanning) restart(); });
els.engineSel.addEventListener('change', ()=>{ if(scanning) restart(); });
els.codeType.addEventListener('change', ()=>{ if(scanning) restart(); });
els.btnMacro.addEventListener('click', ()=>{ macroMode=!macroMode; els.btnMacro.classList.toggle('active',macroMode); if(scanning) restart(); });

// Init
window.addEventListener('load', loadListes);
