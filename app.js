// Lädt Gezeitenvorhersagen direkt vom BSH (Bundesamt für Seeschifffahrt und
// Hydrographie) — öffentlich, kostenlos, ohne Schlüssel nutzbar (CC BY 4.0).
const BSH_URL =
  'https://gdi.bsh.de/ldproxy/rest/services/WaterLevelForecast/collections/waterlevelforecastdata/items?lang=en&f=json&limit=200';

const FETCH_TIMEOUT_MS = 10000;
const AUTO_REFRESH_MS = 10 * 60 * 1000; // BSH aktualisiert die Vorhersage nicht minütlich
const TICK_MS = 30 * 1000;
const ZEITRAUM_TAGE = { '3tage': 2, '1woche': 6 }; // Kalendertage NACH heute (3 bzw. 7 Tage insgesamt inkl. heute)

const STORAGE_KEY_STATION = 'gezeiten:letzteStation';
const STORAGE_KEY_CACHE = 'gezeiten:cache';
const STORAGE_KEY_FAVORITEN = 'gezeiten:favoriten';
const STORAGE_KEY_TFG = 'gezeiten:tiefgang';

const BRUNSBUETTEL_LABEL = 'Brunsbüttel, Elbe, Ost';
const PNP_REFERENZ_CM = 450;

