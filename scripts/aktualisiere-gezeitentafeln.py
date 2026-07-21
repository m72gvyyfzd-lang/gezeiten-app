#!/usr/bin/env python3
"""Spiegelt die astronomischen Gezeitentafeln des BSH (gezeiten.bsh.de) in den
Ordner tides/, damit die App sie von der eigenen Domain laden kann —
gezeiten.bsh.de erlaubt keine Browser-Zugriffe von fremden Seiten (kein CORS).

Die Tafeln sind astronomische Vorausberechnungen und ändern sich nicht;
das Skript muss nur laufen, wenn das BSH ein neues Jahr veröffentlicht
(typischerweise einmal jährlich). Danach in sw.js die CACHE_NAME-Version
erhöhen, damit installierte Apps die neuen Dateien laden.

Aufruf:  python3 scripts/aktualisiere-gezeitentafeln.py

Datenquelle: BSH, CC BY 4.0 (https://gezeiten.bsh.de).
"""

import concurrent.futures
import json
import pathlib
import sys
import urllib.request

BASIS = "https://gezeiten.bsh.de/data"
ZIEL = pathlib.Path(__file__).resolve().parent.parent / "tides"
ERWARTETER_OFFSET = "+01:00"  # Gezeitentafeln nutzen ganzjährig MEZ


def lade_json(url):
    with urllib.request.urlopen(url, timeout=60) as antwort:
        return json.load(antwort)


def daten_url(bshnr):
    # entspricht dem padStart(5, "_") der BSH-Webseite: "504B" -> "_504B"
    return f"{BASIS}/DE_{bshnr.rjust(5, '_')}_tides.json"


def verdichte(station):
    """Reduziert eine Stations-Tafel auf das, was die App braucht."""
    jahre = {}
    ereignisse = []
    for jahr_objekt in station.get("years", []):
        for jahr, inhalt in jahr_objekt.items():
            jahre[jahr] = {
                "mhw": inhalt.get("MHW"),
                "mnw": inhalt.get("MNW"),
                "level": inhalt.get("level_tidalvalues"),
            }
            for e in inhalt.get("hwnw_prediction", {}).get("data", []):
                zeit = e["timestamp"]
                if not zeit.endswith(ERWARTETER_OFFSET):
                    raise ValueError(f"Unerwarteter Zeitzonen-Offset in {station['seo_id']}: {zeit}")
                # "2026-01-01 06:06:00+01:00" -> "2026-01-01 06:06" (Offset ergänzt die App beim Parsen)
                ereignisse.append([zeit[:16], e["type"], e.get("height")])
    ereignisse.sort()
    return {
        "name": station["station_name"],
        "seo_id": station["seo_id"],
        "jahre": jahre,
        "ereignisse": ereignisse,
    }


def main():
    uebersicht = lade_json(f"{BASIS}/tides_overview.json")
    stationen = uebersicht["gauges"]
    print(f"{len(stationen)} Stationen in der Übersicht")
    ZIEL.mkdir(exist_ok=True)

    index = []
    fehler = []

    def verarbeite(eintrag):
        roh = lade_json(daten_url(eintrag["bshnr"]))
        kompakt = verdichte(roh)
        pfad = ZIEL / f"{kompakt['seo_id']}.json"
        pfad.write_text(json.dumps(kompakt, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        return {"name": kompakt["name"], "seo_id": kompakt["seo_id"]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        laufend = {pool.submit(verarbeite, s): s for s in stationen}
        for zukunft in concurrent.futures.as_completed(laufend):
            eintrag = laufend[zukunft]
            try:
                index.append(zukunft.result())
            except Exception as exc:  # noqa: BLE001 — Fehler sammeln, Rest weiterladen
                fehler.append((eintrag["seo_id"], str(exc)))

    index.sort(key=lambda e: e["name"])
    (ZIEL / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    gesamt = sum(f.stat().st_size for f in ZIEL.glob("*.json"))
    print(f"{len(index)} Stationen gespiegelt nach {ZIEL} ({gesamt / 1e6:.1f} MB)")
    if fehler:
        print("Fehlgeschlagen:", file=sys.stderr)
        for seo_id, meldung in fehler:
            print(f"  {seo_id}: {meldung}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
