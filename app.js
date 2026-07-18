// Lädt Gezeitenvorhersagen direkt vom BSH (Bundesamt für Seeschifffahrt und
// Hydrographie) — öffentlich, kostenlos, ohne Schlüssel nutzbar (CC BY 4.0).
const BSH_URL =
  'https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast/collections/waterlevelforecastdata/items?lang=en&f=json&limit=200';

const FETCH_TIMEOUT_MS = 10000;
const AUTO_REFRESH_MS = 10 * 60 * 1000; // BSH aktualisiert die Vorhersage nicht minütlich
const COUNTDOWN_TICK_MS = 30 * 1000;
const MAX_ANGEZEIGTE_EREIGNISSE = 6;

const STORAGE_KEY_STATION = 'gezeiten:letzteStation';
const STORAGE_KEY_CACHE = 'gezeiten:cache';

const el = {
  input: document.getElementById('station-input'),
  results: document.getElementById('station-results'),
  statusBanner: document.getElementById('status-banner'),
  emptyState: document.getElementById('empty-state'),
  tideNow: document.getElementById('tide-now'),
  directionIcon: document.getElementById('tide-direction-icon'),
  directionText: document.getElementById('tide-direction-text'),
  directionTime: document.getElementById('tide-direction-time'),
  listSection: document.getElementById('tide-list-section'),
  list: document.getElementById('tide-list'),
  updatedAt: document.getElementById('updated-at'),
};

/** @type {Map<string, {typ: 'HW'|'NW', zeit: Date}[]>} */
let stationen = new Map();
let ausgewaehlteStation = null;
let letzteAktualisierung = null;

function parseBshZeitstempel(roh) {
  // BSH liefert "2026-07-02 13:54:00+02:00" — Leerzeichen statt "T" vor der Uhrzeit.
  return new Date(roh.replace(' ', 'T'));
}