const el = {
  input: document.getElementById('station-input'),
  results: document.getElementById('station-results'),
  statusBanner: document.getElementById('status-banner'),
  emptyState: document.getElementById('empty-state'),
  tideNow: document.getElementById('tide-now'),
  directionIcon: document.getElementById('tide-direction-icon'),
  directionText: document.getElementById('tide-direction-text'),
  directionTime: document.getElementById('tide-direction-time'),
  steuerungKarte: document.getElementById('steuerung-karte'),
  favoritToggle: document.getElementById('favorit-toggle'),
  favoritToggleIcon: document.querySelector('#favorit-toggle .favorit-toggle__icon'),
  favoritToggleText: document.querySelector('#favorit-toggle .favorit-toggle__text'),
  zeitraumButtons: document.querySelectorAll('.zeitraum-btn'),
  listSection: document.getElementById('tide-list-section'),
  listHinweis: document.getElementById('tide-list-hinweis'),
  listContainer: document.getElementById('tide-list-container'),
  updatedAt: document.getElementById('updated-at'),
  zeitraumDialog: document.getElementById('zeitraum-dialog'),
  zeitraumForm: document.getElementById('zeitraum-form'),
  zeitraumVon: document.getElementById('zeitraum-von'),
  zeitraumBis: document.getElementById('zeitraum-bis'),
  zeitraumFehler: document.getElementById('zeitraum-dialog-fehler'),
  zeitraumAbbrechen: document.getElementById('zeitraum-abbrechen'),
  tabButtons: document.querySelectorAll('.tab-bar__btn'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  favoritenListe: document.getElementById('favoriten-liste'),
  favoritenEmptyState: document.getElementById('favoriten-empty-state'),
  favoritenDialog: document.getElementById('favoriten-dialog'),
  favoritenDialogTitel: document.getElementById('favoriten-dialog-titel'),
  favoritenDialogWasserstand: document.getElementById('favoriten-dialog-wasserstand'),
  favoritenDialogEntfernen: document.getElementById('favoriten-dialog-entfernen'),
  favoritenDialogListe: document.getElementById('favoriten-dialog-liste'),
  favoritenDialogSchliessen: document.getElementById('favoriten-dialog-schliessen'),
  brunsbuettelTitel: document.getElementById('brunsbuettel-titel'),
  brunsbuettelMhw: document.getElementById('brunsbuettel-mhw'),
  brunsbuettelMnw: document.getElementById('brunsbuettel-mnw'),
  brunsbuettelTfgInput: document.getElementById('brunsbuettel-tfg-input'),
  brunsbuettelTfgFehler: document.getElementById('brunsbuettel-tfg-fehler'),
  brunsbuettelChartContainer: document.getElementById('brunsbuettel-chart-container'),
};

/** @type {Map<string, {ereignisse: {typ: 'HW'|'NW', zeit: Date, wert: number|null, delta: string|null}[], kurve: {zeit: Date, wert: number, quelle: 'messung'|'vorhersage'}[], mhw: number|null, mnw: number|null}>} */
let stationen = new Map();
let ausgewaehlteStation = null;
let letzteAktualisierung = null;

let aktiverTab = 'suche';
let aktiverZeitraumTyp = 'heute'; // 'heute' | '3tage' | '1woche' | 'eigen'
let eigenerZeitraum = null; // {von: Date, bis: Date} | null — für Dialog-Vorbefüllung beim erneuten Öffnen
let favoriten = new Set();
let favoritenDialogLabel = null;

// ---------- Daten laden (BSH) ----------

function parseBshZeitstempel(roh) {
  // BSH liefert "2026-07-02 13:54:00+02:00" — Leerzeichen statt "T" vor der Uhrzeit.
  return new Date(roh.replace(' ', 'T'));
}

function ermittleWertUndDelta(e) {
  // Prioritätskette: naheliegende Wettervorhersage > Modell-Ensemble-Vorhersage (r0) > reine
  // astronomische Basisvorhersage (dann ohne Delta, da sie selbst die Referenz ist).
  // mos_forecast_r1..r5 existieren in der Rohantwort, werden hier bewusst nicht genutzt.
  if (e.forecast_value != null) {
    const wert = Number(e.forecast_value);
    if (Number.isFinite(wert)) return { wert, delta: e.forecast_deviation ?? null };
  }
  if (e.mos_forecast_r0_value != null) {
    const wert = Number(e.mos_forecast_r0_value);
    if (Number.isFinite(wert)) return { wert, delta: e.mos_forecast_r0_deviation ?? null };
  }
  if (e.tidal_prediction_value != null) {
    const wert = Number(e.tidal_prediction_value);
    if (Number.isFinite(wert)) return { wert, delta: null };
  }
  return { wert: null, delta: null };
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
      .map((e) => ({ typ: e.event, zeit: parseBshZeitstempel(e.event_timestamp), ...ermittleWertUndDelta(e) }))
      .sort((a, b) => a.zeit.getTime() - b.zeit.getTime());
    const kurve = (feature.properties?.curve || [])
      .map((p) => {
        const zeit = parseBshZeitstempel(p.timestamp);
        if (p.measurement != null) return { zeit, wert: Number(p.measurement), quelle: 'messung' };
        if (p.automated_curve_forecast != null) return { zeit, wert: Number(p.automated_curve_forecast), quelle: 'vorhersage' };
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.zeit.getTime() - b.zeit.getTime());
    const mhw = feature.properties?.mean_high_water != null ? Number(feature.properties.mean_high_water) : null;
    const mnw = feature.properties?.mean_low_water != null ? Number(feature.properties.mean_low_water) : null;
    if (ereignisse.length > 0) neueStationen.set(label, { ereignisse, kurve, mhw, mnw });
  }
  if (neueStationen.size === 0) {
    throw new Error('BSH-Antwort enthielt keine verwertbaren Stationsdaten.');
  }
  return neueStationen;
}

// ---------- Speicher/Storage ----------

function stationenZuJson(map) {
  return JSON.stringify(
    Array.from(map.entries()).map(([label, daten]) => [
      label,
      daten.ereignisse.map((e) => ({ typ: e.typ, zeit: e.zeit.toISOString(), wert: e.wert, delta: e.delta })),
      daten.kurve.map((p) => ({ wert: p.wert, quelle: p.quelle, zeit: p.zeit.toISOString() })),
      { mhw: daten.mhw ?? null, mnw: daten.mnw ?? null },
    ]),
  );
}

function stationenAusJson(text) {
  const rows = JSON.parse(text);
  return new Map(
    rows.map(([label, ereignisse, kurve, meta]) => [
      label,
      {
        ereignisse: ereignisse.map((e) => ({
          typ: e.typ,
          zeit: new Date(e.zeit),
          wert: e.wert ?? null,
          delta: e.delta ?? null,
        })),
        kurve: (kurve || []).map((p) => ({ wert: p.wert, quelle: p.quelle, zeit: new Date(p.zeit) })),
        mhw: meta?.mhw ?? null,
        mnw: meta?.mnw ?? null,
      },
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

function ladeFavoriten() {
  try {
    const text = localStorage.getItem(STORAGE_KEY_FAVORITEN);
    if (!text) return new Set();
    return new Set(JSON.parse(text));
  } catch {
    return new Set();
  }
}

function speichereFavoriten(set) {
  try {
    localStorage.setItem(STORAGE_KEY_FAVORITEN, JSON.stringify(Array.from(set)));
  } catch {
    // localStorage kann z. B. im privaten Modus fehlschlagen — dann eben ohne Persistenz.
  }
}

function ladeTiefgang() {
  try {
    const text = localStorage.getItem(STORAGE_KEY_TFG);
    if (!text) return null;
    const wert = Number(text);
    return Number.isFinite(wert) ? wert : null;
  } catch {
    return null;
  }
}

function speichereTiefgang(wert) {
  try {
    localStorage.setItem(STORAGE_KEY_TFG, String(wert));
  } catch {
    // localStorage kann z. B. im privaten Modus fehlschlagen — dann eben ohne Persistenz.
  }
}

// ---------- Allgemeine Helfer ----------

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

function istGleicherTag(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ---------- Formatierung ----------

function formatiereUhrzeitMitDatum(datum) {
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(datum);
}

function formatiereKompakt(zeit) {
  const tag = new Intl.DateTimeFormat('de-DE', { day: '2-digit' }).format(zeit);
  const uhrzeit = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(zeit);
  return `${tag}. / ${uhrzeit}`;
}

function formatiereTagesTitel(zeit, jetzt) {
  const morgen = new Date(jetzt);
  morgen.setDate(morgen.getDate() + 1);
  if (istGleicherTag(zeit, jetzt)) return 'Heute';
  if (istGleicherTag(zeit, morgen)) return 'Morgen';
  return new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(zeit);
}

function formatiereMeter(cmWert) {
  return (cmWert / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' m';
}

function formatiereWertUndDelta(ereignis) {
  if (ereignis.wert == null || !Number.isFinite(ereignis.wert)) return null;
  const meter = formatiereMeter(ereignis.wert);
  return ereignis.delta ? `${meter} (${ereignis.delta})` : meter;
}

function aktualisiereFussnote() {
  if (!letzteAktualisierung) return;
  el.updatedAt.textContent = `Zuletzt aktualisiert: ${formatiereUhrzeitMitDatum(letzteAktualisierung)}`;
}

// ---------- Zeitraum-Auswahl (1.3.2 / 1.3.3) ----------

function startDesTages(datum) {
  const d = new Date(datum);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endeDesTages(datum) {
  const d = new Date(datum);
  d.setHours(23, 59, 59, 999);
  return d;
}

function berechneZeitraum(typ, jetzt, eigenerZeitraumWert) {
  const von = startDesTages(jetzt);
  if (typ === 'eigen' && eigenerZeitraumWert) {
    return { von: startDesTages(eigenerZeitraumWert.von), bis: endeDesTages(eigenerZeitraumWert.bis) };
  }
  const zusatzTage = ZEITRAUM_TAGE[typ] || 0;
  const bis = endeDesTages(new Date(von.getTime() + zusatzTage * 86400000));
  return { von, bis };
}

function filtereEreignisseImZeitraum(ereignisse, zeitraum) {
  return ereignisse.filter(
    (e) => e.zeit.getTime() >= zeitraum.von.getTime() && e.zeit.getTime() <= zeitraum.bis.getTime(),
  );
}

function gruppiereNachTag(ereignisse, jetzt) {
  const gruppen = [];
  let aktuelleGruppe = null;
  for (const ereignis of ereignisse) {
    const schluessel = ereignis.zeit.toDateString();
    if (!aktuelleGruppe || aktuelleGruppe.schluessel !== schluessel) {
      aktuelleGruppe = { schluessel, titel: formatiereTagesTitel(ereignis.zeit, jetzt), ereignisse: [] };
      gruppen.push(aktuelleGruppe);
    }
    aktuelleGruppe.ereignisse.push(ereignis);
  }
  return gruppen;
}

function ermittleAbdeckungsHinweis(ereignisse, zeitraum) {
  if (ereignisse.length === 0) return null;
  const ersteZeit = ereignisse[0].zeit.getTime();
  const letzteZeit = ereignisse[ereignisse.length - 1].zeit.getTime();
  if (ersteZeit > zeitraum.von.getTime() || letzteZeit < zeitraum.bis.getTime()) {
    return 'Die BSH-Vorhersage deckt den gewählten Zeitraum eventuell nicht vollständig ab.';
  }
  return null;
}

function ermittleDatengrenzen(label) {
  const daten = stationen.get(label);
  if (!daten) return null;
  const zeiten = [];
  for (const e of daten.ereignisse) zeiten.push(e.zeit.getTime());
  for (const p of daten.kurve) zeiten.push(p.zeit.getTime());
  if (zeiten.length === 0) return null;
  return { spaeteste: new Date(Math.max(...zeiten)) };
}

function zuDateInputWert(datum) {
  const jahr = datum.getFullYear();
  const monat = String(datum.getMonth() + 1).padStart(2, '0');
  const tag = String(datum.getDate()).padStart(2, '0');
  return `${jahr}-${monat}-${tag}`;
}

function ausDateInputWert(text) {
  const [jahr, monat, tag] = text.split('-').map(Number);
  return new Date(jahr, monat - 1, tag);
}

function oeffneZeitraumDialog() {
  const heute = startDesTages(new Date());
  el.zeitraumVon.min = zuDateInputWert(heute);
  el.zeitraumBis.min = zuDateInputWert(heute);
  const grenzen = ermittleDatengrenzen(ausgewaehlteStation);
  if (grenzen) {
    el.zeitraumVon.max = zuDateInputWert(grenzen.spaeteste);
    el.zeitraumBis.max = zuDateInputWert(grenzen.spaeteste);
  } else {
    el.zeitraumVon.removeAttribute('max');
    el.zeitraumBis.removeAttribute('max');
  }
  const basis = eigenerZeitraum ?? { von: new Date(), bis: new Date() };
  el.zeitraumVon.value = zuDateInputWert(basis.von);
  el.zeitraumBis.value = zuDateInputWert(basis.bis);
  verstecke(el.zeitraumFehler);
  el.zeitraumDialog.showModal();
}

function schliesseZeitraumDialogAbbrechen() {
  el.zeitraumDialog.close();
}

function zeigeZeitraumFehler(text) {
  el.zeitraumFehler.hidden = false;
  el.zeitraumFehler.textContent = text;
}

function handleZeitraumAnwenden(e) {
  e.preventDefault();
  if (!el.zeitraumVon.value || !el.zeitraumBis.value) {
    zeigeZeitraumFehler('Bitte Start- und Enddatum auswählen.');
    return;
  }
  const von = ausDateInputWert(el.zeitraumVon.value);
  const bis = ausDateInputWert(el.zeitraumBis.value);
  if (bis.getTime() < von.getTime()) {
    zeigeZeitraumFehler('Das Enddatum darf nicht vor dem Startdatum liegen.');
    return;
  }
  const grenzen = ermittleDatengrenzen(ausgewaehlteStation);
  if (grenzen && von.getTime() > grenzen.spaeteste.getTime()) {
    zeigeZeitraumFehler('Für diesen Zeitraum liegt noch keine BSH-Vorhersage vor. Bitte ein früheres Datum wählen.');
    return;
  }
  eigenerZeitraum = { von, bis };
  aktiverZeitraumTyp = 'eigen';
  el.zeitraumDialog.close();
  aktualisiereZeitraumButtons();
  renderSucheTab();
}

function aktualisiereZeitraumButtons() {
  el.zeitraumButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.zeitraum === aktiverZeitraumTyp));
  });
}

function initZeitraumSteuerung() {
  el.zeitraumButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const typ = btn.dataset.zeitraum;
      if (typ === 'eigen') {
        oeffneZeitraumDialog();
        return;
      }
      aktiverZeitraumTyp = typ;
      aktualisiereZeitraumButtons();
      renderSucheTab();
    });
  });
}

