# Justins Schach-App

Trainings-App für Schottisch (Weiß) und Nimzo-Indisch (Schwarz): Tagesplan, 8-Wochen-Plan,
Fehler-Wiederholung, Partie-Analyse mit Stockfish und ein Trainer-Chat.

Die App holt neue Partien selbst von chess.com, wertet sie im Hintergrund aus und baut aus den eigenen
Fehlern Aufgaben. Jede Partie bekommt einen Eröffnungs-Check gegen das Eröffnungsbuch (mit Bilanz je
Eröffnung). Unter „Am Brett“ gibt es drei Übungen: „Erst prüfen, dann ziehen“, „Angreifer und
Verteidiger zählen“ und das Ausspielen von Endspielen, Repertoire-Stellungen und eigenen Partien gegen Stockfish.

## So hängt alles zusammen

| Teil | Ordner | Läuft auf |
|---|---|---|
| App (HTML, Stockfish) | `web/` | wird vom Server ausgeliefert |
| Server | `server/` | Cloudflare Worker (kostenlos) |
| Android-App | `android/` | Handy, zeigt die App vom Server |

- **Speicher:** Fortschritt, Chat, Analysen und Trainingsdaten liegen auf dem Server, nicht nur auf dem Handy.
- **Mehrere Geräte:** Handy und Tablet nutzen denselben Zugangscode und teilen sich den Fortschritt. Jedes
  Speichern nennt die Version, auf der es aufbaut (`X-Rev`). Hat das andere Gerät inzwischen gespeichert,
  führt die App beide Stände zusammen, statt einen zu überschreiben. Den Code für ein weiteres Gerät zeigt
  die App unter „Heute“ → „Weiteres Gerät verbinden“.
- **Tablet:** Ab 700 px Breite gibt es eine größere Schrift und ein großes Brett, im Querformat steht die
  Navigation links und der Text neben dem Brett.
- **Trainer-Fragen:** gehen an ein kostenloses KI-Modell. Zuerst NVIDIA, und wenn das nicht klappt
  (Fehler, Limit, Credits leer), automatisch Gemini. Modelle und Reihenfolge stehen in `server/wrangler.toml`.
- **Claude:** greift über den Connector `https://<server>/mcp/<zugangscode>` auf die App zu, liest den
  Fortschritt und legt Übungen, Partien, Bibliothekseinträge und Nachrichten an.
- **chess.com:** Der Server holt das öffentliche Partie-Archiv (`/api/chesscom`), der Name steht in den
  Trainingsdaten unter `spieler.chesscom`. Klappt das nicht, fragt die App chess.com direkt.
- **Eröffnungsbuch:** Die eingebauten Linien stehen in `web/index.html` (`BUCH`). Claude ergänzt weitere
  über den Connector im Feld `buch` der Trainingsdaten.
- **Zugangscode:** nur der SHA-256-Wert steht im Repo (`TOKEN_HASH`). Ohne Code kommt niemand an Daten oder KI.

## Updates

Jeder Push auf `main` startet `.github/workflows/bauen.yml`:

1. Server und App gehen zu Cloudflare, die KI-Keys werden als Secrets hinterlegt.
2. Die APK wird gebaut und im Release [`app`](../../releases/tag/app) bereitgestellt.

Änderungen an der App (`web/`) kommen ohne neue APK aufs Handy. Die APK muss nur neu installiert werden,
wenn sich etwas in `android/` ändert.

## Benötigte Secrets (Settings → Secrets and variables → Actions)

`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`

Der APK-Signierschlüssel `android/release.p12` ist mit einem Passwort geschützt, das aus
`CLOUDFLARE_API_TOKEN` abgeleitet wird. Wird dieses Secret geändert, entsteht ein neuer Schlüssel und
die App muss einmal neu installiert werden.
