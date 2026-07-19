# Gezeiten-App

Eine kleine, eigenständige Web-App, die aktuelle Gezeitenvorhersagen (Hochwasser/Niedrigwasser)
für Stationen an der deutschen Nordsee- und Ostseeküste anzeigt — installierbar auf iPhone/iPad
als App-Icon auf dem Homescreen.

Drei Tabs: **Suche** (Station suchen, Zeitraum wählen, als Favorit speichern), **Favoriten**
(gespeicherte Stationen kompakt, Tippen öffnet die 5-Tage-Vorhersage) und **Brunsbüttel**
(fest eingestellte Station mit Stammdaten, Tiefgang-Eingabe und Wasserstandskurve).

Sie besteht nur aus einfachen Dateien (HTML, CSS, JavaScript) — **kein** Node.js, kein Build-Schritt,
keine npm-Pakete nötig. Das macht sie leicht verständlich und leicht anpassbar.

## Wie funktioniert das?

- Die Gezeitendaten kommen live vom **BSH** (Bundesamt für Seeschifffahrt und Hydrographie) —
  kostenlos, ohne Anmeldung, öffentlich unter CC BY 4.0 lizenziert.
- `app.js` fragt diese Daten direkt im Browser ab (kein eigener Server nötig) und zeigt sie an.
- `index.html` ist das Grundgerüst der Seite, `styles.css` das Aussehen.
- `manifest.webmanifest` + `sw.js` (Service Worker) sorgen dafür, dass sich die App wie eine
  "richtige" App aufs Homescreen legen lässt und auch offline sofort öffnet (die Live-Daten
  brauchen dafür natürlich trotzdem Internet).

## Lokal ausprobieren

Browser blockieren aus Sicherheitsgründen manche Funktionen (Service Worker, teils auch `fetch`),
wenn man die `index.html` einfach per Doppelklick öffnet. Man braucht einen ganz simplen lokalen
Webserver. Zwei Möglichkeiten, beide kostenlos:

**Mit Node.js** (falls installiert):

```bash
cd gezeiten-app
npx serve .
```

**Mit Python** (auf Mac oft schon vorinstalliert):

```bash
cd gezeiten-app
python3 -m http.server 8000
```

Danach im Browser öffnen: `http://localhost:8000` (bzw. die von `npx serve` angezeigte Adresse).

## Kostenlos veröffentlichen

Damit du die App auch auf deinem iPhone/iPad nutzen kannst, muss sie unter einer echten
`https://`-Adresse erreichbar sein. Am einfachsten geht das mit einem kostenlosen Hosting-Dienst,
der **nur den Ordner `gezeiten-app`** braucht (kein Build, kein Server nötig):

- **Netlify Drop** (am einfachsten): Auf https://app.netlify.com/drop den Ordner `gezeiten-app`
  per Drag & Drop hochladen — fertig, du bekommst sofort eine Adresse.
- **GitHub Pages**: In den Repo-Einstellungen unter "Pages" den Ordner `gezeiten-app` als
  Quelle einstellen.
- **Vercel**: Neues Projekt anlegen, dieses Repo verbinden, als "Root Directory" `gezeiten-app`
  angeben, kein Build-Command nötig.

## Auf dem iPhone/iPad installieren

1. Die veröffentlichte Adresse in **Safari** öffnen (wichtig: Safari, nicht Chrome).
2. Auf das Teilen-Symbol tippen (Quadrat mit Pfeil nach oben).
3. **"Zum Home-Bildschirm"** auswählen.
4. Fertig — die App erscheint als eigenes Icon und öffnet sich im Vollbild, ohne Browser-Leiste.

## Anpassen

- **Farben/Aussehen**: ganz oben in `styles.css`, in den `:root { ... }`-Variablen
  (`--farbe-akzent` usw.). Es gibt auch einen automatischen Dunkelmodus-Block direkt darunter.
- **App-Name**: in `index.html` (`<title>`) und in `manifest.webmanifest` (`"name"`/`"short_name"`).
- **Icon**: liegt im Projekt-Root. Es wurde einfach generiert (Wellen auf blauem Verlauf) — ersetzbar
  durch eigene PNG-Dateien in den gleichen Größen (192×192, 512×512, 512×512 maskable,
  180×180 für `apple-touch-icon.png`).
- **Zeitraum-Optionen** (3 Tage/1 Woche): `ZEITRAUM_TAGE` in `app.js`.
- **Brunsbüttel-Tab**: feste Station über `BRUNSBUETTEL_LABEL`, Referenzlinie über `PNP_REFERENZ_CM`
  in `app.js`. Das Tfg-Eingabefeld (Tiefgang) wird aktuell nur validiert und gespeichert, fließt
  noch in keine Berechnung ein.

## Bekannte Grenzen

- Die BSH-Vorhersage deckt nur deutsche Küstenpegel ab (Nordsee, Elbe, Weser, Ems, Ostsee usw.),
  nicht das Ausland.
- Ohne Internetverbindung zeigt die App die zuletzt geladenen Daten mit einem Hinweis an, statt
  neue abzurufen.