function initZeitraumDialog() {
  el.zeitraumForm.addEventListener('submit', handleZeitraumAnwenden);
  el.zeitraumAbbrechen.addEventListener('click', schliesseZeitraumDialogAbbrechen);
}

// ---------- Tab-Navigation ----------

function wechsleTab(tabName) {
  aktiverTab = tabName;
  el.tabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  });
  el.tabButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.tab === tabName));
  });
  verstecke(el.results);
  if (el.zeitraumDialog.open) el.zeitraumDialog.close();
  if (el.favoritenDialog.open) el.favoritenDialog.close();
  if (tabName === 'brunsbuettel') renderBrunsbuettelTab();
}

function initTabNavigation() {
  el.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => wechsleTab(btn.dataset.tab));
  });
}

// ---------- Favorit-Steuerung (1.3.1) ----------

function istFavorit(label) {
  return favoriten.has(label);
}

function toggleFavorit(label) {
  if (!label) return;
  if (favoriten.has(label)) {
    favoriten.delete(label);
  } else {
    favoriten.add(label);
  }
  speichereFavoriten(favoriten);
  aktualisiereFavoritToggle();
  renderFavoritenTab();
}

function aktualisiereFavoritToggle() {
  const aktiv = istFavorit(ausgewaehlteStation);
  el.favoritToggle.setAttribute('aria-pressed', String(aktiv));
  el.favoritToggle.classList.toggle('favorit-toggle--aktiv', aktiv);
  el.favoritToggleIcon.textContent = aktiv ? '★' : '☆';
  el.favoritToggleText.textContent = aktiv ? 'Favorit gespeichert' : 'Als Favorit speichern';
}

