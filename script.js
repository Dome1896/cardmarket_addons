// ============================================================
//  ManaBox-CSV  →  JSON  →  Cardmarket
// ============================================================

// Falls SET_ALIASE nicht schon woanders definiert ist
var SET_ALIASE = window.SET_ALIASE || {};

// ------------------------------------------------------------
//  CSV einlesen (RFC 4180: Anführungszeichen, Kommas in Feldern,
//  "" als escaptes Anführungszeichen, CRLF oder LF, BOM)
// ------------------------------------------------------------
function parseCsv(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  var zeilen = [], zeile = [], feld = '', inQuotes = false;

  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { feld += '"'; i++; }
        else inQuotes = false;
      } else feld += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      zeile.push(feld); feld = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      zeile.push(feld); feld = '';
      zeilen.push(zeile); zeile = [];
    } else feld += c;
  }
  if (feld !== '' || zeile.length) { zeile.push(feld); zeilen.push(zeile); }

  // Leere Zeilen entfernen
  zeilen = zeilen.filter(z => z.some(f => f.trim() !== ''));
  if (!zeilen.length) return [];

  var kopf = zeilen[0].map(h => h.trim());
  return zeilen.slice(1).map(z => {
    var obj = {};
    kopf.forEach((h, idx) => { obj[h] = (z[idx] || '').trim(); });
    return obj;
  });
}

