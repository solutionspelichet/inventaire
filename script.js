// ===== CONFIG =====
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
const url = `${API_URL}?action=listes`;
const res = await fetch(url, { method:'GET' });
const json = await res.json();
if(!json.ok) throw new Error(json.error || 'Erreur listes');
const { depart, destination } = json;
fillSelect(els.depart, depart);
fillSelect(els.destination, destination);
setStatus('Listes chargées');
}


function fillSelect(sel, arr){
sel.innerHTML = '';
arr.forEach(v=>{
const opt = document.createElement('option');
opt.value = v; opt.textContent = v; sel.appendChild(opt);
});
}


// Date du jour par défaut (modifiable)
els.dateMvt.value = todayLocalISO();


// Validation et envoi
els.submit.addEventListener('click', async ()=>{
try{
const code = (els.codeValue.value || '').trim();
const type = els.codeType.value;
const dep = els.depart.value;
const dst = els.destination.value;
const dateMvt = els.dateMvt.value; // YYYY-MM-DD
if(!code) throw new Error('Code manquant');
if(!dep) throw new Error('Lieu de départ manquant');
if(!dst) throw new Error('Lieu de destination manquant');
// Validation: départ = destination autorisé (selon consigne) → on n'empêche pas
// Validation date (ex: pas dans le futur > 7 jours)
const maxFutureDays = 7;
const today = new Date(todayLocalISO());
const userD = new Date(dateMvt);
const diffDays = (userD - today) / 86400000;
if (diffDays > maxFutureDays) throw new Error('Date trop loin dans le futur (>7 jours)');


const tzLocal = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, dateStyle:'short', timeStyle:'medium' }).format(new Date());
const payload = new URLSearchParams({
action: 'submit',
code_scanné: code,
type_code: type,
lieu_depart: dep,
lieu_destination: dst,
date_mouvement: dateMvt,
timestamp_utc: new Date().toISOString(),
timestamp_local: tzLocal,
device_id: navigator.userAgent,
user_id: '',
notes: (els.notes.value||'')
});


const res = await fetch(API_URL, {
method:'POST',
headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
body: payload.toString()
});
const json = await res.json();
if(!json.ok) throw new Error(json.error || 'Erreur API');


setStatus('✅ Enregistré dans Google Sheets');
// petit reset doux
els.notes.value='';
} catch (e){
console.error(e);
setStatus('❌ '+e.message, false);
}
});


window.addEventListener('load', loadListes);