function initFavoritToggle() {
  el.favoritToggle.addEventListener('click', () => toggleFavorit(ausgewaehlteStation));
}

// ---------- Gemeinsame Listen-Bausteine (Tab 1 + Tab 2) ----------

function baueEreignisEintrag(ereignis, { vergangen = false } = {}) {
  const li = document.createElement('li');
  li.className = 'tide-list__eintrag';
  if (vergangen) li.classList.add('tide-list__eintrag--vergangen');

  const badge = document.createElement('span');
  badge.className = `tide-list__badge tide-list__badge--${ereignis.typ.toLowerCase()}`;
  badge.textContent = ereignis.typ;

  const zeit = document.createElement('span');
  zeit.className = 'tide-list__zeit';
  zeit.textContent = formatiereKompakt(ereignis.zeit);

  li.append(badge, zeit);

  const wertText = formatiereWertUndDelta(ereignis);
  if (wertText) {
    const wert = document.createElement('span');
    wert.className = 'tide-list__wert';
    wert.textContent = wertText;
    li.appendChild(wert);
  }
  return li;
}

function baueLeereListenHinweis(text) {
  const p = document.createElement('p');
  p.className = 'empty-state';
  p.textContent = text;
  return p;
}

function baueFlacheListe(ereignisse, jetzt) {
  const liste = document.createElement('ul');
  liste.className = 'tide-list';
  for (const ereignis of ereignisse) {
    liste.appendChild(baueEreignisEintrag(ereignis, { vergangen: ereignis.zeit.getTime() < jetzt.getTime() }));
  }
  return liste;
}