async function ladeVonBsh() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(BSH_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`BSH-Abfrage fehlgeschlagen: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const features = payload.features || [];

  const neueStationen = new Map();
  for (const feature of features) {
    const label = feature.properties?.gauge_label;
    const rohEreignisse = feature.properties?.high_water_low_water || [];
    if (!label || rohEreignisse.length === 0) continue;
    const ereignisse = rohEreignisse
      .filter((e) => e.event === 'HW' || e.event === 'NW')
      .map((e) => ({ typ: e.event, zeit: parseBshZeitstempel(e.event_timestamp) }))
      .sort((a, b) => a.zeit.getTime() - b.zeit.getTime());
    if (ereignisse.length > 0) neueStationen.set(label, ereignisse);
  }
  if (neueStationen.size === 0) {
    throw new Error('BSH-Antwort enthielt keine verwertbaren Stationsdaten.');
  }
  return neueStationen;
}

function stationenZuJson(map) {
  return JSON.stringify(
    Array.from(map.entries()).map(([label, ereignisse]) => [
      label,
      ereignisse.map((e) => ({ typ: e.typ, zeit: e.zeit.toISOString() })),
    ]),
  );
}

function stationenAusJson(text) {
  const rows = JSON.parse(text);
  return new Map(
    rows.map(([label, ereignisse]) => [
      label,
      ereignisse.map((e) => ({ typ: e.typ, zeit: new Date(e.zeit) })),
    ]),
  );
}

function speichereCache(map, zeitpunkt) {
  try {
    localStorage.setItem(STORAGE_KEY_CACHE, stationenZuJson(map));
    localStorage.setItem(`${STORAGE_KEY_CACHE}:zeit`, zeitpunkt.toISOString());
  } catch {
    // localStorage kann z. B. im privaten Modus fehlschlagen — dann eben ohne Cache.
  }
}

function ladeCache() {
  try {
    const text = localStorage.getItem(STORAGE_KEY_CACHE);
    const zeitText = localStorage.getItem(`${STORAGE_KEY_CACHE}:zeit`);
    if (!text || !zeitText) return null;
    return { stationen: stationenAusJson(text), zeitpunkt: new Date(zeitText) };
  } catch {
    return null;
  }
}

function zeigeBanner(text, { fehler = false, mitErneutButton = false } = {}) {
  el.statusBanner.hidden = false;
  el.statusBanner.classList.toggle('status-banner--fehler', fehler);
  el.statusBanner.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = text;
  p.style.margin = '0';
  el.statusBanner.appendChild(p);
  if (mitErneutButton) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Erneut versuchen';
    button.addEventListener('click', () => aktualisiereDaten({ zeigeFehler: true }));
    el.statusBanner.appendChild(button);
  }
}

function verstecke(node) {
  node.hidden = true;
}

async function aktualisiereDaten({ zeigeFehler = false } = {}) {
  try {
    const neueStationen = await ladeVonBsh();
    stationen = neueStationen;
    letzteAktualisierung = new Date();
    speichereCache(stationen, letzteAktualisierung);
    verstecke(el.statusBanner);
    aktualisiereFussnote();
    if (ausgewaehlteStation) renderGezeiten(ausgewaehlteStation);
  } catch (err) {
    console.error(err);
    if (stationen.size > 0) {
      // Wir haben noch (gecachte) Daten — nur dezent auf den Fehler hinweisen.
      if (zeigeFehler) {
        zeigeBanner('Aktualisierung fehlgeschlagen — zeige weiterhin den zuletzt geladenen Stand.', {
          fehler: true,
        });
      }
    } else {
      zeigeBanner('Gezeiten konnten nicht geladen werden. Bitte Internetverbindung prüfen.', {
        fehler: true,
        mitErneutButton: true,
      });
    }
  }
}

function aktualisiereFussnote() {
  if (!letzteAktualisierung) return;
  el.updatedAt.textContent = `Zuletzt aktualisiert: ${formatiereUhrzeitMitDatum(letzteAktualisierung)}`;
}

function formatiereUhrzeitMitDatum(datum) {
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(datum);
}

function istGleicherTag(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatiereEreignisDatum(zeit, jetzt) {
  const uhrzeit = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(zeit);
  const morgen = new Date(jetzt);
  morgen.setDate(morgen.getDate() + 1);
  if (istGleicherTag(zeit, jetzt)) return `Heute, ${uhrzeit} Uhr`;
  if (istGleicherTag(zeit, morgen)) return `Morgen, ${uhrzeit} Uhr`;
  const wochentagUndDatum = new Intl.DateTimeFormat('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  }).format(zeit);
  return `${wochentagUndDatum}, ${uhrzeit} Uhr`;
}

function formatiereCountdown(zeit, jetzt) {
  const diffMs = zeit.getTime() - jetzt.getTime();
  if (diffMs <= 0) return 'jetzt';
  const stunden = Math.floor(diffMs / 3600000);
  const minuten = Math.floor((diffMs % 3600000) / 60000);
  if (stunden === 0) return `in ${minuten} Min`;
  return `in ${stunden} Std ${minuten} Min`;
}

function renderGezeiten(label) {
  const ereignisse = stationen.get(label);
  if (!ereignisse) return;

  verstecke(el.emptyState);
  const jetzt = new Date();
  const kommendeEreignisse = ereignisse.filter((e) => e.zeit.getTime() > jetzt.getTime());

  if (kommendeEreignisse.length === 0) {
    el.tideNow.hidden = true;
    el.listSection.hidden = true;
    zeigeBanner('Für diese Station liegen aktuell keine kommenden Gezeiten in der BSH-Vorhersage vor.');
    return;
  }

  const naechstes = kommendeEreignisse[0];
  el.tideNow.hidden = false;
  const steigend = naechstes.typ === 'HW';
  el.tideNow.classList.toggle('tide-now--steigend', steigend);
  el.tideNow.classList.toggle('tide-now--fallend', !steigend);
  el.directionIcon.textContent = steigend ? '⬆️' : '⬇️';
  el.directionText.textContent = steigend ? 'Tide steigt — Richtung Hochwasser' : 'Tide fällt — Richtung Niedrigwasser';
  el.directionTime.textContent = `${formatiereEreignisDatum(naechstes.zeit, jetzt)} · ${formatiereCountdown(naechstes.zeit, jetzt)}`;

  el.listSection.hidden = false;
  el.list.innerHTML = '';
  for (const ereignis of kommendeEreignisse.slice(0, MAX_ANGEZEIGTE_EREIGNISSE)) {
    const li = document.createElement('li');

    const badge = document.createElement('span');
    badge.className = `tide-list__badge tide-list__badge--${ereignis.typ.toLowerCase()}`;
    badge.textContent = ereignis.typ;

    const datum = document.createElement('span');
    datum.className = 'tide-list__datum';
    datum.textContent = `${ereignis.typ === 'HW' ? 'Hochwasser' : 'Niedrigwasser'} · ${formatiereEreignisDatum(ereignis.zeit, jetzt)}`;

    const countdown = document.createElement('span');
    countdown.className = 'tide-list__countdown';
    countdown.textContent = formatiereCountdown(ereignis.zeit, jetzt);

    li.append(badge, datum, countdown);
    el.list.appendChild(li);
  }
}

function waehleStation(label) {
  ausgewaehlteStation = label;
  el.input.value = label;
  verstecke(el.results);
  try {
    localStorage.setItem(STORAGE_KEY_STATION, label);
  } catch {
    // ignorieren, wenn localStorage nicht verfügbar ist
  }
  renderGezeiten(label);
}

function normalisiere(text) {
  return text.toLocaleLowerCase('de-DE');
}

function zeigeSuchergebnisse(suchbegriff) {
  const begriff = normalisiere(suchbegriff.trim());
  el.results.innerHTML = '';
  if (begriff.length === 0) {
    verstecke(el.results);
    return;
  }
  const treffer = Array.from(stationen.keys())
    .filter((label) => normalisiere(label).includes(begriff))
    .sort((a, b) => a.localeCompare(b, 'de-DE'))
    .slice(0, 8);

  if (treffer.length === 0) {
    verstecke(el.results);
    return;
  }
  for (const label of treffer) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => waehleStation(label));
    li.appendChild(button);
    el.results.appendChild(li);
  }
  el.results.hidden = false;
}

function initEreignisListener() {
  el.input.addEventListener('input', (e) => zeigeSuchergebnisse(e.target.value));
  el.input.addEventListener('focus', (e) => {
    if (e.target.value.trim().length > 0) zeigeSuchergebnisse(e.target.value);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.station-suche')) verstecke(el.results);
  });
}

async function init() {
  initEreignisListener();

  const cache = ladeCache();
  if (cache) {
    stationen = cache.stationen;
    letzteAktualisierung = cache.zeitpunkt;
    aktualisiereFussnote();
  }

  let gespeicherteStation = null;
  try {
    gespeicherteStation = localStorage.getItem(STORAGE_KEY_STATION);
  } catch {
    // ignorieren
  }

  await aktualisiereDaten();

  if (gespeicherteStation && stationen.has(gespeicherteStation)) {
    waehleStation(gespeicherteStation);
  }

  setInterval(() => {
    if (ausgewaehlteStation) renderGezeiten(ausgewaehlteStation);
  }, COUNTDOWN_TICK_MS);

  setInterval(() => aktualisiereDaten(), AUTO_REFRESH_MS);
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker Registrierung fehlgeschlagen:', err));
  });
}
