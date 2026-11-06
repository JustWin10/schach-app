# Justins Schach-App

Trainings-App für Schottisch (Weiß) und Nimzo-Indisch (Schwarz): Tagesplan, 8-Wochen-Plan,
Fehler-Wiederholung, Partie-Analyse mit Stockfish und ein Trainer-Chat.

## So hängt alles zusammen

| Teil | Ordner | Läuft auf |
|---|---|---|
| App (HTML, Stockfish) | `web/` | wird vom Server ausgeliefert |
| Server | `server/` | Cloudflare Worker (kostenlos) |
| Android-App | `android/` | Handy, zeigt die App vom Server |

- **Speicher:** Fortschritt, Chat, Analysen und Trainingsdaten liegen auf dem Server, nicht nur auf dem Handy.
- **Trainer-Fragen:** gehen an ein kostenloses KI-Modell. Zuerst NVIDIA, und wenn das nicht klappt
  (Fehler, Limit, Credits leer), automatisch Gemini. Modelle und Reihenfolge stehen in `server/wrangler.toml`.
- **Claude:** greift über den Connector `https://<server>/mcp/<zugangscode>` auf die App zu, liest den
  Fortschritt und legt Übungen, Partien, Bibliothekseinträge und Nachrichten an.
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
