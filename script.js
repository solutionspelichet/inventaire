const API_URL = window.APP_CONFIG.API_URL;
const TZ = 'Europe/Zurich';
const { BrowserMultiFormatReader } = ZXing;

let scanning = false, currentStream=null;
let codeReader = new BrowserMultiFormatReader();

const els = {
  video: document.getElementById('preview'),
  overlay: document.getElementById('overlay'),
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  btnPhoto: document.getElementById('btnPhoto'),
  photoInput: document.getElementById('photoInput'),
  cameraSelect: document.getElementById('cameraSelect'),
  resSelect: document.getElementById('resSelect'),
  engineSelect: document.getElementById('engineSelect'),
  codeValue: document.getElementById('codeValue'),
  depart: document.getElementById('depart'),
  destination: document.getElementById('destination'),
  dateMvt: document.getElementById('dateMvt'),
  notes: document.getElementById('notes'),
  submit: document.getElementById('btnSubmit'),
  status: document.getElementById('status'),
  diag: document.getElementById('diag')
};

function setStatus(msg, ok=true){ els.status.textContent=msg; els.status.style.color=ok?'green':'crimson'; }
function todayISO(){ return new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(new Date()); }
els.dateMvt.value = todayISO();

// ---------- MODE CAMÉRA EN DIRECT ----------
async function startCamera(){
  try{
    const [w,h]=els.resSelect.value.split('x').map(Number);
    const stream = await navigator.mediaDevices.getUserMedia({
      video:{width:{ideal:w},height:{ideal:h},facingMode:"environment"},
      audio:false
    });
    currentStream=stream;
    els.video.srcObject=stream;
    scanning=true;
    setStatus("Caméra démarrée");
  }catch(e){
    setStatus("Impossible d'accéder à la caméra",false);
  }
}
function stopCamera(){
  if(currentStream){ currentStream.getTracks().forEach(t=>t.stop()); }
  scanning=false;
  setStatus("Caméra arrêtée");
}

// ---------- MODE PHOTO ----------
els.btnPhoto.addEventListener('click', ()=> els.photoInput.click());

els.photoInput.addEventListener('change', async (ev)=>{
  const file = ev.target.files[0];
  if(!file) return;
  setStatus("Analyse de la photo...");
  const img = new Image();
  img.src = URL.createObjectURL(file);
  img.onload = async ()=>{
    const canvas = document.createElement('canvas');
    const scale = 1000 / img.width;
    canvas.width = 1000;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    const luminanceSource = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    const binBitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminanceSource));
    try{
      const result = codeReader.decodeBitmap(binBitmap);
      els.codeValue.value = result.getText();
      setStatus("✅ Code détecté via photo");
      URL.revokeObjectURL(img.src);
    }catch{
      setStatus("❌ Aucun code détecté sur la photo",false);
    }
  };
});

// ---------- ENVOI GOOGLE SHEETS ----------
els.submit.addEventListener('click', async ()=>{
  try{
    const code = els.codeValue.value.trim();
    if(!code) throw new Error("Code manquant");
    const params = new URLSearchParams({
      code_scanné: code,
      lieu_depart: els.depart.value,
      lieu_destination: els.destination.value,
      date_mouvement: els.dateMvt.value,
      notes: els.notes.value
    });
    const res = await fetch(API_URL,{method:"POST",headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params});
    const j = await res.json();
    if(j.ok) setStatus("✅ Enregistré dans Google Sheets");
    else throw new Error(j.error);
  }catch(e){ setStatus("❌ "+e.message,false); }
});

// ---------- LISTES ----------
async function loadLists(){
  try{
    const r = await fetch(`${API_URL}?action=listes`);
    const j = await r.json();
    if(!j.ok) throw new Error(j.error);
    fill(els.depart,j.depart); fill(els.destination,j.destination);
  }catch(e){ setStatus("Erreur de chargement listes",false); }
}
function fill(sel,arr){ sel.innerHTML=''; arr.forEach(v=>{const o=document.createElement('option');o.textContent=v;o.value=v;sel.appendChild(o);}); }

// ---------- EVENTS ----------
els.btnStart.addEventListener('click',startCamera);
els.btnStop.addEventListener('click',stopCamera);
window.addEventListener('load',loadLists);
