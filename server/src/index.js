// Server für Justins Schach-App
// - liefert die App aus (statische Dateien aus ../web)
// - speichert Fortschritt, Chat, Analysen und Trainingsdaten (Durable Object)
// - leitet KI-Fragen an NVIDIA weiter, bei Problemen automatisch an Gemini
// - bietet Claude einen Connector (MCP) unter /mcp/<zugangscode>
// - holt Justins Partien aus dem öffentlichen Archiv von chess.com

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MCP_VERSIONEN = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const enc = new TextEncoder();

/* ---------- Hilfen ---------- */
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function tokenOk(env, t) {
  if (!t || !env.TOKEN_HASH) return false;
  return (await sha256hex(t)) === String(env.TOKEN_HASH).trim().toLowerCase();
}
function bearer(req) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}
const store = (env) => env.STORE.get(env.STORE.idFromName("justin"));

function heute() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
}
function plusTage(s, n) {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const liste = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

/* ---------- KI-Anbieter ---------- */
function kandidaten(env) {
  const out = [];
  for (const a of liste(env.ANBIETER || "nvidia,gemini").map((x) => x.toLowerCase())) {
    if (a === "nvidia" && env.NVIDIA_API_KEY)
      for (const m of liste(env.NVIDIA_MODELLE)) out.push({ anbieter: "NVIDIA", url: NVIDIA_URL, key: env.NVIDIA_API_KEY, model: m });
    if (a === "gemini" && env.GEMINI_API_KEY)
      for (const m of liste(env.GEMINI_MODELLE)) out.push({ anbieter: "Gemini", url: GEMINI_URL, key: env.GEMINI_API_KEY, model: m });
  }
  return out;
}

async function anfrage(k, body, ms) {
  const ac = new AbortController();
  const uhr = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(k.url, {
      method: "POST",
      signal: ac.signal,
      headers: { Authorization: "Bearer " + k.key, "Content-Type": "application/json", Accept: body.stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify({ model: k.model, ...body }),
    });
    return r;
  } finally {
    clearTimeout(uhr);
  }
}

function protokoll(env, eintrag) {
  return store(env)
    .fetch("https://do/log", { method: "POST", body: JSON.stringify({ zeit: new Date().toISOString(), ...eintrag }) })
    .catch(() => {});
}

async function frage(req, env, ctx) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ fehler: "Ungültige Anfrage" }, 400);
  }
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && ["user", "assistant", "system"].includes(m.role) && typeof m.content === "string")
    .slice(-40);
  if (!messages.length) return json({ fehler: "Keine Nachricht" }, 400);
  const maxTokens = Math.min(Number(body.max_tokens) || (body.json ? 3000 : 1500), 4000);
  const ms = Number(env.WARTEZEIT_MS) || 30000;
  const fehlversuche = [];
  for (const k of kandidaten(env)) {
    try {
      const r = await anfrage(k, { messages, stream: true, max_tokens: maxTokens, temperature: 0.4 }, ms);
      const typ = r.headers.get("content-type") || "";
      if (r.ok && r.body && typ.includes("text/event-stream")) {
        ctx.waitUntil(protokoll(env, { ok: true, anbieter: k.anbieter, modell: k.model, fehlversuche }));
        return new Response(r.body, {
          headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Modell": k.anbieter + ": " + k.model },
        });
      }
      let t = "";
      try { t = (await r.text()).slice(0, 200); } catch (e) {}
      fehlversuche.push(k.anbieter + " " + k.model + ": " + r.status + " " + t);
    } catch (e) {
      fehlversuche.push(k.anbieter + " " + k.model + ": " + (e && e.name === "AbortError" ? "keine Antwort" : String((e && e.message) || e).slice(0, 120)));
    }
  }
  ctx.waitUntil(protokoll(env, { ok: false, fehlversuche }));
  return json({ fehler: "Kein KI-Anbieter hat geantwortet", fehlversuche }, 503);
}

/* ---------- chess.com ----------
   Ein Monat aus dem öffentlichen Partie-Archiv eines Spielers. Der Server holt ihn, damit die App
   nicht von den Einstellungen des Browsers abhängt. Zurück kommt nur, was die App braucht. */
