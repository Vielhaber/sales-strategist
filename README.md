# OrbitAI Sales Strategist

Ein B2B-Sales-Cockpit: KI-gestützte Bedarfsanalysen, Lead-Scouting, ein CRM mit Kaufpotenzial-Bewertung, ein ROI-Rechner und ein KI-Landingpage-Generator - wahlweise mit einer echten Gemini-Anbindung oder komplett offline mit Beispieldaten.

## Wichtig: Zwei Betriebsmodi

**Offline-Demo-Modus** - läuft ohne jede Einrichtung, auch direkt über GitHub Pages oder durch einfaches Öffnen von `index.html`. Alle Berichte, Leads und Landingpages werden lokal aus Beispieldaten generiert, ohne Netzwerkzugriff.

**Live-Modus mit echter KI** - benötigt den mitgelieferten Python-Server (`server.py`), der als Backend-Proxy für die Gemini-API dient. **Das funktioniert nur, wenn der Server tatsächlich läuft** - eine rein statisch gehostete Version (z. B. über GitHub Pages) kann `server.py` nicht ausführen und bleibt deshalb dauerhaft im Offline-Modus. Die App zeigt in diesem Fall einen Hinweis-Banner an.

## Lokal starten (für den Live-Modus erforderlich)

```bash
git clone https://github.com/Vielhaber/sales-strategist.git
cd sales-strategist
python3 server.py
```

Danach im Browser `http://localhost:8080` öffnen. Der Server benötigt keine externen Python-Pakete (nur die Standardbibliothek).

Den Gemini-API-Key entweder direkt in den Einstellungen der App speichern (wird serverseitig in `.gemini_config.json` abgelegt, niemals im Browser) oder per Umgebungsvariable setzen, bevor der Server startet:

```bash
export GEMINI_API_KEY="dein-key-hier"
python3 server.py
```

Standardmäßig lauscht der Server nur auf `127.0.0.1` (nicht im restlichen Netzwerk erreichbar). Wer ihn bewusst für andere Geräte im selben Netzwerk freigeben will, kann das über `HOST=0.0.0.0 python3 server.py` tun - das gibt dann aber auch jedem im Netzwerk Zugriff auf den gespeicherten API-Key, daher nur mit Bedacht einsetzen.

## Sicherheitshinweise

- Der Gemini-API-Key verlässt den Server nie in Richtung Browser - die Frontend-Logik ruft ausschließlich eigene `/api/*`-Endpunkte auf.
- `/api/scrape` validiert Ziel-URLs gegen SSRF (nur `http`/`https`, keine privaten/internen IP-Bereiche) und verbindet sich mit der bereits geprüften IP-Adresse, um DNS-Rebinding-Angriffe auszuschließen.
- Das Admin-Passwort im Setup-Bereich ist **kein echter Zugriffsschutz**, sondern nur eine leichte Sperre gegen versehentliches Öffnen - es wird zwar gehasht gespeichert, lässt sich aber über die Browser-Entwicklertools umgehen.
- Von der KI generierte Inhalte (Landingpages) werden in einem sandboxed `<iframe>` ohne `allow-same-origin` gerendert und können nicht auf die App selbst oder ihre Daten zugreifen.

## Daten & Backup

Kampagnen, Kundenkartei und Leads werden ausschließlich im `localStorage` des Browsers gespeichert - es gibt keine serverseitige Datenbank. Das heißt: Browserdaten löschen, Gerät wechseln oder ein anderer Browser bedeutet Datenverlust. Unter **Einstellungen → Daten-Backup** lässt sich der komplette Datenbestand als JSON-Datei exportieren und auf einem anderen Gerät/Browser wieder importieren.

## Projektstruktur

```
index.html      Markup, sandboxed KI-Vorschau, Formulare
style.css       Styling
data.js         Vorgefertigte Demo-Kampagnen
app.js          App-Logik (ES-Modul), DOM-Bindungen
utils.js        HTML-Escaping, sichere Links, Markdown-Rendering
api.js          Sämtliche Netzwerkzugriffe + Offline-Mock-Daten
server.py       Lokaler Server: statisches Hosting + Gemini-Proxy + SSRF-Schutz
```