function baueGruppierteListe(ereignisse, jetzt) {
  const container = document.createElement('div');
  for (const gruppe of gruppiereNachTag(ereignisse, jetzt)) {
    const block = document.createElement('div');
    block.className = 'tide-tag-gruppe';
    const titel = document.createElement('h3');
    titel.className = 'tide-tag-gruppe__titel';
    titel.textContent = gruppe.titel;
    block.append(titel, baueFlacheListe(gruppe.ereignisse, jetzt));
    container.appendChild(block);
  }
  return container;
}

function naechstesEreignis(ereignisse, jetzt) {
  return ereignisse.find((e) => e.zeit.getTime() > jetzt.getTime());
}

// ---------- Tab 1: Suche ----------

function zeigeLeerenZustandSuche() {
  el.emptyState.hidden = false;
  verstecke(el.tideNow);
  verstecke(el.steuerungKarte);
  verstecke(el.listSection);
}

function renderSchnellinfo(ereignisse, jetzt) {
  const kommendes = naechstesEreignis(ereignisse, jetzt);
  if (!kommendes) {
    verstecke(el.tideNow);
    return;
  }
  el.tideNow.hidden = false;
  const steigend = kommendes.typ === 'HW';
  el.tideNow.classList.toggle('tide-now--steigend', steigend);
  el.tideNow.classList.toggle('tide-now--fallend', !steigend);
  el.directionIcon.textContent = steigend ? '⬆️' : '⬇️';
  el.directionText.textContent = `Nächstes ${kommendes.typ}`;
  const wertText = formatiereWertUndDelta(kommendes);
  el.directionTime.textContent = wertText
    ? `${formatiereKompakt(kommendes.zeit)}  ${wertText}`
    : formatiereKompakt(kommendes.zeit);
}

function ermittleLetztesEreignis(ereignisse, jetzt) {
  let letztes = null;
  for (const ereignis of ereignisse) {
    if (ereignis.zeit.getTime() >= jetzt.getTime()) break;
    letztes = ereignis;
  }
  return letztes;
}

function ermittleRollierendesFenster(ereignisse, jetzt) {
  const ende = jetzt.getTime() + 24 * 3600000;
  return ereignisse.filter((e) => e.zeit.getTime() >= jetzt.getTime() && e.zeit.getTime() <= ende);
}

function renderHeuteListe(ereignisse, jetzt) {
  el.listContainer.innerHTML = '';
  el.listSection.hidden = false;
  const anker = ermittleLetztesEreignis(ereignisse, jetzt);
  const fenster = ermittleRollierendesFenster(ereignisse, jetzt);
  const kombiniert = anker ? [anker, ...fenster] : fenster;
  if (kombiniert.length === 0) {
    el.listContainer.appendChild(baueLeereListenHinweis('Für diesen Zeitraum liegen keine Gezeiten in der BSH-Vorhersage vor.'));
    return;
  }
  el.listContainer.appendChild(baueFlacheListe(kombiniert, jetzt));
}

function renderGezeitenListe(gefiltert, zeitraum, jetzt) {
  el.listContainer.innerHTML = '';
  el.listSection.hidden = false;

  if (gefiltert.length === 0) {
    el.listContainer.appendChild(baueLeereListenHinweis('Für diesen Zeitraum liegen keine Gezeiten in der BSH-Vorhersage vor.'));
    return;
  }

  const mehrereTage = !istGleicherTag(zeitraum.von, zeitraum.bis);

  if (!mehrereTage) {
    el.listContainer.appendChild(baueFlacheListe(gefiltert, jetzt));
    return;
  }

  el.listContainer.appendChild(baueGruppierteListe(gefiltert, jetzt));
}

