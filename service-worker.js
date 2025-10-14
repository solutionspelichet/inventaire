const CACHE = 'scan-sheet-v1';
const ASSETS = [
'/',
'/index.html',
'/style.css',
'/script.js',
'/manifest.json',
'/assets/pelichet-logo.png'
];
self.addEventListener('install', e=>{
e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});
self.addEventListener('activate', e=>{
e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
});
self.addEventListener('fetch', e=>{
const url = new URL(e.request.url);
if (e.request.method==='GET' && (url.origin===location.origin)){
e.respondWith(caches.match(e.request).then(r=> r || fetch(e.request)));
}
});
