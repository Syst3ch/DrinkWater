const CACHE = "hl-cache-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (e)=>{
  e.waitUntil(
    caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate", (e)=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.map(k=>k===CACHE?null:caches.delete(k)))).then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch", (e)=>{
  const req = e.request;
  e.respondWith(
    caches.match(req).then(cached=>{
      return cached || fetch(req).then(res=>{
        const copy = res.clone();
        if(req.method === "GET" && res.status === 200 && req.url.startsWith(self.location.origin)){
          caches.open(CACHE).then(c=>c.put(req, copy));
        }
        return res;
      }).catch(()=>cached);
    })
  );
});
