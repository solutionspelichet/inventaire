const API_URL = window.APP_CONFIG.API_URL;
const TZ = 'Europe/Zurich';
const { BrowserMultiFormatReader, NotFoundException } = ZXing;
const codeReader = new BrowserMultiFormatReader();
let scanning = false, lastCode = null, lastTime = 0;
let currentDeviceId = null;

const els = {
  video: document.getElementById('preview'),
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  camSel: document.getElementById('cameraSelect'),
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
  els.status.textContent = msg||''; els.status.style.color = ok?'green':'crimson';
}
function todayISO(){
  const d=new Date();
  return new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(d);
}
els.dateMvt.value=todayISO();

async function ensurePermission(){
  try{
    const s=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
    s.getTracks().forEach(t=>t.stop());
    return true;
  }catch(e){setStatus("Autorisez la caméra dans les réglages du site.",false);throw e;}
}

async function listCamerasAfterPermission(){
  const devices=await navigator.mediaDevices.enumerateDevices();
  const cams=devices.filter(d=>d.kind==='videoinput');
  els.camSel.innerHTML='';
  cams.forEach((c,i)=>{
    const o=document.createElement('option');
    o.value=c.deviceId;o.textContent=c.label||`Caméra ${i+1}`;
    els.camSel.appendChild(o);
  });
  const back=cams.find(c=>/back|rear|environment/i.test(c.label));
  if(back)els.camSel.value=back.deviceId;
  return cams;
}

async function start(){
  try{
    els.video.setAttribute('playsinline','true'); els.video.muted=true;
    await ensurePermission();
    const cams=await listCamerasAfterPermission();
    if(!cams.length){setStatus("Aucune caméra détectée.",false);return;}
    const selectedId=els.camSel.value||cams[0].deviceId;
    const constraints={video:selectedId?{deviceId:{exact:selectedId}}:{facingMode:{ideal:'environment'}},audio:false};
    await codeReader.decodeFromConstraints(constraints,els.video,(result,err)=>{
      if(result){
        const code=result.getText(); const now=Date.now();
        if(code===lastCode && (now-lastTime)<8000){
          alert("Attention : même code scanné à la suite. Voulez-vous l'enregistrer à nouveau ?");
        }
        els.codeValue.value=code; lastCode=code; lastTime=now;
      } else if(err && !(err instanceof NotFoundException)){console.warn(err);}
    });
    scanning=true; els.btnStart.disabled=true; els.btnStop.disabled=false;
    setStatus("Caméra démarrée");
  }catch(e){console.error(e);setStatus("Impossible de démarrer la caméra.",false);}
}

function stop(){
  try{codeReader.reset();}catch{}
  const s=els.video.srcObject;if(s&&s.getTracks)s.getTracks().forEach(t=>t.stop());
  els.video.srcObject=null; scanning=false;
  els.btnStart.disabled=false; els.btnStop.disabled=true;
  setStatus("Caméra arrêtée");
}

els.camSel.addEventListener('change',()=>{if(scanning){stop();start();}});
els.btnStart.addEventListener('click',start);
els.btnStop.addEventListener('click',stop);

// ====== Listes ======
async function loadListes(){
  try{
    setStatus("Chargement des listes…");
    const res=await fetch(`${API_URL}?action=listes`);
    const j=await res.json();
    if(!j.ok)throw new Error(j.error||"Erreur listes");
    fill(els.depart,j.depart); fill(els.destination,j.destination);
    setStatus("Listes chargées");
  }catch(e){setStatus("Erreur listes: "+e.message,false);}
}
function fill(sel,arr){sel.innerHTML='';arr.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;sel.appendChild(o);});}

// ====== Envoi ======
els.submit.addEventListener('click',async()=>{
  try{
    const code=els.codeValue.value.trim();const type=els.codeType.value;
    const dep=els.depart.value;const dst=els.destination.value;const dateMvt=els.dateMvt.value;
    if(!code)throw new Error("Code manquant");
    if(!dep)throw new Error("Lieu de départ manquant");
    if(!dst)throw new Error("Lieu de destination manquant");
    const tzLocal=new Intl.DateTimeFormat('en-GB',{timeZone:TZ,dateStyle:'short',timeStyle:'medium'}).format(new Date());
    const data=new URLSearchParams({
      code_scanné:code,type_code:type,lieu_depart:dep,lieu_destination:dst,
      date_mouvement:dateMvt,timestamp_utc:new Date().toISOString(),
      timestamp_local:tzLocal,device_id:navigator.userAgent,user_id:'',notes:els.notes.value||''
    });
    const res=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:data.toString()});
    const j=await res.json();
    if(!j.ok)throw new Error(j.error||"Erreur API");
    setStatus("✅ Enregistré dans Google Sheets");
    els.notes.value='';
  }catch(e){console.error(e);setStatus("❌ "+e.message,false);}
});

window.addEventListener('load',loadListes);