async function chesscom(url) {
  const name = (url.searchParams.get("name") || "").toLowerCase();
  const jahr = url.searchParams.get("jahr") || "";
  const monat = url.searchParams.get("monat") || "";
  if (!/^[a-z0-9_-]{2,40}$/.test(name) || !/^20\d\d$/.test(jahr) || !/^(0[1-9]|1[0-2])$/.test(monat)) return json({ fehler: "Ungültige Angabe" }, 400);
  let r;
  try {
    r = await fetch("https://api.chess.com/pub/player/" + name + "/games/" + jahr + "/" + monat, {
      headers: { "User-Agent": "schach-app (privates Trainingswerkzeug)", Accept: "application/json" },
    });
  } catch (e) {
    return json({ fehler: "chess.com ist nicht erreichbar" }, 502);
  }
  if (r.status === 404) return json({ games: [] });
  if (!r.ok) return json({ fehler: "chess.com antwortet mit " + r.status }, 502);
  let d;
  try { d = await r.json(); } catch (e) { return json({ fehler: "Antwort von chess.com unlesbar" }, 502); }
  const seite = (x) => ({ username: (x && x.username) || "", rating: (x && x.rating) || null, result: (x && x.result) || "" });
  const games = (Array.isArray(d.games) ? d.games : [])
    .filter((g) => g && g.pgn && (!g.rules || g.rules === "chess"))
    .slice(-80)
    .map((g) => ({ url: g.url || "", pgn: g.pgn, end_time: g.end_time || 0, time_class: g.time_class || "", rated: !!g.rated, rules: g.rules || "chess", white: seite(g.white), black: seite(g.black) }));
  return json({ games });
}

async function selbsttest(env) {
  const out = { zeit: new Date().toISOString(), speicher: null, anbieter: [] };
  try {
    const r = await store(env).fetch("https://do/ping");
    out.speicher = r.ok ? "ok" : "Fehler " + r.status;
  } catch (e) {
    out.speicher = "Fehler: " + e.message;
  }
  // alle Modelle gleichzeitig, damit der Test schnell fertig ist
  out.anbieter = await Promise.all(
    kandidaten(env).map(async (k) => {
      const t0 = Date.now();
      try {
        const r = await anfrage(k, { messages: [{ role: "user", content: "Antworte nur mit dem Wort: bereit" }], max_tokens: 300, stream: false }, 20000);
        let text = "";
        try {
          const j = await r.json();
          text = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || JSON.stringify(j)).slice(0, 120);
        } catch (e) {}
        return { anbieter: k.anbieter, modell: k.model, status: r.status, ms: Date.now() - t0, antwort: text };
      } catch (e) {
        return { anbieter: k.anbieter, modell: k.model, status: 0, ms: Date.now() - t0, antwort: e && e.name === "AbortError" ? "keine Antwort in 20 s" : String(e && e.message) };
      }
    })
  );
  return json(out);
}

/* ---------- Einstieg ---------- */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/api/health")
      return json({ ok: true, app: "schach-app", zugang: !!env.TOKEN_HASH, anbieter: { nvidia: !!env.NVIDIA_API_KEY, gemini: !!env.GEMINI_API_KEY } });

    if (p.startsWith("/mcp/")) {
      const t = decodeURIComponent(p.slice(5).split("/")[0] || "");
      if (!(await tokenOk(env, t))) return new Response("Not found", { status: 404 });
      return store(env).fetch(new Request("https://do/mcp", req));
    }

    if (p.startsWith("/api/selbsttest/")) {
      const t = decodeURIComponent(p.slice("/api/selbsttest/".length).split("/")[0] || "");
      if (!(await tokenOk(env, t))) return new Response("Not found", { status: 404 });
      return selbsttest(env);
    }

    if (p.startsWith("/api/")) {
      if (!(await tokenOk(env, bearer(req)))) return json({ fehler: "Zugangscode fehlt oder stimmt nicht" }, 401);
      if (p === "/api/pruefen") return json({ ok: true });
      if (p === "/api/frage" && req.method === "POST") return frage(req, env, ctx);
      if (p === "/api/chesscom" && req.method === "GET") return chesscom(url);
      if (p.startsWith("/api/doc/")) return store(env).fetch(new Request("https://do" + p, req));
      return json({ fehler: "Unbekannte Adresse" }, 404);
    }

    if (p.startsWith("/.well-known/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(req);
  },
};

/* ---------- Connector-Werkzeuge für Claude ---------- */
const ANLEITUNG = `Connector zu Justins Schach-App. Justin (chess.com ca. 500, Ziel 2000) trainiert mit einem 8-Wochen-Plan: Schottisch mit Weiß, Nimzo-Indisch mit Schwarz.
Die App zeigt "Trainingsdaten" (Plan, Übungen, Bibliothek, Schwächen, Partien), die du hier lesen und ändern kannst. Den Fortschritt (abgehakte Aufgaben, Wiederholungen, importierte Partien, Fragen, Notizen) schreibt nur die App, du liest ihn.
Starte mit ueberblick. Jede Änderung an den Trainingsdaten erhöht die Version, die App lädt sie beim nächsten Öffnen.
Übungen: Züge in englischer SAN (N, B, R, Q, K), deutsche Notation nur in den Texten. Die App prüft neue Übungen am Brett; Fehler stehen danach in ueberblick unter "pruefung".
Die App holt neue Partien selbst von chess.com, wertet sie mit Stockfish aus und baut aus Justins Fehlern eigene Aufgaben (ueberblick: chesscom, fehlerAufgaben.automatisch).
Eröffnungs-Check: Die App vergleicht jede Partie mit dem Eröffnungsbuch. ueberblick zeigt unter "repertoire", wo Justin abgewichen ist und wozu im Buch noch eine Antwort fehlt.
Das Buch ergänzt du über daten_speichern im Feld "buch": eine Liste aus {"farbe":"w"|"b","name":"Schottisch · 3…d5","zuege":"e4 e5 Nf3 Nc6 d4 d5 exd5"} (englische SAN ab Grundstellung, die Linie endet mit Justins Zug). Deine Einträge kommen zu den eingebauten Linien dazu.
Am Brett übt Justin "Erst prüfen, dann ziehen", "Angreifer und Verteidiger zählen" und das Ausspielen gegen Stockfish (ueberblick: brettTraining).`;