// ------------------------------------------------------------
//  Rohzeilen → Kartenobjekte
//  Nimmt entweder CSV-Text oder ein bereits geparstes Array.
// ------------------------------------------------------------
function transformData(data) {
  if (!data) return [];
  if (typeof data === 'string') data = parseCsv(data);
  if (!Array.isArray(data)) return [];

  var zahl = v => { var n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
  var bool = v => String(v).toLowerCase() === 'true';

  return data
    .filter(row => row.Name)
    .map(row => ({
      name:            row.Name,
      sprache:         row.Language,                 // z. B. "en"
      setCode:         row['Set code'],              // z. B. "otj"
      setName:         row['Set name'],
      preis:           zahl(row['Purchase price']),
      waehrung:        row['Purchase price currency'],
      menge:           parseInt(row.Quantity, 10) || 1,
      foil:            row.Foil,                     // "normal" | "foil" | "etched"
      condition:       row.Condition,                // z. B. "near_mint"
      collectorNumber: row['Collector number'],
      seltenheit:      row.Rarity,
      scryfallId:      row['Scryfall ID'],
      manaboxId:       row['ManaBox ID'],
      misprint:        bool(row.Misprint),
      altered:         bool(row.Altered),
      signed:          bool(row.Signed),
      proxy:           bool(row.Proxy)
    }));
}

// Identische Karten (gleiche Druckversion, Foil, Zustand, Sprache, Preis)
// zu einem Eintrag mit summierter Menge zusammenfassen
function zusammenfassen(karten) {
  var map = new Map();
  karten.forEach(k => {
    var key = [k.scryfallId || k.name + '|' + k.setCode + '|' + k.collectorNumber,
               k.foil, k.condition, k.sprache, k.preis,
               k.misprint, k.altered, k.signed].join('|');
    if (map.has(key)) map.get(key).menge += k.menge;
    else map.set(key, Object.assign({}, k));
  });
  return [...map.values()];
}

// ------------------------------------------------------------
//  Preise
// ------------------------------------------------------------
var MIN_CM_PREIS = 0.02;   // kleinster Preis, den Cardmarket annimmt

// "0,25" / "0.25" / "1" → Zahl; ungültig oder < 0,02 → null
function liesPreis(text) {
  var t = String(text).trim().replace(',', '.');
  if (!/^\d*(\.\d{1,2})?$/.test(t) || t === '' || t === '.') return null;
  var n = parseFloat(t);
  return n >= MIN_CM_PREIS ? n : null;
}

// Einheitspreis hat Vorrang, sonst CSV-Preis, mindestens aber Mindestpreis.
// Ergebnis ist null, wenn kein Preis bestimmbar ist.
function berechnePreis(karte, einst) {
  einst = einst || {};
  var ein = einst.einheitspreis, min = einst.mindestpreis;
  if (typeof ein === 'number' && !isNaN(ein)) return ein;
  var p = karte.preis;
  if (typeof min === 'number' && !isNaN(min)) p = (p == null || p < min) ? min : p;
  if (p == null) return null;
  p = Math.round(p * 100) / 100;
  return p < MIN_CM_PREIS ? MIN_CM_PREIS : p;
}

// ------------------------------------------------------------
//  Modal zum Hochladen der CSV
//  Gibt ein Promise zurück → Array der Kartenobjekte (oder null bei Abbruch)
// ------------------------------------------------------------
function frageCsv() {
  var alt = document.getElementById('mbx-overlay');
  if (alt) alt.remove();

  if (!document.getElementById('mbx-style')) {
    var style = document.createElement('style');
    style.id = 'mbx-style';
    style.textContent = `
      #mbx-overlay { position: fixed; inset: 0; z-index: 2147483000;
        background: rgba(20, 24, 33, .55); display: flex;
        align-items: center; justify-content: center; padding: 16px;
        font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
      #mbx-modal { background: #fff; color: #1d2330; width: 100%; max-width: 520px;
        border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.3);
        padding: 22px 24px 20px; max-height: 90vh; overflow: auto; }
      #mbx-modal h2 { margin: 0 0 4px; font-size: 19px; font-weight: 650; }
      #mbx-modal p.mbx-sub { margin: 0 0 16px; color: #5a6275; font-size: 14px; }
      #mbx-drop { border: 2px dashed #b9c1d1; border-radius: 8px; padding: 26px 16px;
        text-align: center; cursor: pointer; color: #4a5266; transition: background .15s, border-color .15s; }
      #mbx-drop:hover, #mbx-drop:focus-visible { border-color: #1f5fbf; outline: none; }
      #mbx-drop.mbx-aktiv { background: #eef4ff; border-color: #1f5fbf; }
      #mbx-drop strong { color: #1f5fbf; }
      #mbx-status { margin: 14px 0 0; font-size: 14px; min-height: 20px; }
      #mbx-status.mbx-fehler { color: #b3261e; }
      #mbx-vorschau { margin-top: 10px; max-height: 200px; overflow: auto;
        border: 1px solid #e3e7ef; border-radius: 6px; display: none; }
      #mbx-vorschau table { width: 100%; border-collapse: collapse; font-size: 13px; }
      #mbx-vorschau th, #mbx-vorschau td { padding: 5px 8px; text-align: left;
        border-bottom: 1px solid #eef1f6; white-space: nowrap; }
      #mbx-vorschau th { background: #f6f8fb; position: sticky; top: 0; font-weight: 600; }
      #mbx-preise { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
      #mbx-preise label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
      #mbx-preise small { display: block; color: #5a6275; font-weight: 400; font-size: 12px; margin-top: 3px; }
      #mbx-preise .mbx-feld { display: flex; align-items: center; border: 1px solid #c4cad6; border-radius: 6px; }
      #mbx-preise .mbx-feld:focus-within { border-color: #1f5fbf; box-shadow: 0 0 0 2px rgba(31,95,191,.2); }
      #mbx-preise input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent;
        font: inherit; padding: 7px 8px; text-align: right; color: inherit; }
      #mbx-preise .mbx-feld span { padding: 0 9px 0 2px; color: #5a6275; }
      #mbx-preise input.mbx-ungueltig { color: #b3261e; }
      #mbx-vorschau td.mbx-geaendert { color: #1f5fbf; font-weight: 600; }
      #mbx-vorschau td.mbx-ohne { color: #b3261e; }
      @media (max-width: 480px) { #mbx-preise { grid-template-columns: 1fr; } }
      #mbx-merge, #mbx-deutsch { display: flex; gap: 8px; align-items: center; margin-top: 12px; font-size: 14px; }
      #mbx-aktionen { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
      #mbx-aktionen button { font: inherit; padding: 8px 16px; border-radius: 6px;
        cursor: pointer; border: 1px solid #c4cad6; background: #fff; color: #1d2330; }
      #mbx-aktionen button:focus-visible { outline: 2px solid #1f5fbf; outline-offset: 2px; }
      #mbx-ok { background: #1f5fbf !important; border-color: #1f5fbf !important; color: #fff !important; }
      #mbx-ok:disabled { opacity: .45; cursor: not-allowed; }
    `;
    document.head.appendChild(style);
  }

  var overlay = document.createElement('div');
  overlay.id = 'mbx-overlay';
  overlay.innerHTML = `
    <div id="mbx-modal" role="dialog" aria-modal="true" aria-labelledby="mbx-titel">
      <h2 id="mbx-titel">ManaBox-Export laden</h2>
      <p class="mbx-sub">CSV-Datei aus ManaBox wählen oder hierher ziehen.</p>
      <div id="mbx-drop" tabindex="0" role="button">
        <strong>Datei auswählen</strong> oder per Drag &amp; Drop ablegen
        <input type="file" id="mbx-file" accept=".csv,text/csv" hidden>
      </div>
      <label id="mbx-merge"><input type="checkbox" id="mbx-merge-cb" checked>
        Gleiche Karten zusammenfassen (Mengen addieren)</label>
      <label id="mbx-deutsch"><input type="checkbox" id="mbx-deutsch-cb">
        Alle Karten sind auf Deutsch (Sprache beim Einstellen auf Deutsch setzen)</label>
      <div id="mbx-preise">
        <div>
          <label for="mbx-minpreis">Mindestpreis</label>
          <div class="mbx-feld"><input id="mbx-minpreis" inputmode="decimal" placeholder="z. B. 0,25"><span>€</span></div>
          <small>Günstigere Karten werden auf diesen Wert angehoben.</small>
        </div>
        <div>
          <label for="mbx-einheitspreis">Einheitspreis</label>
          <div class="mbx-feld"><input id="mbx-einheitspreis" inputmode="decimal" placeholder="leer = aus"><span>€</span></div>
          <small>Alle Karten zu genau diesem Preis. Hat Vorrang.</small>
        </div>
      </div>
      <div id="mbx-status" aria-live="polite"></div>
      <div id="mbx-vorschau"></div>
      <div id="mbx-aktionen">
        <button type="button" id="mbx-abbrechen">Abbrechen</button>
        <button type="button" id="mbx-ok" disabled>Übernehmen</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  var $ = id => overlay.querySelector('#' + id);
  var drop = $('mbx-drop'), fileInput = $('mbx-file'), status = $('mbx-status'),
      vorschau = $('mbx-vorschau'), okBtn = $('mbx-ok'), mergeCb = $('mbx-merge-cb'), deutschCb = $('mbx-deutsch-cb'),
      minInput = $('mbx-minpreis'), einInput = $('mbx-einheitspreis');
  var rohKarten = null;

  var esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Liest ein Preisfeld; undefined = leer, NaN = ungültig
  var lesePreis = input => {
    var t = input.value.trim();
    if (!t) { input.classList.remove('mbx-ungueltig'); return undefined; }
    var n = liesPreis(t);
    input.classList.toggle('mbx-ungueltig', n == null);
    return n == null ? NaN : n;
  };
  var einstellungen = () => ({ mindestpreis: lesePreis(minInput), einheitspreis: lesePreis(einInput) });

  var ergebnis = () => {
    if (!rohKarten) return [];
    var e = einstellungen();
    var liste = mergeCb.checked ? zusammenfassen(rohKarten) : rohKarten;
    return liste.map(k => Object.assign({}, k, {
      verkaufspreis: berechnePreis(k, e),
      verkaufssprache: deutschCb.checked ? 'de' : k.sprache   // Sprache fürs Verkaufsformular
    }));
  };

  function zeigeVorschau() {
    var karten = ergebnis();
    var e = einstellungen();
    var summe = karten.reduce((s, k) => s + k.menge, 0);
    var ohne = karten.filter(k => k.verkaufspreis == null).length;
    var ungueltig = Number.isNaN(e.mindestpreis) || Number.isNaN(e.einheitspreis);
    status.className = ungueltig ? 'mbx-fehler' : '';
    status.textContent = ungueltig
      ? 'Ungültiger Preis – bitte z. B. 0,25 eingeben (mind. 0,02 €).'
      : karten.length + ' Einträge, ' + summe + ' Karten insgesamt.' +
        (ohne ? ' ' + ohne + ' ohne Preis werden übersprungen.' : '');
    vorschau.style.display = 'block';
    vorschau.innerHTML = '<table><thead><tr><th>Name</th><th>Set</th><th>#</th>' +
      '<th>Foil</th><th>Zustand</th><th>Sprache</th><th>Menge</th><th>Preis</th></tr></thead><tbody>' +
      karten.map(k => `<tr><td>${esc(k.name)}</td><td>${esc(k.setCode.toUpperCase())}</td>
        <td>${esc(k.collectorNumber)}</td><td>${esc(k.foil)}</td><td>${esc(k.condition)}</td>
        <td${k.verkaufssprache !== k.sprache ? ' class="mbx-geaendert"' : ''}>${esc(k.verkaufssprache)}</td>
        <td>${k.menge}</td>${preisZelle(k)}</tr>`).join('') +
      '</tbody></table>';
    okBtn.disabled = !karten.length || ungueltig;
  }

  function preisZelle(k) {
    if (k.verkaufspreis == null) return '<td class="mbx-ohne">kein Preis</td>';
    var neu = k.verkaufspreis.toFixed(2);
    if (k.preis != null && k.preis.toFixed(2) === neu) return '<td>' + neu + '</td>';
    return '<td class="mbx-geaendert" title="CSV: ' + (k.preis == null ? 'kein Preis' : k.preis.toFixed(2)) +
      '">' + (k.preis == null ? '–' : k.preis.toFixed(2)) + ' → ' + neu + '</td>';
  }

  function fehler(text) {
    rohKarten = null;
    status.className = 'mbx-fehler';
    status.textContent = text;
    vorschau.style.display = 'none';
    okBtn.disabled = true;
  }

  function ladeDatei(file) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return fehler('Das ist keine CSV-Datei.');
    var reader = new FileReader();
    reader.onerror = () => fehler('Datei konnte nicht gelesen werden.');
    reader.onload = () => {
      var zeilen = parseCsv(reader.result);
      var kopf = zeilen.length ? Object.keys(zeilen[0]) : [];
      var pflicht = ['Name', 'Set code', 'Set name', 'Quantity'];
      var fehlend = pflicht.filter(p => !kopf.includes(p));
      if (fehlend.length) return fehler('Kein ManaBox-Format – es fehlen Spalten: ' + fehlend.join(', '));
      rohKarten = transformData(zeilen);
      if (!rohKarten.length) return fehler('Die Datei enthält keine Karten.');
      drop.querySelector('strong').textContent = file.name;
      zeigeVorschau();
    };
    reader.readAsText(file, 'utf-8');
  }

  return new Promise(resolve => {
    function schliessen(wert) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(wert);
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); schliessen(null); } }

    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', () => ladeDatei(fileInput.files[0]));
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.add('mbx-aktiv');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.remove('mbx-aktiv');
    }));
    drop.addEventListener('drop', e => ladeDatei(e.dataTransfer.files[0]));
    mergeCb.addEventListener('change', () => { if (rohKarten) zeigeVorschau(); });
    deutschCb.addEventListener('change', () => { if (rohKarten) zeigeVorschau(); });
    [minInput, einInput].forEach(inp => inp.addEventListener('input', () => {
      if (rohKarten) zeigeVorschau(); else lesePreis(inp);
    }));

    overlay.addEventListener('click', e => { if (e.target === overlay) schliessen(null); });
    $('mbx-abbrechen').addEventListener('click', () => schliessen(null));
    okBtn.addEventListener('click', () => { if (!okBtn.disabled) schliessen(ergebnis()); });
    document.addEventListener('keydown', onKey, true);
    drop.focus();
  });
}

// ------------------------------------------------------------
//  Cardmarket-Funktionen (unverändert übernommen)
// ------------------------------------------------------------
function suchFormular() {
  var forms = [...document.querySelectorAll('#ProductSearchForm')];
  return forms.find(f => f.offsetParent !== null) || forms[0] || null;
}

function sucheProdukt(name, idExpansion) {
  var form = suchFormular();
  if (!form) return { fehler: 'Formular nicht gefunden' };

  form.querySelector('select[name="idLanguage"]').value = '1';   // Englisch
  var exp = form.querySelector('select[name="idExpansion"]');
  exp.value = idExpansion || '';                                 // '' = Alle
  exp.dispatchEvent(new Event('change', { bubbles: true }));

  var input = form.querySelector('input[name="searchString"]');
  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, name);
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  return { ok: true };
}

function waehleTreffer(kartenName, setCode, setName, timeout) {
  timeout = timeout || 8000;
  var norm = s => String(s).toLowerCase()
    .replace(/\s+(von|of)\s+/g, ' of ').replace(/\s+/g, ' ').trim();
  var gesucht = norm(SET_ALIASE[String(setCode).toLowerCase()] || setName);

  return new Promise(resolve => {
    var start = Date.now();
    var pruefe = () => {
      var links = [...document.querySelectorAll('#ProductSuggestions a.modal-link')];
      var info = a => ({
        n: norm((a.querySelector('.text-truncate') || {}).textContent || ''),
        e: norm((a.querySelector('.expansion-symbol') || document.body).getAttribute('aria-label') || '')
      });

      var treffer = links.filter(a => {
        var i = info(a);
        var nameOk = i.n === norm(kartenName) || i.n.startsWith(norm(kartenName) + ' (');
        return nameOk && normSet(i.e) === normSet(gesucht);   // Satzzeichen egal
      });

      if (treffer.length === 1) {
        treffer[0].click();
        return resolve({ ok: true, modal: treffer[0].dataset.modal });
      }
      if (treffer.length > 1) {
        return resolve({ fehler: 'Mehrdeutig',
          kandidaten: treffer.map(a => a.textContent.trim() + ' | ' + a.dataset.modal) });
      }
      if (links.length && Date.now() - start > timeout) {
        return resolve({ fehler: 'Erweiterung nicht gefunden', gesucht: gesucht,
          vorhanden: links.map(a => (a.querySelector('.expansion-symbol') || document.body).getAttribute('aria-label')) });
      }
      if (Date.now() - start > timeout) return resolve({ fehler: 'Keine Ergebnisse' });
      setTimeout(pruefe, 250);
    };
    pruefe();
  });
}

// Vergleichsform für Set-Namen: Kleinschreibung, "von" → "of",
// Satzzeichen weg, Mehrfach-Leerzeichen zusammenfassen
function normSet(s) {
  return String(s || '').toLowerCase()
    .replace(/\s+(von|of)\s+/g, ' of ')
    .replace(/[:'’"\-–—.,()]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Sucht die passende Erweiterung im Dropdown des Suchformulars
function findeErweiterung(setCode, setName) {
  var form = suchFormular();
  var sel = form && form.querySelector('select[name="idExpansion"]');
  if (!sel) return { fehler: 'Erweiterungs-Dropdown nicht gefunden' };

  var optionen = [...sel.options].filter(o => o.value !== '')
    .map(o => ({ id: o.value, text: o.textContent.trim(), n: normSet(o.textContent) }));
  var gesucht = normSet(SET_ALIASE[String(setCode).toLowerCase()] || setName);

  // 1. exakt gleich
  var exakt = optionen.filter(o => o.n === gesucht);
  if (exakt.length === 1) return exakt[0];

  // 2. gleiche Wörter, andere Reihenfolge
  //    (ManaBox „… Thunder Junction Commander“ ↔ Cardmarket „Commander: … Thunder Junction“)
  var woerter = t => t.split(' ').sort().join(' ');
  var umgestellt = optionen.filter(o => woerter(o.n) === woerter(gesucht));
  if (umgestellt.length === 1) return umgestellt[0];

  // 3. Dropdown-Name enthält den gesuchten Namen vollständig – nur wenn eindeutig.
  //    (Umgekehrt nicht, sonst würde z. B. ein Commander-Set auf das Hauptset fallen.)
  var teil = optionen.filter(o => (' ' + o.n + ' ').includes(' ' + gesucht + ' '));
  if (teil.length === 1) return teil[0];
  if (teil.length > 1) {
    return { fehler: 'Erweiterung im Dropdown mehrdeutig', gesucht: gesucht,
             kandidaten: teil.map(o => o.text) };
  }
  return { fehler: 'Erweiterung nicht im Dropdown', gesucht: gesucht };
}

async function verkaufe(name, sprache, setCode, setName) {
  var leeren = () => {
    var box = document.querySelector('#ProductSuggestions');
    if (box) box.innerHTML = '';   // alte Treffer entfernen
  };

  // 1. Versuch: Suche über alle Erweiterungen
  leeren();
  var r = sucheProdukt(name);
  if (r.fehler) return r;
  r = await waehleTreffer(name, setCode, setName);
  if (!r.fehler || r.fehler === 'Mehrdeutig') return r;

  // 2. Versuch: Erweiterung im Dropdown wählen und erneut suchen
  if (typeof mbxPanel !== 'undefined') mbxPanel.status('Nicht in den Vorschlägen – suche mit Erweiterungsfilter …');
  var erweiterung = findeErweiterung(setCode, setName);
  if (erweiterung.fehler) {
    return Object.assign({}, r, { fehler: r.fehler + ' / ' + erweiterung.fehler, ersterVersuch: r,
                                  erweiterung: erweiterung });
  }

  leeren();
  var s = sucheProdukt(name, erweiterung.id);
  if (s.fehler) return s;
  // Ergebnisse sind jetzt auf die Erweiterung gefiltert → deren Dropdown-Text als Set-Namen prüfen
  var r2 = await waehleTreffer(name, '', erweiterung.text);
  r2.erweiterung = erweiterung;
  r2.ersterVersuch = r;
  if (r2.fehler && r2.fehler !== 'Mehrdeutig') {
    r2.fehler = 'Auch mit Erweiterung „' + erweiterung.text + '“ nicht gefunden (' + r2.fehler + ')';
  }
  return r2;
}

function setzePreis(preis) {
  const form = [...document.querySelectorAll('#ListProductForm')]
    .find(f => f.offsetParent !== null);
  if (!form) return 'Kein sichtbares Formular gefunden';

  const input = form.querySelector('input[name="price"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  input.focus();
  setter.call(input, preis);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur();

  return { wert: input.value, gueltig: input.checkValidity(), sichtbar: input.offsetParent !== null };
}

// ------------------------------------------------------------
//  Restliche Felder des Verkaufsformulars
// ------------------------------------------------------------
var SPRACHE_ID   = { en: '1', fr: '2', de: '3', es: '4', it: '5', ja: '7' };
var ZUSTAND_ID   = { mint: '1', near_mint: '2', excellent: '3', good: '4',
                     light_played: '5', lightly_played: '5', played: '6', poor: '7' };

function setzeFeld(el, wert) {
  if (el.type === 'checkbox') {
    if (el.checked !== !!wert) el.checked = !!wert;
  } else {
    var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(wert));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Gibt null zurück, wenn alles gesetzt wurde, sonst einen Fehlertext
function fuelleFormular(form, k) {
  var feld = n => form.querySelector('[name="' + n + '"]');

  if (k.proxy)   return 'Proxy – wird nicht verkauft';
  if (k.altered) return 'Altered – Cardmarket verlangt ein Bild';

  var zielSprache = k.verkaufssprache || k.sprache;   // „Alle auf Deutsch“ → 'de'
  var sprache = SPRACHE_ID[String(zielSprache).toLowerCase()];
  if (!sprache) return 'Sprache „' + zielSprache + '“ gibt es für dieses Produkt nicht';
  var zustand = ZUSTAND_ID[String(k.condition).toLowerCase()];
  if (!zustand) return 'Unbekannter Zustand „' + k.condition + '“';

  var amount = feld('amount');
  var max = parseInt(amount && amount.max, 10) || 9999;
  if (k.menge > max) return 'Menge ' + k.menge + ' über Maximum ' + max;

  var sel = feld('idLanguage');
  if (![...sel.options].some(o => o.value === sprache)) return 'Sprache „' + zielSprache + '“ nicht wählbar';

  setzeFeld(amount, k.menge);
  setzeFeld(sel, sprache);
  setzeFeld(feld('idCondition'), zustand);
  setzeFeld(feld('isFoil'),   k.foil === 'foil' || k.foil === 'etched');
  setzeFeld(feld('isSigned'), k.signed);
  setzeFeld(feld('isAltered'), false);
  return null;
}

// Offenes Cardmarket-Modal schließen (nach Fehler)
function schliesseCmModal(form) {
  var modal = form.closest('.modal');
  var x = modal && modal.querySelector('[data-bs-dismiss="modal"], .btn-close');
  if (x) x.click();
}

// ============================================================
//  Testlauf: Karten nacheinander abarbeiten
// ============================================================

var MBX_KEY = 'mbx-stand';          // Schlüssel im localStorage
var mbxSteuerung = { stopp: false, ueberspringen: false };

var mbxEsc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Zwischenspeichern ----------
// Stand: { queue: [...noch offen], ergebnisse: [...], laufend: {karte, abgeschickt} | null }
function ladeStand() {
  try { return JSON.parse(localStorage.getItem(MBX_KEY)) || null; }
  catch (e) { return null; }
}
function speichereStand(stand) {
  try { localStorage.setItem(MBX_KEY, JSON.stringify(stand)); }
  catch (e) { console.warn('Zwischenspeichern fehlgeschlagen:', e); }
}
function loescheStand() {
  try { localStorage.removeItem(MBX_KEY); } catch (e) {}
}
function protokolliere(stand, karte, status, grund, details) {
  stand.ergebnisse.push({ karte, status, grund: grund || '', details: details || null,
                          zeit: new Date().toISOString() });
  stand.queue.shift();
  stand.laufend = null;
  speichereStand(stand);
}

// ---------- Hilfen ----------
var schlafe = ms => new Promise(r => setTimeout(r, ms));
var sichtbaresListForm = () => [...document.querySelectorAll('#ListProductForm')]
  .find(f => f.offsetParent !== null) || null;

async function warteAuf(fn, timeout) {
  var start = Date.now();
  while (Date.now() - start < (timeout || 10000)) {
    var wert = fn();
    if (wert) return wert;
    await schlafe(250);
  }
  return null;
}

// Wartet, bis das abgeschickte Formular verschwindet (→ 'eingestellt'),
// es ohne Abschicken geschlossen wird (→ 'geschlossen'), der Timeout
// abläuft (→ 'timeout') oder im Panel „Überspringen“/„Stopp“ gedrückt wird.
function warteAufEinstellen(form, stand, timeout) {
  var start = Date.now();
  return new Promise(resolve => {
    var abgeschickt = false;
    var markiere = () => {
      if (abgeschickt) return;
      abgeschickt = true;
      if (stand.laufend) { stand.laufend.abgeschickt = true; speichereStand(stand); }
      mbxPanel.status('Abgeschickt – warte auf Bestätigung …');
    };
    var onSubmit = e => { if (e.target === form) markiere(); };
    var onClick = e => {
      var btn = e.target.closest && e.target.closest('button, input[type="submit"]');
      if (btn && form.contains(btn) && (btn.type === 'submit' || btn.matches('[type="submit"]'))) markiere();
    };
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('click', onClick, true);

    var fertig = wert => {
      clearInterval(timer);
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('click', onClick, true);
      resolve(wert);
    };
    var timer = setInterval(() => {
      if (mbxSteuerung.stopp) return fertig('stopp');
      if (mbxSteuerung.ueberspringen) return fertig('uebersprungen');
      var weg = !document.contains(form) || form.offsetParent === null;
      if (weg) return fertig(abgeschickt ? 'eingestellt' : 'geschlossen');
      if (timeout && Date.now() - start > timeout) fertig(abgeschickt ? 'timeout' : 'nicht_abgeschickt');
    }, 300);
  });
}

// ---------- Schwebendes Steuerpanel ----------
var mbxPanel = {
  el: null,
  zeige() {
    if (this.el) return;
    this.el = document.createElement('div');
    this.el.id = 'mbx-panel';
    this.el.innerHTML = `
      <div id="mbx-p-fortschritt"></div>
      <div id="mbx-p-karte"></div>
      <div id="mbx-p-status" aria-live="polite"></div>
      <div id="mbx-p-knoepfe">
        <button type="button" id="mbx-p-skip">Überspringen</button>
        <button type="button" id="mbx-p-stopp">Stopp</button>
      </div>`;
    document.body.appendChild(this.el);
    this.el.querySelector('#mbx-p-skip').onclick = () => { mbxSteuerung.ueberspringen = true; };
    this.el.querySelector('#mbx-p-stopp').onclick = () => { mbxSteuerung.stopp = true; this.status('Wird angehalten …'); };
  },
  karte(k, nr, gesamt) {
    this.el.querySelector('#mbx-p-fortschritt').textContent = 'Karte ' + nr + ' von ' + gesamt;
    this.el.querySelector('#mbx-p-karte').innerHTML =
      '<strong>' + mbxEsc(k.name) + '</strong><br>' +
      mbxEsc(k.setName) + ' (' + mbxEsc(k.setCode.toUpperCase()) + ' #' + mbxEsc(k.collectorNumber) + ')' +
      ' · ' + mbxEsc(k.foil) + ' · ' + mbxEsc(k.condition) +
      ' · ' + mbxEsc(k.verkaufssprache || k.sprache) + ' · Menge ' + k.menge +
      ' · ' + (k.verkaufspreis == null ? 'kein Preis' : k.verkaufspreis.toFixed(2) + ' €');
  },
  status(text) { if (this.el) this.el.querySelector('#mbx-p-status').textContent = text; },
  weg() { if (this.el) { this.el.remove(); this.el = null; } }
};

function mbxZusatzStyles() {
  if (document.getElementById('mbx-style2')) return;
  var s = document.createElement('style');
  s.id = 'mbx-style2';
  s.textContent = `
    #mbx-panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147482000; width: 300px;
      background: #fff; color: #1d2330; border: 1px solid #d5dae4; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.22); padding: 12px 14px;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    #mbx-p-fortschritt { color: #5a6275; font-size: 12px; margin-bottom: 4px; }
    #mbx-p-karte strong { font-size: 14px; }
    #mbx-p-status { margin-top: 8px; padding: 6px 8px; background: #f3f6fb; border-radius: 6px; min-height: 18px; }
    #mbx-p-knoepfe { display: flex; gap: 8px; margin-top: 10px; }
    #mbx-p-knoepfe button { flex: 1; font: inherit; padding: 6px; border-radius: 6px; cursor: pointer;
      border: 1px solid #c4cad6; background: #fff; color: #1d2330; }
    #mbx-p-stopp { color: #b3261e !important; border-color: #e3b4b0 !important; }
    #mbx-modal.mbx-breit { max-width: 760px; }
    .mbx-abschnitt h3 { font-size: 15px; margin: 18px 0 6px; font-weight: 650; }
    .mbx-abschnitt.mbx-ok h3 { color: #1b6e3a; }
    .mbx-abschnitt.mbx-nok h3 { color: #b3261e; }
    .mbx-tabelle { max-height: 240px; overflow: auto; border: 1px solid #e3e7ef; border-radius: 6px; }
    .mbx-tabelle table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .mbx-tabelle th, .mbx-tabelle td { padding: 5px 8px; text-align: left; border-bottom: 1px solid #eef1f6; }
    .mbx-tabelle th { background: #f6f8fb; position: sticky; top: 0; font-weight: 600; }
    .mbx-leer { color: #5a6275; font-size: 13px; margin: 0; }
  `;
  document.head.appendChild(s);
}

// ---------- Eine Karte bearbeiten ----------
async function bearbeiteKarte(k, stand) {
  mbxSteuerung.ueberspringen = false;

  mbxPanel.status('Suche Karte …');
  var r = await verkaufe(k.name, k.sprache, k.setCode, k.setName);
  if (r.fehler) {
    return protokolliere(stand, k, 'nicht_gefunden', r.fehler, r);
  }

  mbxPanel.status('Treffer gefunden, warte auf Formular …');
  var form = await warteAuf(sichtbaresListForm, 10000);
  if (!form) return protokolliere(stand, k, 'fehler', 'Verkaufsformular nicht geladen', r);

  if (k.verkaufspreis === undefined) k.verkaufspreis = berechnePreis(k);   // alter Zwischenstand
  var fehlerText = k.verkaufspreis == null ? 'Kein Preis' : fuelleFormular(form, k);
  if (!fehlerText) {
    var p = setzePreis(k.verkaufspreis.toFixed(2));
    if (typeof p === 'string') fehlerText = p;
    else if (!p.gueltig) fehlerText = 'Preis ' + p.wert + ' wird nicht akzeptiert';
  }
  if (!fehlerText && !form.checkValidity()) {
    var bad = [...form.elements].find(el => !el.checkValidity());
    fehlerText = 'Formular ungültig' + (bad ? ' (' + bad.name + ')' : '');
  }
  if (fehlerText) {
    schliesseCmModal(form);
    await warteAuf(() => form.offsetParent === null, 3000);
    return protokolliere(stand, k, 'nicht_eingestellt', fehlerText, r);
  }

  stand.laufend = { karte: k, abgeschickt: false };
  speichereStand(stand);

  mbxPanel.status(k.menge + '× für ' + k.verkaufspreis.toFixed(2) + ' € – wird eingestellt …');
  var warten = warteAufEinstellen(form, stand, 20000);
  var knopf = form.querySelector('input[type="submit"], button[type="submit"]');
  if (knopf) knopf.click(); else form.requestSubmit();

  var ausgang = await warten;
  if (ausgang === 'stopp') {
    // Wurde schon abgeschickt → trotzdem als eingestellt verbuchen
    if (stand.laufend && stand.laufend.abgeschickt) protokolliere(stand, k, 'eingestellt', 'Vor dem Stopp abgeschickt (bitte prüfen)', r);
    else { stand.laufend = null; speichereStand(stand); }
    return 'stopp';
  }
  if (ausgang === 'eingestellt') return protokolliere(stand, k, 'eingestellt', '', r);
  if (ausgang === 'uebersprungen') return protokolliere(stand, k, 'uebersprungen', 'Manuell übersprungen', r);
  if (ausgang === 'timeout' || ausgang === 'nicht_abgeschickt') {
    var meldung = [...form.querySelectorAll('.invalid-feedback, .alert')]
      .filter(el => el.offsetParent !== null).map(el => el.textContent.trim()).join(' ');
    schliesseCmModal(form);
    await warteAuf(() => form.offsetParent === null, 3000);
    return protokolliere(stand, k, 'nicht_eingestellt',
      (ausgang === 'timeout' ? 'Keine Bestätigung von Cardmarket' : 'Abschicken hat nicht ausgelöst') +
      (meldung ? ': ' + meldung : ''), r);
  }
  return protokolliere(stand, k, 'nicht_eingestellt', 'Formular ohne Einstellen geschlossen', r);
}

// ---------- Übersicht ----------
function zeigeUebersicht(stand) {
  mbxZusatzStyles();
  var alt = document.getElementById('mbx-overlay');
  if (alt) alt.remove();

  var ok = stand.ergebnisse.filter(e => e.status === 'eingestellt');
  var nok = stand.ergebnisse.filter(e => e.status !== 'eingestellt');
  var offen = stand.queue.length;
  var summe = liste => liste.reduce((s, e) => s + (e.karte.menge || 0), 0);

  var zeile = (e, mitGrund) => `<tr>
      <td>${mbxEsc(e.karte.name)}</td>
      <td>${mbxEsc(e.karte.setCode.toUpperCase())} #${mbxEsc(e.karte.collectorNumber)}</td>
      <td>${mbxEsc(e.karte.foil)}</td>
      <td>${e.karte.menge}</td>
      <td>${e.karte.verkaufspreis == null ? '–' : e.karte.verkaufspreis.toFixed(2)}</td>
      ${mitGrund ? '<td>' + mbxEsc(e.grund) + '</td>' : ''}</tr>`;
  var tabelle = (liste, mitGrund) => liste.length
    ? `<div class="mbx-tabelle"><table><thead><tr><th>Name</th><th>Set</th><th>Foil</th>
        <th>Menge</th><th>Preis</th>${mitGrund ? '<th>Grund</th>' : ''}</tr></thead>
        <tbody>${liste.map(e => zeile(e, mitGrund)).join('')}</tbody></table></div>`
    : '<p class="mbx-leer">Keine.</p>';

  var overlay = document.createElement('div');
  overlay.id = 'mbx-overlay';
  overlay.innerHTML = `
    <div id="mbx-modal" class="mbx-breit" role="dialog" aria-modal="true" aria-labelledby="mbx-titel">
      <h2 id="mbx-titel">${offen ? 'Import angehalten' : 'Import abgeschlossen'}</h2>
      <p class="mbx-sub">${ok.length} von ${stand.ergebnisse.length} Einträgen eingestellt
        (${summe(ok)} Karten).${offen ? ' Noch offen: ' + offen + ' – beim nächsten Start kannst du fortsetzen.' : ''}</p>
      <div class="mbx-abschnitt mbx-ok"><h3>Eingestellt (${ok.length})</h3>${tabelle(ok, false)}</div>
      <div class="mbx-abschnitt mbx-nok"><h3>Nicht eingestellt (${nok.length})</h3>${tabelle(nok, true)}</div>
      <div id="mbx-aktionen">
        <button type="button" id="mbx-json">Als JSON speichern</button>
        <button type="button" id="mbx-reset">Stand löschen</button>
        <button type="button" id="mbx-ok">Schließen</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  var schliessen = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  var onKey = e => { if (e.key === 'Escape') schliessen(); };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', e => { if (e.target === overlay) schliessen(); });
  overlay.querySelector('#mbx-ok').onclick = schliessen;
  overlay.querySelector('#mbx-reset').onclick = () => {
    if (confirm('Gespeicherten Stand und alle Ergebnisse löschen?')) { loescheStand(); schliessen(); }
  };
  overlay.querySelector('#mbx-json').onclick = () => {
    var blob = new Blob([JSON.stringify({ eingestellt: ok, nichtEingestellt: nok, offen: stand.queue }, null, 2)],
                        { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cardmarket-import-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  overlay.querySelector('#mbx-ok').focus();
}

// ---------- Hauptablauf ----------
async function starteImport() {
  mbxZusatzStyles();
  mbxSteuerung.stopp = false;

  var stand = ladeStand();

  // Unterbrochene Karte aus einem früheren Lauf (z. B. Seite neu geladen)
  if (stand && stand.laufend) {
    var lk = stand.laufend.karte;
    if (stand.laufend.abgeschickt) {
      protokolliere(stand, lk, 'eingestellt', 'Abgeschickt, Seite danach neu geladen (bitte prüfen)');
    } else {
      stand.laufend = null;   // bleibt vorne in der Queue und wird erneut versucht
      speichereStand(stand);
    }
  }

  if (stand && stand.queue.length &&
      confirm('Es gibt einen unterbrochenen Import mit ' + stand.queue.length +
              ' offenen Einträgen. Fortsetzen?\n\n(Abbrechen = neue CSV laden)')) {
    // weiter mit gespeichertem Stand
  } else {
    var karten = await frageCsv();
    if (!karten) return console.log('CSV-Import abgebrochen.');
    stand = { queue: karten, ergebnisse: [], laufend: null };
    speichereStand(stand);
  }

  var gesamt = stand.queue.length + stand.ergebnisse.length;
  mbxPanel.zeige();

  while (stand.queue.length && !mbxSteuerung.stopp) {
    var k = stand.queue[0];
    mbxPanel.karte(k, stand.ergebnisse.length + 1, gesamt);
    try {
      if (await bearbeiteKarte(k, stand) === 'stopp') break;
    } catch (err) {
      console.error(err);
      protokolliere(stand, k, 'fehler', String(err && err.message || err));
    }
    await schlafe(800);   // kurze Pause, damit Cardmarket das Modal sauber schließt
  }

  mbxPanel.weg();
  zeigeUebersicht(stand);
  window.mbxStand = stand;
}

starteImport();