function renderSucheTab() {
  if (!ausgewaehlteStation) {
    zeigeLeerenZustandSuche();
    return;
  }
  const ereignisse = stationen.get(ausgewaehlteStation)?.ereignisse || [];
  const jetzt = new Date();

  verstecke(el.emptyState);
  el.steuerungKarte.hidden = false;
  aktualisiereFavoritToggle();

  renderSchnellinfo(ereignisse, jetzt);

  if (aktiverZeitraumTyp === 'heute') {
    renderHeuteListe(ereignisse, jetzt);
    el.listHinweis.hidden = true;
    return;
  }

  const zeitraum = berechneZeitraum(aktiverZeitraumTyp, jetzt, eigenerZeitraum);
  const gefiltert = filtereEreignisseImZeitraum(ereignisse, zeitraum);
  renderGezeitenListe(gefiltert, zeitraum, jetzt);

  const hinweis = ermittleAbdeckungsHinweis(ereignisse, zeitraum);
  el.listHinweis.hidden = !hinweis;
  el.listHinweis.textContent = hinweis || '';
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
  renderSucheTab();
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

// ---------- Tab 2: Favoriten ----------

function ermittleAktuellenWasserstand(kurve, jetzt) {
  if (!kurve || kurve.length === 0) return null;
  let naechster = kurve[0];
  let kleinsteDifferenz = Math.abs(naechster.zeit.getTime() - jetzt.getTime());
  for (const punkt of kurve) {
    const differenz = Math.abs(punkt.zeit.getTime() - jetzt.getTime());
    if (differenz < kleinsteDifferenz) {
      kleinsteDifferenz = differenz;
      naechster = punkt;
    }
  }
  return naechster;
}

function renderWasserstandFuerKarte(label) {
  const div = document.createElement('div');
  const daten = stationen.get(label);
  const punkt = daten ? ermittleAktuellenWasserstand(daten.kurve, new Date()) : null;
  if (!punkt) {
    div.className = 'favoriten-karte__wasserstand favoriten-karte__wasserstand--platzhalter';
    div.textContent = '—';
    return div;
  }
  const quelleText = punkt.quelle === 'messung' ? 'gemessen' : 'Vorhersage';
  div.className = 'favoriten-karte__wasserstand';
  div.textContent = `🌊 ${formatiereMeter(punkt.wert)} · ${quelleText}`;
  return div;
}

function baueFavoritenKarteKompakt(label, jetzt) {
  const li = document.createElement('li');
  li.className = 'karte favoriten-karte favoriten-karte--kompakt';
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.addEventListener('click', () => oeffneFavoritenDialog(label));
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      oeffneFavoritenDialog(label);
    }
  });

  const kopf = document.createElement('div');
  kopf.className = 'favoriten-karte__kopf';
  const titel = document.createElement('span');
  titel.className = 'favoriten-karte__titel';
  titel.textContent = label;
  const entfernen = document.createElement('button');
  entfernen.type = 'button';
  entfernen.className = 'favoriten-karte__entfernen';
  entfernen.setAttribute('aria-label', `${label} aus Favoriten entfernen`);
  entfernen.textContent = '★';
  entfernen.addEventListener('click', (e) => {
    e.stopPropagation(); // sonst würde der Klick auch den Detail-Dialog öffnen
    toggleFavorit(label);
  });
  kopf.append(titel, entfernen);
  li.appendChild(kopf);

  const ereignisse = stationen.get(label)?.ereignisse || [];
  const naechstes = naechstesEreignis(ereignisse, jetzt);
  if (naechstes) {
    const liste = document.createElement('ul');
    liste.className = 'tide-list';
    liste.appendChild(baueEreignisEintrag(naechstes));
    li.appendChild(liste);
  } else {
    li.appendChild(baueLeereListenHinweis('Keine kommenden Gezeiten verfügbar.'));
  }
  return li;
}

function renderFavoritenTab() {
  el.favoritenListe.innerHTML = '';
  if (favoriten.size === 0) {
    el.favoritenEmptyState.hidden = false;
    el.favoritenListe.hidden = true;
    return;
  }
  el.favoritenEmptyState.hidden = true;
  el.favoritenListe.hidden = false;
  const jetzt = new Date();
  const sortiert = Array.from(favoriten).sort((a, b) => a.localeCompare(b, 'de-DE'));
  for (const label of sortiert) {
    el.favoritenListe.appendChild(baueFavoritenKarteKompakt(label, jetzt));
  }
}

