/* Offline-Speicher für Justins Schach-App.
   Die Seite selbst kommt immer frisch vom Server, wenn Internet da ist (so kommen Updates sofort an).
   Alles andere (Stockfish, Brett-Bibliothek, Schriften, Icons) kommt aus dem Speicher und wird im Hintergrund erneuert.
   Server-Anfragen (/api, /mcp) laufen nie über den Speicher. */
const CACHE = "schach-v1";
const KERN = ["./", "stockfish.asm.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(KERN)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  const eigen = u.origin === self.location.origin;
  if (eigen && (u.pathname.startsWith("/api/") || u.pathname.startsWith("/mcp/"))) return;

  if (r.mode === "navigate" || (eigen && (u.pathname === "/" || u.pathname.endsWith(".html")))) {
    e.respondWith(
      fetch(r)
        .then((res) => {
          if (res.ok) { const k = res.clone(); caches.open(CACHE).then((c) => c.put("./", k)); }
          return res;
        })
        .catch(() => caches.match("./"))
    );
    return;
  }

  e.respondWith(
    caches.match(r).then((hit) => {
      const netz = fetch(r)
        .then((res) => {
          if (res && (res.ok || res.type === "opaque")) { const k = res.clone(); caches.open(CACHE).then((c) => c.put(r, k)); }
          return res;
        })
        .catch(() => hit);
      return hit || netz;
    })
  );
});
