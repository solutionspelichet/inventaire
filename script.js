// ===== CONFIG =====
const API_URL = window.APP_CONFIG.API_URL; // Apps Script /exec
const TZ = 'Europe/Zurich';


// ===== ZXing init =====
const { BrowserMultiFormatReader, NotFoundException } = ZXing;
const codeReader = new BrowserMultiFormatReader();
let currentDeviceId = null;
let scanning = false;
let lastCode = null;
let lastTime = 0;


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
status: document.getElementById('status'),
};


function setStatus(msg, ok=true){
els.status.textContent = msg || '';
els.status.style.color = ok ? 'green' : 'crimson';
}


function todayLocalISO(){
const d = new Date();
const z = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d);
const Y = z.find(p=>p.type==='year').value;
const M = z.find(p=>p.type==='month').value;
const D = z.find(p=>p.type==='day').value;
return `${Y}-${M}-${D}`;
}


async function listCameras(){
const devices = await navigator.mediaDevices.enumerateDevices();
const cams = devices.filter(d=>d.kind==='videoinput');
els.camSel.innerHTML = '';
cams.forEach((c, i)=>{
const opt = document.createElement('option');
opt.value = c.deviceId;
opt.textContent = c.label || `Caméra ${i+1}`;
els.camSel.appendChild(opt);
});
if (cams[0]) currentDeviceId = cams[0].deviceId;
}


async function start(){
try{
await listCameras();
const devId = els.camSel.value || currentDeviceId;
currentDeviceId = devId;
await codeReader.decodeFromVideoDevice(devId, els.video, (result, err)=>{
if(result){
const code = result.getText();
const now = Date.now();
if (code === lastCode && (now - lastTime) < 8000){
alert('⚠️ Code identique scanné à la suite. Voulez-vous l'enregistrer à nouveau ?');
// on n'arrête pas, mais on laisse l'utilisateur décider via le bouton Enregistrer
}
els.codeValue.value = code;
lastCode = code; lastTime = now;
} else if (err && !(err instanceof NotFoundException)) {
console.warn(err);
}
});
scanning = true;
els.btnStart.disabled = true; els.btnStop.disabled = false;
setStatus('Caméra démarrée');
}catch(e){
console.error(e); setStatus('Impossible de démarrer la caméra', false);
}
}


function stop(){
try{ codeReader.reset(); }catch{}
scanning = false;
els.btnStart.disabled = false; els.btnStop.disabled = true;
setStatus('Caméra arrêtée');
}


els.camSel.addEventListener('change', ()=>{ if(scanning){ stop(); start(); } });
els.btnStart.addEventListener('click', start);
els.btnStop.addEventListener('click', stop);


// Dropdowns depuis Apps Script
async function loadListes(){
setStatus('Chargement des listes…');
window.addEventListener('load', loadListes);