function oeffneFavoritenDialog(label) {
  favoritenDialogLabel = label;
  el.favoritenDialogTitel.textContent = label;
  el.favoritenDialogWasserstand.innerHTML = '';
  el.favoritenDialogWasserstand.appendChild(renderWasserstandFuerKarte(label));

  const jetzt = new Date();
  const ereignisse = stationen.get(label)?.ereignisse || [];
  const zeitraum = { von: jetzt, bis: new Date(jetzt.getTime() + 5 * 86400000) };
  const gefiltert = filtereEreignisseImZeitraum(ereignisse, zeitraum);
  el.favoritenDialogListe.innerHTML = '';
  el.favoritenDialogListe.appendChild(
    gefiltert.length > 0
      ? baueGruppierteListe(gefiltert, jetzt)
      : baueLeereListenHinweis('Für die nächsten 5 Tage liegen keine Gezeiten in der BSH-Vorhersage vor.'),
  );
  el.favoritenDialog.showModal();
}

function schliesseFavoritenDialog() {
  el.favoritenDialog.close();
}

function initFavoritenDialog() {
  el.favoritenDialogSchliessen.addEventListener('click', schliesseFavoritenDialog);
  el.favoritenDialogEntfernen.addEventListener('click', () => {
    if (favoritenDialogLabel) toggleFavorit(favoritenDialogLabel);
    schliesseFavoritenDialog();
  });
}

// ---------- Tab 3: Brunsbüttel ----------

function istGueltigerTiefgang(wert) {
  return Number.isFinite(wert) && wert >= 0.5 && wert <= 3.5;
}

function handleTiefgangEingabe() {
  const roh = el.brunsbuettelTfgInput.value;
  if (roh === '') {
    verstecke(el.brunsbuettelTfgFehler);
    return;
  }
  const wert = Number(roh);
  if (!istGueltigerTiefgang(wert)) {
    el.brunsbuettelTfgFehler.hidden = false;
    el.brunsbuettelTfgFehler.textContent = 'Tiefgang muss zwischen 0,50 m und 3,50 m liegen.';
    return;
  }
  verstecke(el.brunsbuettelTfgFehler);
  const gerundet = Math.round(wert * 100) / 100;
  el.brunsbuettelTfgInput.value = gerundet.toFixed(2);
  speichereTiefgang(gerundet);
}

function initBrunsbuettelTfg() {
  const gespeichert = ladeTiefgang();
  if (gespeichert != null) el.brunsbuettelTfgInput.value = gespeichert.toFixed(2);
  el.brunsbuettelTfgInput.addEventListener('change', handleTiefgangEingabe);
}

function berechneChartFenster(jetzt) {
  const von = startDesTages(jetzt);
  const bis = endeDesTages(new Date(von.getTime() + 86400000));
  return { von, bis };
}

