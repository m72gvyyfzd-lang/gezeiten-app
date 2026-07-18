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
};

/** @type {Map<string, {typ: 'HW'|'NW', zeit: Date}[]>} */
let stationen = new Map();
let ausgewaehlteStation = null;
let letzteAktualisierung = null;

let aktiverTab = 'suche';
let aktiverZeitraumTyp = 'heute'; // 'heute' | '3tage' | '1woche' | 'eigen'
let eigenerZeitraum = null; // {von: Date, bis: Date} | null — für Dialog-Vorbefüllung beim erneuten Öffnen
let favoriten = new Set();

// ---------- Daten laden (BSH) ----------

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

// ---------- Speicher/Storage ----------

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

// ---------- Gemeinsamer Listeneintrag (Tab 1 + Tab 2) ----------

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
  return li;
}

// ---------- Tab 1: Suche ----------

function zeigeLeerenZustandSuche() {
  el.emptyState.hidden = false;
  verstecke(el.tideNow);
  verstecke(el.steuerungKarte);
  verstecke(el.listSection);
}

function renderSchnellinfo(ereignisse, jetzt) {
  const kommendes = ereignisse.find((e) => e.zeit.getTime() > jetzt.getTime());
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
  el.directionTime.textContent = formatiereKompakt(kommendes.zeit);
}

function renderGezeitenListe(gefiltert, zeitraum, jetzt) {
  el.listContainer.innerHTML = '';
  el.listSection.hidden = false;

  if (gefiltert.length === 0) {
    const hinweis = document.createElement('p');
    hinweis.className = 'empty-state';
    hinweis.textContent = 'Für diesen Zeitraum liegen keine Gezeiten in der BSH-Vorhersage vor.';
    el.listContainer.appendChild(hinweis);
    return;
  }

  const mehrereTage = !istGleicherTag(zeitraum.von, zeitraum.bis);

  if (!mehrereTage) {
    const liste = document.createElement('ul');
    liste.className = 'tide-list';
    for (const ereignis of gefiltert) {
      liste.appendChild(baueEreignisEintrag(ereignis, { vergangen: ereignis.zeit.getTime() < jetzt.getTime() }));
    }
    el.listContainer.appendChild(liste);
    return;
  }

  for (const gruppe of gruppiereNachTag(gefiltert, jetzt)) {
    const block = document.createElement('div');
    block.className = 'tide-tag-gruppe';
    const titel = document.createElement('h3');
    titel.className = 'tide-tag-gruppe__titel';
    titel.textContent = gruppe.titel;
    const liste = document.createElement('ul');
    liste.className = 'tide-list';
    for (const ereignis of gruppe.ereignisse) {
      liste.appendChild(baueEreignisEintrag(ereignis, { vergangen: ereignis.zeit.getTime() < jetzt.getTime() }));
    }
    block.append(titel, liste);
    el.listContainer.appendChild(block);
  }
}

function renderSucheTab() {
  if (!ausgewaehlteStation) {
    zeigeLeerenZustandSuche();
    return;
  }
  const ereignisse = stationen.get(ausgewaehlteStation) || [];
  const jetzt = new Date();

  verstecke(el.emptyState);
  el.steuerungKarte.hidden = false;
  aktualisiereFavoritToggle();

  renderSchnellinfo(ereignisse, jetzt);

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

function ermittleLetzteAnker(ereignisse, jetzt) {
  let hw = null;
  let nw = null;
  for (const ereignis of ereignisse) {
    if (ereignis.zeit.getTime() >= jetzt.getTime()) break;
    if (ereignis.typ === 'HW') hw = ereignis;
    else nw = ereignis;
  }
  return { hw, nw };
}

function ermittleRollierendesFenster(ereignisse, jetzt) {
  const ende = jetzt.getTime() + 24 * 3600000;
  return ereignisse.filter((e) => e.zeit.getTime() >= jetzt.getTime() && e.zeit.getTime() <= ende);
}

function renderWasserstandFuerKarte(_label) {
  // Platzhalter: numerische Wasserstandswerte (cm/m) sind ein separater Folge-Task,
  // sobald die Datenquelle geklärt ist. Struktur so gebaut, dass sie sich ohne
  // Layout-Änderung befüllen lässt.
  const div = document.createElement('div');
  div.className = 'favoriten-karte__wasserstand favoriten-karte__wasserstand--platzhalter';
  div.textContent = '—';
  return div;
}

function baueFavoritenKarte(label, jetzt) {
  const li = document.createElement('li');
  li.className = 'karte favoriten-karte';

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
  entfernen.addEventListener('click', () => toggleFavorit(label));
  kopf.append(titel, entfernen);
  li.appendChild(kopf);

  li.appendChild(renderWasserstandFuerKarte(label));

  const ereignisse = stationen.get(label) || [];
  if (ereignisse.length === 0) {
    const hinweis = document.createElement('p');
    hinweis.className = 'favoriten-karte__hinweis';
    hinweis.textContent = 'Keine Gezeitendaten verfügbar.';
    li.appendChild(hinweis);
    return li;
  }

  const { hw, nw } = ermittleLetzteAnker(ereignisse, jetzt);
  const anker = [hw, nw].filter(Boolean).sort((a, b) => a.zeit.getTime() - b.zeit.getTime());
  const fenster = ermittleRollierendesFenster(ereignisse, jetzt);

  if (anker.length === 0 && fenster.length === 0) {
    const hinweis = document.createElement('p');
    hinweis.className = 'favoriten-karte__hinweis';
    hinweis.textContent = 'Für diese Station liegen aktuell keine Gezeitendaten im relevanten Zeitraum vor.';
    li.appendChild(hinweis);
    return li;
  }

  const liste = document.createElement('ul');
  liste.className = 'tide-list';
  for (const ereignis of anker) {
    liste.appendChild(baueEreignisEintrag(ereignis, { vergangen: true }));
  }
  for (const ereignis of fenster) {
    liste.appendChild(baueEreignisEintrag(ereignis));
  }
  li.appendChild(liste);

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
    el.favoritenListe.appendChild(baueFavoritenKarte(label, jetzt));
  }
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
  }, TICK_MS);

  setInterval(() => aktualisiereDaten(), AUTO_REFRESH_MS);
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker Registrierung fehlgeschlagen:', err));
  });
}