const T = (name, title, description, props = {}, required = [], readOnly = false) => ({
  name,
  title,
  description,
  inputSchema: { type: "object", properties: props, required, additionalProperties: false },
  annotations: { title, readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
});

const UEBUNG = {
  type: "object",
  description: "Eine Übung am Brett",
  properties: {
    id: { type: "string", description: "Eindeutige id, z. B. u-xyz. Gibt es die id schon, wird die Übung ersetzt." },
    frage: { type: "string" },
    antwort: { type: "array", items: { type: "string" }, description: "Richtige Züge in englischer SAN" },
    warum: { type: "string", description: "Erklärung nach dem Lösen" },
    seite: { type: "string", enum: ["w", "b"], description: "Aus wessen Sicht das Brett steht" },
    line: { type: "array", items: { type: "string" }, description: "Züge ab Grundstellung bis zur Aufgabe (SAN). Entweder line oder fen." },
    fen: { type: "string", description: "Stellung der Aufgabe. Entweder line oder fen." },
    schwaeche: { type: "string", description: "id einer Schwäche, falls passend" },
    quelle: { type: "string", description: "z. B. vs Gegnername" },
    ok: { type: "object", description: "Zug → Text für gute, aber nicht beste Züge", additionalProperties: { type: "string" } },
    falsch: { type: "object", description: "Zug → Text für typische falsche Züge", additionalProperties: { type: "string" } },
  },
  required: ["id", "frage", "antwort", "warum", "seite"],
};

const TOOLS = [
  T("ueberblick", "Überblick", "Aktueller Stand von Justin: Woche, Serie, Plan-Fortschritt, Trefferquote, offene Fehler-Aufgaben, letzte Partien mit Eröffnungs-Check, Abweichungen vom Repertoire, Übungen am Brett, Abruf von chess.com, Fragen, Nachricht, Prüfergebnis neuer Übungen, welche KI zuletzt geantwortet hat.", {}, [], true),
  T("fortschritt_lesen", "Fortschritt lesen", "Rohdaten des Fortschritts aus der App. Ohne teil: alles außer den PGNs der Partien.", {
    teil: { type: "string", enum: ["plan", "days", "steps", "srs", "fertig", "custom", "notes", "games", "fragen", "pruefung", "motor", "seen", "drill", "rep", "cc", "auto"], description: "Nur diesen Teil lesen. drill = Übungen am Brett, rep = Eröffnungs-Check je Partie, cc = Abruf von chess.com, auto = Stand der Hintergrund-Auswertung" },
  }, [], true),
  T("daten_lesen", "Trainingsdaten lesen", "Die Trainingsdaten der App (Plan, Repertoire, Bibliothek, Schwächen, Übungen, Partien, Nachricht).", {
    teil: { type: "string", enum: ["spieler", "planStart", "repertoire", "wochen", "artifacts", "schwaechen", "uebungen", "partien", "lichess", "nachricht", "buch"] },
  }, [], true),
  T("daten_speichern", "Trainingsdaten ersetzen", "Ersetzt die kompletten Trainingsdaten. Vorher mit daten_lesen holen und version_vorher angeben, damit nichts überschrieben wird. version und stand setzt der Server.", {
    daten: { type: "object", description: "Komplettes Datenobjekt" },
    version_vorher: { type: "integer", description: "Version, die du gelesen hast" },
  }, ["daten", "version_vorher"]),
  T("uebungen_hinzufuegen", "Übungen hinzufügen", "Fügt Übungen hinzu oder ersetzt welche mit gleicher id. Sie erscheinen unter Fehler und in der Wiederholung.", {
    uebungen: { type: "array", items: UEBUNG, minItems: 1 },
  }, ["uebungen"]),
  T("uebung_entfernen", "Übung entfernen", "Entfernt eine Übung aus den Trainingsdaten.", { id: { type: "string" } }, ["id"]),
  T("bibliothek_hinzufuegen", "Bibliothek ergänzen", "Fügt Einträge unter Übungen › Bibliothek hinzu (z. B. ein neues Quiz-Artifact oder eine Lichess-Studie) oder ersetzt welche mit gleicher id.", {
    eintraege: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          gruppe: { type: "string", enum: ["plan", "eroeffnung", "taktik", "partien", "endspiel", "mittelspiel"] },
          titel: { type: "string" },
          text: { type: "string" },
          url: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          wochen: { type: "array", items: { type: "integer" }, description: "Wochen, in denen der Eintrag auf Heute empfohlen wird" },
          datum: { type: "string", description: "YYYY-MM-DD, sonst heute" },
        },
        required: ["id", "gruppe", "titel", "text", "url"],
      },
    },
  }, ["eintraege"]),
  T("schwaeche_setzen", "Schwäche setzen", "Legt eine Schwäche an oder ändert sie. plus_eins zählt eine weitere Partie mit diesem Fehler.", {
    id: { type: "string" },
    titel: { type: "string" },
    text: { type: "string" },
    anzahl: { type: "integer" },
    plus_eins: { type: "boolean" },
  }, ["id"]),
  T("partie_hinzufuegen", "Partie hinzufügen", "Speichert eine Partie unter Übungen › Meine Partien (z. B. wenn Justin dir ein PGN in Claude schickt).", {
    partie: {
      type: "object",
      properties: {
        id: { type: "string" },
        datum: { type: "string" },
        gegner: { type: "string" },
        farbe: { type: "string", enum: ["w", "b"], description: "Justins Farbe" },
        ergebnis: { type: "string", enum: ["1-0", "0-1", "1/2-1/2", "*"] },
        eroeffnung: { type: "string" },
        kurz: { type: "string", description: "1 Satz Fazit" },
        pgn: { type: "string", description: "Züge in englischer SAN" },
        quelle: { type: "string", description: "z. B. vs Gegnername, verknüpft passende Übungen" },
        quiz: { type: "string", description: "Link zu einem Quiz zur Partie" },
        eloIch: { type: "string" },
        eloGegner: { type: "string" },
      },
      required: ["datum", "gegner", "farbe", "ergebnis", "pgn"],
    },
  }, ["partie"]),
  T("partie_lesen", "Partie lesen", "Eine Partie mit PGN und, falls vorhanden, der Analyse aus der App.", { id: { type: "string" } }, ["id"], true),
  T("nachricht_setzen", "Nachricht an Justin", "Zeigt Justin auf der Startseite der App eine Nachricht von dir (kurz, **fett** und Listen mit - gehen). Leerer Text entfernt sie.", {
    text: { type: "string" },
  }, ["text"]),
  T("chat_lesen", "Trainer-Chat lesen", "Die letzten Nachrichten aus dem Trainer-Chat in der App.", { anzahl: { type: "integer", description: "Standard 10" } }, [], true),
  T("ki_status", "KI-Status", "Welcher KI-Anbieter zuletzt geantwortet hat und welche Fehler es gab.", {}, [], true),
  T("dokumente_importieren", "Dokumente übernehmen", "Übernimmt gespeicherte App-Dokumente, z. B. aus der alten Claude-Version der App: state (Fortschritt), chat, analyse-<id>, verlauf-<id>. Vorhandene Dokumente werden nur mit ueberschreiben=true ersetzt. Danach muss Justin die App einmal neu öffnen.", {
    dokumente: { type: "object", description: "Name → Inhalt, z. B. {\"state\": {...}, \"analyse-a-123\": {...}}", additionalProperties: { type: "object" } },
    ueberschreiben: { type: "boolean", description: "Vorhandene Dokumente ersetzen" },
  }, ["dokumente"]),
];