function berechneChartSkala(punkte) {
  const werte = punkte.map((p) => p.wert);
  let min = werte.length ? Math.min(...werte) : PNP_REFERENZ_CM - 100;
  let max = werte.length ? Math.max(...werte) : PNP_REFERENZ_CM + 100;
  min = Math.min(min, PNP_REFERENZ_CM - 20);
  max = Math.max(max, PNP_REFERENZ_CM + 20);
  const puffer = (max - min) * 0.1 || 10;
  return { min: min - puffer, max: max + puffer };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function baueWasserstandsChart(punkte, von, bis) {
  const breite = 640;
  const hoehe = 240;
  const padLinks = 12;
  const padRechts = 44;
  const padOben = 10;
  const padUnten = 28;
  const skala = berechneChartSkala(punkte);
  const x = (zeit) =>
    padLinks + ((zeit.getTime() - von.getTime()) / (bis.getTime() - von.getTime())) * (breite - padLinks - padRechts);
  const y = (wert) => padOben + (1 - (wert - skala.min) / (skala.max - skala.min)) * (hoehe - padOben - padUnten);

  const svg = svgEl('svg', { viewBox: `0 0 ${breite} ${hoehe}`, role: 'img', 'aria-label': 'Wasserstandskurve Brunsbüttel' });

  svg.appendChild(
    svgEl('line', {
      x1: padLinks,
      x2: breite - padRechts,
      y1: y(PNP_REFERENZ_CM),
      y2: y(PNP_REFERENZ_CM),
      class: 'chart-referenzlinie',
    }),
  );
  const refLabel = svgEl('text', { x: breite - padRechts + 4, y: y(PNP_REFERENZ_CM) + 3, class: 'chart-achse-text' });
  refLabel.textContent = `PNP ${PNP_REFERENZ_CM}`;
  svg.appendChild(refLabel);

  const refY = y(PNP_REFERENZ_CM);
  for (const wert of [skala.min, (skala.min + skala.max) / 2, skala.max]) {
    if (Math.abs(y(wert) - refY) < 10) continue; // Kollision mit dem PNP-Referenzlabel vermeiden
    const t = svgEl('text', { x: breite - padRechts + 4, y: y(wert) + 3, class: 'chart-achse-text' });
    t.textContent = String(Math.round(wert));
    svg.appendChild(t);
  }

  for (let ts = von.getTime(); ts <= bis.getTime(); ts += 6 * 3600000) {
    const zeit = new Date(ts);
    const t = svgEl('text', { x: x(zeit), y: hoehe - 4, class: 'chart-achse-text', 'text-anchor': 'middle' });
    t.textContent = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(zeit);
    svg.appendChild(t);
  }

  const baueLinie = (serie, klasse) => {
    if (serie.length === 0) return null;
    const punkteStr = serie.map((p) => `${x(p.zeit)},${y(p.wert)}`).join(' ');
    return svgEl('polyline', { points: punkteStr, class: klasse, fill: 'none' });
  };
  const messung = punkte.filter((p) => p.quelle === 'messung');
  const vorhersage = punkte.filter((p) => p.quelle === 'vorhersage');
  const lVorhersage = baueLinie(vorhersage, 'chart-linie chart-linie--vorhersage');
  const lMessung = baueLinie(messung, 'chart-linie chart-linie--messung');
  if (lVorhersage) svg.appendChild(lVorhersage);
  if (lMessung) svg.appendChild(lMessung);

  return svg;
}

function renderBrunsbuettelChart(jetzt) {
  el.brunsbuettelChartContainer.innerHTML = '';
  const daten = stationen.get(BRUNSBUETTEL_LABEL);
  if (!daten || daten.kurve.length === 0) {
    el.brunsbuettelChartContainer.appendChild(baueLeereListenHinweis('Für Brunsbüttel liegen aktuell keine Kurvendaten vor.'));
    return;
  }
  const { von, bis } = berechneChartFenster(jetzt);
  const punkte = daten.kurve.filter((p) => p.zeit.getTime() >= von.getTime() && p.zeit.getTime() <= bis.getTime());
  if (punkte.length === 0) {
    el.brunsbuettelChartContainer.appendChild(baueLeereListenHinweis('Für heute/morgen liegen keine Kurvendaten vor.'));
    return;
  }
  el.brunsbuettelChartContainer.appendChild(baueWasserstandsChart(punkte, von, bis));
}

function renderBrunsbuettelTab() {
  const daten = stationen.get(BRUNSBUETTEL_LABEL);
  el.brunsbuettelTitel.textContent = BRUNSBUETTEL_LABEL;
  el.brunsbuettelMhw.textContent = daten?.mhw != null ? formatiereMeter(daten.mhw) : '—';
  el.brunsbuettelMnw.textContent = daten?.mnw != null ? formatiereMeter(daten.mnw) : '—';
  renderBrunsbuettelChart(new Date());
}

// ---------- Daten-Refresh ----------

async function aktualisiereDaten({ zeigeFehler = false } = {}) {
  try {
    const neueStationen = await ladeVonBsh();
    stationen = neueStationen;
    letzteAktualisierung = new Date();
    speichereCache(stationen, letzteAktualisierung);
    verstecke(el.statusBanner);
    aktualisiereFussnote();
    if (ausgewaehlteStation) renderSucheTab();
    renderFavoritenTab();
    if (aktiverTab === 'brunsbuettel') renderBrunsbuettelTab();
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

// ---------- Init ----------

async function init() {
  initEreignisListener();
  initTabNavigation();
  initFavoritToggle();
  initZeitraumSteuerung();
  initZeitraumDialog();
  initFavoritenDialog();
  initBrunsbuettelTfg();

  favoriten = ladeFavoriten();

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

  renderFavoritenTab();

  await aktualisiereDaten();

  if (gespeicherteStation && stationen.has(gespeicherteStation)) {
    waehleStation(gespeicherteStation);
  }

  setInterval(() => {
    if (ausgewaehlteStation) renderSucheTab();
    renderFavoritenTab();
    if (aktiverTab === 'brunsbuettel') renderBrunsbuettelTab();
  }, TICK_MS);

  setInterval(() => aktualisiereDaten(), AUTO_REFRESH_MS);
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker Registrierung fehlgeschlagen:', err));
  });
}