function pruefeUebung(u) {
  if (!u || typeof u !== "object") throw new Error("Übung fehlt");
  for (const f of ["id", "frage", "warum"]) if (typeof u[f] !== "string" || !u[f].trim()) throw new Error("Übung " + (u.id || "?") + ": " + f + " fehlt");
  if (!Array.isArray(u.antwort) || !u.antwort.length) throw new Error("Übung " + u.id + ": antwort muss eine Liste mit mindestens einem Zug sein");
  if (!["w", "b"].includes(u.seite)) throw new Error("Übung " + u.id + ": seite muss w oder b sein");
  const hatLinie = Array.isArray(u.line) && u.line.length;
  if (!hatLinie && !(typeof u.fen === "string" && u.fen.trim())) throw new Error("Übung " + u.id + ": line oder fen fehlt");
  const out = { id: u.id, frage: u.frage, antwort: u.antwort.map(String), warum: u.warum, seite: u.seite };
  if (hatLinie) out.line = u.line.map(String);
  else out.fen = u.fen.trim();
  for (const f of ["schwaeche", "quelle"]) if (u[f]) out[f] = String(u[f]);
  for (const f of ["ok", "falsch"]) if (u[f] && typeof u[f] === "object") out[f] = u[f];
  return out;
}

function ersetzeOderAnhaengen(arr, item) {
  const i = arr.findIndex((x) => x && x.id === item.id);
  if (i >= 0) arr[i] = item;
  else arr.push(item);
  return i >= 0 ? "ersetzt" : "neu";
}

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/* ---------- Speicher (Durable Object) ---------- */
export class Store {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.s = ctx.storage;
  }

  async getDoc(name) {
    const d = await this.s.get("doc:" + name);
    return d ? JSON.parse(d.text) : null;
  }
  async meta(name) {
    const d = await this.s.get("doc:" + name);
    return d ? { rev: d.rev, updated: d.updated } : null;
  }
  async putDoc(name, obj) {
    const alt = await this.s.get("doc:" + name);
    const d = { text: JSON.stringify(obj), rev: (alt ? alt.rev : 0) + 1, updated: new Date().toISOString() };
    await this.s.put("doc:" + name, d);
    return d.rev;
  }
  async aendereDaten(fn) {
    const D = await this.getDoc("daten");
    if (!D) throw new Error("Es gibt noch keine Trainingsdaten. Justin muss die App einmal mit Zugangscode öffnen.");
    const info = fn(D);
    D.version = (Number(D.version) || 0) + 1;
    D.stand = heute();
    await this.putDoc("daten", D);
    return { ok: true, version: D.version, ...(info || {}) };
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/ping") {
      await this.s.put("ping", Date.now());
      return json({ ok: true });
    }
    if (p === "/mcp") return this.mcp(req);
    if (p === "/log" && req.method === "POST") {
      let e = {};
      try { e = await req.json(); } catch (x) {}
      const log = (await this.s.get("log")) || [];
      log.push(e);
      await this.s.put("log", log.slice(-30));
      return json({ ok: true });
    }
    if (p.startsWith("/api/doc/")) {
      const name = decodeURIComponent(p.slice("/api/doc/".length));
      if (!/^[A-Za-z0-9][A-Za-z0-9_.~-]{0,100}$/.test(name)) return json({ fehler: "Ungültiger Name" }, 400);
      const key = "doc:" + name;
      if (req.method === "GET") {
        const d = await this.s.get(key);
        if (!d) return json({ fehler: "Nicht gefunden" }, 404);
        return new Response('{"rev":' + d.rev + ',"updated":' + JSON.stringify(d.updated) + ',"data":' + d.text + "}", {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (req.method === "PUT") {
        const text = await req.text();
        if (text.length > 1800000) return json({ fehler: "Zu groß" }, 413);
        try { JSON.parse(text); } catch (e) { return json({ fehler: "Kein gültiges JSON" }, 400); }
        const alt = await this.s.get(key);
        const d = { text, rev: (alt ? alt.rev : 0) + 1, updated: new Date().toISOString() };
        await this.s.put(key, d);
        return json({ rev: d.rev });
      }
      if (req.method === "DELETE") {
        await this.s.delete(key);
        return json({ ok: true });
      }
      return json({ fehler: "Methode nicht erlaubt" }, 405);
    }
    return json({ fehler: "Unbekannt" }, 404);
  }

  /* MCP über HTTP: JSON-RPC rein, JSON raus, ohne Sitzung */
  async mcp(req) {
    if (req.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    let msg;
    try { msg = await req.json(); } catch (e) {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const batch = Array.isArray(msg);
    const out = [];
    for (const m of batch ? msg : [msg]) {
      const r = await this.rpc(m);
      if (r) out.push(r);
    }
    if (!out.length) return new Response(null, { status: 202 });
    return json(batch ? out : out[0]);
  }

  async rpc(m) {
    const istNachricht = !m || m.id === undefined || m.id === null;
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string")
      return istNachricht ? null : { jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "Invalid Request" } };
    let result;
    switch (m.method) {
      case "initialize": {
        const will = m.params && m.params.protocolVersion;
        result = {
          protocolVersion: MCP_VERSIONEN.includes(will) ? will : MCP_VERSIONEN[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "schach-app", title: "Justins Schach-App", version: "1.0.0" },
          instructions: ANLEITUNG,
        };
        break;
      }
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "resources/list":
        result = { resources: [] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      case "tools/call":
        result = await this.werkzeug((m.params && m.params.name) || "", (m.params && m.params.arguments) || {});
        break;
      default:
        if (istNachricht) return null;
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } };
    }
    return istNachricht ? null : { jsonrpc: "2.0", id: m.id, result };
  }

  async werkzeug(name, a) {
    const fn = this["w_" + name];
    if (typeof fn !== "function") return { content: [{ type: "text", text: "Unbekanntes Werkzeug: " + name }], isError: true };
    try {
      const r = await fn.call(this, a || {});
      return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 1) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "Fehler: " + ((e && e.message) || e) }], isError: true };
    }
  }

  async w_ueberblick() {
    const D = (await this.getDoc("daten")) || {};
    const S = (await this.getDoc("state")) || {};
    const C = (await this.getDoc("chat")) || { turns: [] };
    const mS = await this.meta("state");
    const t = heute();
    const wochen = D.wochen || [];
    const nr = S.weekOverride || Math.max(1, Math.min(8, Math.floor((new Date(t + "T12:00:00Z") - new Date((D.planStart || "2026-10-28") + "T12:00:00Z")) / 864e5 / 7) + 1));
    const w = wochen.find((x) => x.n === nr) || wochen[0] || { aufgaben: [] };
    const plan = S.plan || {};
    const tk = (n, i) => "w" + n + "t" + i;
    const tage = new Set(S.days || []);
    let d = t, serie = 0;
    if (!tage.has(d)) d = plusTage(d, -1);
    while (tage.has(d)) { serie++; d = plusTage(d, -1); }
    let letzte7 = 0;
    for (let i = 0; i < 7; i++) if (tage.has(plusTage(t, -i))) letzte7++;
    const items = [...(D.uebungen || []), ...(S.custom || [])];
    const fertig = S.fertig || {}, srs = S.srs || {};
    let r = 0, f = 0;
    items.forEach((it) => { const s = srs[it.id]; if (s) { r += s.r || 0; f += s.w || 0; } });
    const offen = items.filter((it) => !fertig[it.id]);
    const games = [...(D.partien || []).map((g) => ({ ...g, herkunft: "Daten" })), ...(S.games || []).map((g) => ({ ...g, herkunft: "importiert" }))]
      .sort((a, b) => String(b.datum || "").localeCompare(String(a.datum || "")));
    const log = (await this.s.get("log")) || [];
    // Eröffnungs-Check, den die App je Partie gespeichert hat
    const rep = S.rep || {};
    const zugText = (zuege) => String(zuege || "").split(" ").filter(Boolean).map((m, i) => (i % 2 === 0 ? i / 2 + 1 + "." : "") + m).join(" ");
    const repText = (r) => !r ? undefined
      : r.a === "ich" ? "abgewichen: " + zugText(r.v) + " statt " + (r.b || []).join("/")
      : r.a === "gegner" ? (r.k ? r.k + " Buchzüge, dann wich der Gegner ab: " : "nicht im Buch: ") + zugText(r.v)
      : r.a === "ende" ? r.k + " Buchzüge, bis zum Ende des Buchs" + (r.n ? " (" + r.n + ")" : "")
      : "nicht im Buch";
    const zaehle = (art) => {
      const m = {};
      for (const g of games) {
        const r = rep[g.id];
        if (!r || r.a !== art) continue;
        const k = zugText(r.v) + (art === "ich" ? " statt " + (r.b || []).join("/") : "");
        m[k] = m[k] || { stelle: k, anzahl: 0, zuletzt: g.datum };
        m[k].anzahl++;
      }
      return Object.values(m).sort((a, b) => b.anzahl - a.anzahl).slice(0, 8);
    };
    const drill = S.drill || {};
    const custom = S.custom || [];
    return {
      heute: t,
      woche: {
        nr,
        titel: w.titel,
        ziel: w.ziel,
        taktik: w.taktik,
        endspiel: w.endspiel,
        offeneAufgaben: (w.aufgaben || []).filter((_, i) => !plan[tk(nr, i)]),
        erledigt: (w.aufgaben || []).filter((_, i) => plan[tk(nr, i)]).length + "/" + (w.aufgaben || []).length,
        vonHandGesetzt: !!S.weekOverride,
      },
      heuteErledigt: (S.steps || {})[t] || {},
      serieTage: serie,
      trainingstageLetzte7: letzte7,
      planGesamt: Object.values(plan).filter(Boolean).length + "/" + wochen.reduce((a, x) => a + (x.aufgaben || []).length, 0),
      wiederholungen: { richtig: r, falsch: f, quote: r + f ? Math.round((r / (r + f)) * 100) + "%" : "noch keine" },
      fehlerAufgaben: {
        offen: offen.length,
        abgeschlossen: items.length - offen.length,
        faellig: offen.filter((it) => !srs[it.id] || srs[it.id].due <= t).length,
        eigeneAusPartien: custom.length,
        automatisch: custom.filter((c) => c.auto).length,
        automatischOffen: custom.filter((c) => c.auto && !fertig[c.id]).length,
      },
      schwaechen: (D.schwaechen || []).map((s) => ({ id: s.id, titel: s.titel, anzahl: s.anzahl })),
      letztePartien: games.slice(0, 8).map((g) => ({ id: g.id, datum: g.datum, gegner: g.gegner, farbe: g.farbe, ergebnis: g.ergebnis, eroeffnung: g.eroeffnung, kurz: g.kurz, herkunft: g.auto ? "chess.com" : g.herkunft, analyse: (S.anaIds || []).includes(g.id), repertoire: repText(rep[g.id]) })),
      repertoire: { abgewichen: zaehle("ich"), antwortFehltImBuch: zaehle("gegner"), eigeneBuchLinien: Array.isArray(D.buch) ? D.buch.length : 0 },
      brettTraining: {
        erstPruefen: drill.pruef ? { stellungen: drill.pruef.n, schachsGefunden: drill.pruef.sG + "/" + drill.pruef.sA, schlagzuegeGefunden: drill.pruef.cG + "/" + drill.pruef.cA, falschGetippt: drill.pruef.f, guteZuege: drill.pruef.z, zuletzt: drill.pruef.d } : null,
        zaehlen: drill.zaehl ? { stellungen: drill.zaehl.n, allesRichtig: drill.zaehl.r, angreiferRichtig: drill.zaehl.a, verteidigerRichtig: drill.zaehl.v, urteilRichtig: drill.zaehl.u, zuletzt: drill.zaehl.d } : null,
        ausspielen: drill.spiel ? { gespielt: drill.spiel.n, geschafft: drill.spiel.g, zuletzt: drill.spiel.d, jeStellung: drill.spiel.je } : null,
      },
      chesscom: S.cc ? { automatisch: !S.cc.aus, zuletztGeprueft: S.cc.t ? new Date(S.cc.t).toISOString() : null, zuletztNeu: S.cc.zuletztNeu || 0, fehler: S.cc.fehler || null, auswertungOffen: (S.games || []).filter((g) => !(S.anaIds || []).includes(g.id)).length } : null,
      letzteFragen: (S.fragen || []).slice(-8),
      eigeneNotizen: (S.notes || []).slice(-10),
      nachricht: D.nachricht || null,
      daten: { version: D.version, stand: D.stand, uebungen: (D.uebungen || []).length, bibliothek: (D.artifacts || []).length, partien: (D.partien || []).length },
      pruefung: S.pruefung || null,
      stockfish: S.motor || null,
      chat: { nachrichten: (C.turns || []).length, letzteFragen: (C.turns || []).filter((x) => x.role === "user").slice(-3).map((x) => String(x.content).slice(0, 300)) },
      ki: log.slice(-3).reverse(),
      fortschrittZuletztGespeichert: mS ? mS.updated : null,
    };
  }

  async w_fortschritt_lesen(a) {
    const S = await this.getDoc("state");
    if (!S) return "Noch kein Fortschritt gespeichert.";
    if (a.teil) return S[a.teil] === undefined ? "Den Teil gibt es (noch) nicht." : S[a.teil];
    const kopie = { ...S, games: (S.games || []).map(({ pgn, ...g }) => g) };
    return kopie;
  }

  async w_daten_lesen(a) {
    const D = await this.getDoc("daten");
    if (!D) return "Noch keine Trainingsdaten. Justin muss die App einmal mit Zugangscode öffnen.";
    if (a.teil) return { version: D.version, stand: D.stand, [a.teil]: D[a.teil] === undefined ? null : D[a.teil] };
    return D;
  }

  async w_daten_speichern(a) {
    const neu = a.daten;
    if (!neu || typeof neu !== "object" || Array.isArray(neu)) throw new Error("daten muss ein Objekt sein");
    for (const f of ["spieler", "wochen", "artifacts", "schwaechen", "uebungen"]) if (neu[f] === undefined) throw new Error("Pflichtfeld fehlt: " + f);
    if (!Array.isArray(neu.wochen) || !neu.wochen.length) throw new Error("wochen muss eine nicht leere Liste sein");
    neu.uebungen = neu.uebungen.map(pruefeUebung);
    const alt = await this.getDoc("daten");
    const v = alt ? Number(alt.version) || 0 : 0;
    if (Number(a.version_vorher) !== v) throw new Error("Version passt nicht: gespeichert ist " + v + ", du hast " + a.version_vorher + " angegeben. Erst neu lesen.");
    neu.version = v + 1;
    neu.stand = heute();
    await this.putDoc("daten", neu);
    return { ok: true, version: neu.version };
  }

  async w_uebungen_hinzufuegen(a) {
    if (!Array.isArray(a.uebungen) || !a.uebungen.length) throw new Error("uebungen fehlt");
    const neu = a.uebungen.map(pruefeUebung);
    return this.aendereDaten((D) => {
      D.uebungen = D.uebungen || [];
      const res = neu.map((u) => u.id + ": " + ersetzeOderAnhaengen(D.uebungen, u));
      return { uebungen: res, hinweis: "Die App prüft die Züge beim nächsten Öffnen, Ergebnis in ueberblick unter pruefung." };
    });
  }

  async w_uebung_entfernen(a) {
    return this.aendereDaten((D) => {
      const vor = (D.uebungen || []).length;
      D.uebungen = (D.uebungen || []).filter((u) => u.id !== a.id);
      if (D.uebungen.length === vor) throw new Error("Keine Übung mit id " + a.id);
      return { entfernt: a.id };
    });
  }

  async w_bibliothek_hinzufuegen(a) {
    if (!Array.isArray(a.eintraege) || !a.eintraege.length) throw new Error("eintraege fehlt");
    const neu = a.eintraege.map((e) => {
      for (const f of ["id", "gruppe", "titel", "text", "url"]) if (!e || typeof e[f] !== "string" || !e[f].trim()) throw new Error("Eintrag: " + f + " fehlt");
      const o = { id: e.id, gruppe: e.gruppe, titel: e.titel, text: e.text, url: e.url, tags: Array.isArray(e.tags) ? e.tags.map(String) : [], datum: e.datum || heute() };
      if (Array.isArray(e.wochen)) o.wochen = e.wochen.map(Number).filter((n) => n >= 1 && n <= 8);
      return o;
    });
    return this.aendereDaten((D) => {
      D.artifacts = D.artifacts || [];
      return { eintraege: neu.map((e) => e.id + ": " + ersetzeOderAnhaengen(D.artifacts, e)) };
    });
  }

  async w_schwaeche_setzen(a) {
    if (!a.id) throw new Error("id fehlt");
    return this.aendereDaten((D) => {
      D.schwaechen = D.schwaechen || [];
      let s = D.schwaechen.find((x) => x.id === a.id);
      if (!s) {
        if (!a.titel) throw new Error("Neue Schwäche braucht einen titel");
        s = { id: a.id, titel: a.titel, text: a.text || "", anzahl: 0 };
        D.schwaechen.push(s);
      }
      if (a.titel) s.titel = a.titel;
      if (a.text !== undefined) s.text = a.text;
      if (Number.isInteger(a.anzahl)) s.anzahl = a.anzahl;
      if (a.plus_eins) s.anzahl = (Number(s.anzahl) || 0) + 1;
      return { schwaeche: s };
    });
  }

  async w_partie_hinzufuegen(a) {
    const g = a.partie;
    if (!g || typeof g !== "object") throw new Error("partie fehlt");
    for (const f of ["datum", "gegner", "farbe", "ergebnis", "pgn"]) if (!g[f]) throw new Error("partie: " + f + " fehlt");
    const p = { ...g, id: g.id || "g-" + g.datum + "-" + slug(g.gegner) };
    return this.aendereDaten((D) => {
      D.partien = D.partien || [];
      return { partie: p.id + ": " + ersetzeOderAnhaengen(D.partien, p) };
    });
  }

  async w_partie_lesen(a) {
    const D = (await this.getDoc("daten")) || {};
    const S = (await this.getDoc("state")) || {};
    const g = (D.partien || []).find((x) => x.id === a.id) || (S.games || []).find((x) => x.id === a.id);
    if (!g) throw new Error("Keine Partie mit id " + a.id + ". Die ids stehen in ueberblick unter letztePartien.");
    const ana = await this.getDoc("analyse-" + String(a.id).replace(/[^A-Za-z0-9_.~-]/g, "_"));
    return { partie: g, analyse: ana };
  }

  async w_nachricht_setzen(a) {
    const text = String(a.text || "").trim();
    return this.aendereDaten((D) => {
      if (text) D.nachricht = { text, datum: heute() };
      else delete D.nachricht;
      return { nachricht: text ? "gesetzt" : "entfernt" };
    });
  }

  async w_chat_lesen(a) {
    const C = (await this.getDoc("chat")) || { turns: [] };
    const n = Math.max(1, Math.min(40, Number(a.anzahl) || 10));
    return (C.turns || []).slice(-n);
  }

  async w_dokumente_importieren(a) {
    const docs = a.dokumente;
    if (!docs || typeof docs !== "object" || Array.isArray(docs)) throw new Error("dokumente muss ein Objekt sein");
    const ergebnis = {};
    for (const [name, data] of Object.entries(docs)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.~-]{0,100}$/.test(name)) { ergebnis[name] = "ungültiger Name"; continue; }
      if (!data || typeof data !== "object") { ergebnis[name] = "kein Objekt"; continue; }
      const da = await this.s.get("doc:" + name);
      if (da && !a.ueberschreiben) { ergebnis[name] = "übersprungen, gibt es schon"; continue; }
      await this.putDoc(name, data);
      ergebnis[name] = da ? "ersetzt" : "neu";
    }
    return { ok: true, ergebnis, hinweis: "Justin muss die App einmal neu öffnen, damit sie den Stand lädt." };
  }

  async w_ki_status() {
    const log = (await this.s.get("log")) || [];
    return {
      reihenfolge: liste(this.env.ANBIETER || "nvidia,gemini"),
      nvidia: { key: !!this.env.NVIDIA_API_KEY, modelle: liste(this.env.NVIDIA_MODELLE) },
      gemini: { key: !!this.env.GEMINI_API_KEY, modelle: liste(this.env.GEMINI_MODELLE) },
      letzte: log.slice(-10).reverse(),
    };
  }
}
