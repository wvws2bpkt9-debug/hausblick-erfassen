// AndyCare Erfassen – Handyseite (1.3.1, U-37, E-87, Lösung C). Nur „Mangel erfassen“: Foto (mit Markieren), Ort, Beschreibung,
// Zuständigkeit, Gefährdung. „Bestätigen“ legt den Eintrag auf DIESEM Handy ab (IndexedDB, auch ohne Netz). „An PC übergeben“
// erzeugt eine verschlüsselte Datei (AES-GCM mit dem Schlüssel aus der Kopplungsdatei); Andy gibt sie selbst an den PC
// (Mail, Teams, USB), AndyCare liest sie unter Einträge → „Vom Handy“. Seit U-38 (Freigabe IT 30.10.2026): Mit Postfach in der
// Kopplungsdatei geht jeder bestätigte Eintrag gleich verschlüsselt ins AndyCare-Postfach (Cloudflare Worker, sieht nur
// verschlüsselte Daten); AndyCare holt ihn dort mit „Gemeldete Mängel abrufen“. Ohne Netz wird nachgesendet.
// Seit 1.3.1-dev.6 (Audit 31.10.2026): Kopplungsdatei nur mit dem Einmalcode vom PC-Bildschirm (AC-06); Senden mit eigenem
// Schreibzugang im Kopf (AC-04); Gesendetes bleibt auf dem Handy, bis AndyCare die Übernahme quittiert – fehlt ein Paket ohne
// Quittung im Postfach (z. B. verfallen), sendet das Handy es neu (AC-05).
(function () {
  'use strict';
  const FASSUNG = '1.3.1';
  const S = { kopplung: null, eintraege: [], ansicht: 'erfassen', cap: null, q: '', mk: null, loeschFrage: false, fehler: '', koppelText: null };
  const leer = () => ({ fotos: [], marken: [], code: null, ortText: '', text: '', zust: null, typ: 'Mangel' });
  S.cap = leer();
  // Zuständig am Handy nur Haustechnik oder Technischer Dienst; keine „Gefährdung“ (1.3.1-dev.3, U-40)
  const ZUST = [['intern', 'Haustechnik'], ['TeDi', 'Technischer Dienst']];
  const FOTOS_MAX = 6, KANTE = 1600, QUALITAET = 0.82, B64 = /^[A-Za-z0-9+/]{43}=$/, KENNUNG = /^[0-9a-f]{12}$/, ZUGANG = /^[A-Za-z0-9_-]{43}$/;
  const KOPPEL_ITER = 600000, KOPPEL_AAD = 'hausblick-handy-kopplung-v2', NACH_MIN = 10;   // NACH_MIN: Liste im Postfach hinkt nach

  // ---------- Hilfen ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const ausB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
  const zwei = n => String(n).padStart(2, '0');
  const datum = d => `${zwei(d.getDate())}.${zwei(d.getMonth() + 1)}.${d.getFullYear()}, ${zwei(d.getHours())}:${zwei(d.getMinutes())}`;
  let toastT = null;
  function toast(t) { const el = document.getElementById('toast'); if (!el) return; el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3200); }

  // ---------- Speicher auf dem Handy (IndexedDB; ohne IndexedDB nur bis zum Schließen) ----------
  let dbP = null;
  const db = () => dbP || (dbP = new Promise((ok, fehl) => {
    if (!window.indexedDB) { fehl(new Error('kein Speicher')); return; }
    const r = indexedDB.open('hausblick-handy', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('daten');
    r.onsuccess = () => ok(r.result); r.onerror = () => fehl(r.error);
  }));
  async function lies(k) { const d = await db(); return new Promise((ok, fehl) => { const r = d.transaction('daten').objectStore('daten').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => fehl(r.error); }); }
  async function schreib(k, v) { const d = await db(); return new Promise((ok, fehl) => { const t = d.transaction('daten', 'readwrite'); t.objectStore('daten').put(v, k); t.oncomplete = () => ok(); t.onerror = () => fehl(t.error); }); }
  const sichern = () => schreib('eintraege', S.eintraege).catch(() => toast('Achtung: Speicher nicht verfügbar – nur bis zum Schließen'));

  // ---------- Kopplungsdatei vom PC (Raumliste und Schlüssel, einmalig) ----------
  // Inhalt nach dem Entschlüsseln prüfen
  function kopplungAus(j) {
    if (!j || j.format !== 'hausblick-handy-kopplung-inhalt' || j.version !== 2 || !KENNUNG.test(j.kennung) || !B64.test(j.schluessel)) throw new Error('Keine Kopplungsdatei.');
    const raeume = (Array.isArray(j.raeume) ? j.raeume : []).slice(0, 5000).filter(r => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string')
      .map(r => [r[0].slice(0, 40), r[1].slice(0, 120), String(r[2] || '').slice(0, 60), String(r[3] || '').slice(0, 60)]);
    // Postfach im Netz (1.3.1, U-38): nur das AndyCare-Postfach (bzw. localhost für die Vorschau), zufällige Kennung, Schreibzugang
    const p = j.postfach && typeof j.postfach === 'object' && /^(https:\/\/hausblick-postfach\.[a-z0-9-]+\.workers\.dev|http:\/\/localhost:\d{2,5})$/.test(String(j.postfach.url || ''))
      && /^[0-9a-f]{32}$/.test(String(j.postfach.id || '')) && ZUGANG.test(String(j.postfach.schreib || '')) ? { url: j.postfach.url, id: j.postfach.id, schreib: j.postfach.schreib } : null;
    return { kennung: j.kennung, schluessel: j.schluessel, postfach: p, raeume, erstellt: String(j.erstellt || '').slice(0, 30) };
  }
  // Datei (Version 2) mit dem Einmalcode vom PC-Bildschirm öffnen; Version 1 (Klartext) gilt nicht mehr
  const codeNorm = c => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  async function kopplungLesen(text, code) {
    let j; try { j = JSON.parse(text); } catch (e) { throw new Error('Keine Kopplungsdatei.'); }
    if (!j || j.format !== 'hausblick-handy-kopplung') throw new Error('Keine Kopplungsdatei.');
    if (j.version === 1) throw new Error('Alte Kopplungsdatei – am PC neu koppeln.');
    if (j.version !== 2 || !j.kdf || j.kdf.iterations !== KOPPEL_ITER || typeof j.kdf.salz !== 'string' || typeof j.iv !== 'string' || typeof j.daten !== 'string') throw new Error('Keine Kopplungsdatei.');
    const c = codeNorm(code); if (c.length !== 12) throw new Error('Code: 12 Zeichen vom PC-Bildschirm.');
    const enc = new TextEncoder(), basis = await crypto.subtle.importKey('raw', enc.encode(c), 'PBKDF2', false, ['deriveKey']);
    const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: ausB64(j.kdf.salz), iterations: KOPPEL_ITER }, basis, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    let klar; try { klar = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ausB64(j.iv), additionalData: enc.encode(KOPPEL_AAD) }, k, ausB64(j.daten)); } catch (e) { throw new Error('Code falsch.'); }
    return kopplungAus(JSON.parse(new TextDecoder().decode(klar)));
  }
  async function koppeln(code) {
    const k = await kopplungLesen(S.koppelText, code);
    S.kopplung = k; S.koppelText = null; await schreib('kopplung', k).catch(() => {});
    toast(`Gekoppelt · ${k.raeume.length} Orte`);
    senden();
  }

  // ---------- Foto verkleinern (wie AndyCare: längste Kante 1600 px, JPEG) ----------
  function fotoLesen(datei) {
    return new Promise((ok, fehl) => {
      const u = URL.createObjectURL(datei), img = new Image();
      img.onload = () => {
        const f = Math.min(1, KANTE / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * f)); c.height = Math.max(1, Math.round(img.naturalHeight * f));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
        ok({ url: c.toDataURL('image/jpeg', QUALITAET), w: c.width, h: c.height }); c.width = 0; c.height = 0;
      };
      img.onerror = () => { URL.revokeObjectURL(u); fehl(new Error('Foto nicht lesbar')); };
      img.src = u;
    });
  }

  // ---------- Markierung (Pfeil, Kreis) – gleiche Daten und gleiche Darstellung wie AndyCare (U-28) ----------
  function formenSVG(m) {
    const s = Math.max(m.w, m.h), sw = Math.max(2, s * 0.012), f = n => Math.round(n * 10) / 10;
    return m.formen.map(x => {
      if (x.art === 'kreis') { const cx = f(x.x * m.w), cy = f(x.y * m.h), r = f(x.r * m.w); return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff" stroke-width="${f(sw * 2)}"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#d62d20" stroke-width="${f(sw)}"/>`; }
      const x1 = x.x * m.w, y1 = x.y * m.h, x2 = x.x2 * m.w, y2 = x.y2 * m.h, a = Math.atan2(y2 - y1, x2 - x1), k = sw * 4.5;
      const sp = `${f(x2)},${f(y2)} ${f(x2 - k * Math.cos(a - 0.45))},${f(y2 - k * Math.sin(a - 0.45))} ${f(x2 - k * Math.cos(a + 0.45))},${f(y2 - k * Math.sin(a + 0.45))}`;
      const lx = x2 - k * 0.7 * Math.cos(a), ly = y2 - k * 0.7 * Math.sin(a);
      return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(lx)}" y2="${f(ly)}" stroke="#fff" stroke-width="${f(sw * 2)}" stroke-linecap="round"/><polygon points="${sp}" fill="#d62d20" stroke="#fff" stroke-width="${f(sw * 0.6)}"/><line x1="${f(x1)}" y1="${f(y1)}" x2="${f(lx)}" y2="${f(ly)}" stroke="#d62d20" stroke-width="${f(sw)}" stroke-linecap="round"/>`;
    }).join('');
  }
  const fotoSVG = (f, m) => `<svg viewBox="0 0 ${f.w} ${f.h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><image href="${f.url}" width="${f.w}" height="${f.h}"/>${m && m.formen.length ? formenSVG(m) : ''}</svg>`;

  // ---------- Erfassen ----------
  const ortOk = c => !!(c.code || c.ortText.trim().length > 1);
  const fertig = c => ortOk(c) && c.text.trim().length > 0 && !!c.zust;
  const raum = code => S.kopplung && S.kopplung.raeume.find(r => r[0] === code);
  function treffer(q) {
    const n = norm(q).trim(); if (n.length < 2 || !S.kopplung) return [];
    return S.kopplung.raeume.filter(r => norm(r[0]).includes(n) || norm(r[1]).includes(n)).slice(0, 8);
  }
  async function bestaetigen() {
    const c = S.cap; if (!fertig(c)) return;
    // je Problem ein eigener Eintrag (eigenes Ticket in AndyCare), gleich ins Postfach
    S.eintraege.unshift({ hid: hex(crypto.getRandomValues(new Uint8Array(10))), d: new Date().toISOString(), text: c.text.trim().slice(0, 2000), code: c.code,
      ortText: c.code ? null : c.ortText.trim().slice(0, 120), zust: c.zust, typ: 'Mangel', fotos: c.fotos, marken: c.marken, status: 'wartet' });
    await sichern();
    S.cap = leer(); S.q = ''; window.scrollTo(0, 0); zeichnen();
    const n = S.kopplung.postfach ? await senden() : 0;
    toast(n ? 'Gesendet' : S.kopplung.postfach ? 'Gespeichert – wird gesendet, sobald Netz da ist' : 'Gespeichert – unter ⋯ als Datei übergeben');
  }
  const wartend = () => S.eintraege.filter(e => e.status === 'wartet').length;

  // ---------- Verschlüsseln: ein Paket mit Einträgen (gleiches Format für Postfach und Datei) ----------
  async function paketInhalt(liste, jetzt) {
    const k = S.kopplung, enc = new TextEncoder();
    const klar = enc.encode(JSON.stringify({ fassung: FASSUNG, eintraege: liste.map(e => ({ hid: e.hid, d: e.d, text: e.text, code: e.code, ortText: e.ortText, zust: e.zust, typ: e.typ, fotos: e.fotos.map(f => f.url), marken: e.marken })) }));
    const schl = await crypto.subtle.importKey('raw', ausB64(k.schluessel), 'AES-GCM', false, ['encrypt']), iv = crypto.getRandomValues(new Uint8Array(12));
    const daten = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(k.kennung) }, schl, klar));
    return JSON.stringify({ format: 'hausblick-handy-uebergabe', version: 1, kennung: k.kennung, erstellt: (jetzt || new Date()).toISOString(), anzahl: liste.length, iv: b64(iv), daten: b64(daten) });
  }
  // Übergabe an den PC per Datei: alle Einträge auf dem Handy
  const dateiInhalt = jetzt => paketInhalt(S.eintraege, jetzt);

  // ---------- Postfach (1.3.1, U-38): jeden wartenden Eintrag einzeln verschlüsselt ablegen; ohne Netz beim nächsten Mal ----------
  // Seit 1.3.1-dev.6: mit Schreibzugang; 409 = liegt schon dort bzw. schon abgeholt (gilt als gesendet). Gesendetes bleibt
  // auf dem Handy, bis die Quittung von AndyCare da ist (abgleich).
  let sendet = null;
  const zugang = k => ({ Authorization: 'Bearer ' + k.postfach.schreib });
  function senden() {
    if (sendet) return sendet;
    sendet = (async () => {
      const k = S.kopplung; let n = 0;
      if (!k || !k.postfach) return 0;
      for (const e of S.eintraege.filter(x => x.status === 'wartet')) {
        try {
          const r = await fetch(`${k.postfach.url}/p/${k.postfach.id}/${e.hid}`, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, zugang(k)), body: await paketInhalt([e]), cache: 'no-store' });
          if (!r.ok && r.status !== 409) { if (r.status === 401 || r.status === 403) S.fehler = 'Postfach lehnt ab – am PC neu koppeln.'; break; }
          e.status = 'gesendet'; e.gesendet = new Date().toISOString(); n++;
        } catch (err) { break; }   // kein Netz: später erneut
      }
      if (n) { S.fehler = ''; await sichern(); zeichnen(); }
      await abgleich();
      return n;
    })().finally(() => { sendet = null; });
    return sendet;
  }
  // Quittungen holen: von AndyCare Übernommenes vom Handy löschen; Gesendetes ohne Quittung, das nicht mehr im Postfach liegt
  // (verfallen oder entfernt), wird wieder „wartet“ und neu gesendet. Ergebnis: Anzahl gelöschter Einträge.
  async function abgleich() {
    const k = S.kopplung;
    if (!k || !k.postfach || !S.eintraege.some(e => e.status === 'gesendet')) return 0;
    let j; try { const r = await fetch(`${k.postfach.url}/q/${k.postfach.id}`, { headers: zugang(k), cache: 'no-store' }); if (!r.ok) return 0; j = await r.json(); } catch (e) { return 0; }
    const q = new Set(Array.isArray(j.quittiert) ? j.quittiert : []), da = new Set(Array.isArray(j.vorhanden) ? j.vorhanden : []), grenze = Date.now() - NACH_MIN * 60000;
    let weg = 0, neu = 0;
    S.eintraege = S.eintraege.filter(e => {
      if (e.status !== 'gesendet') return true;
      if (q.has(e.hid)) { weg++; return false; }
      if (!da.has(e.hid) && new Date(e.gesendet || 0).getTime() < grenze) { e.status = 'wartet'; neu++; }
      return true;
    });
    if (weg || neu) { await sichern(); zeichnen(); }
    if (neu) setTimeout(() => senden(), 0);
    return weg;
  }
  const tageOffen = e => Math.floor((Date.now() - new Date(e.gesendet || e.d).getTime()) / 86400000);
  async function uebergeben() {
    if (!S.eintraege.length || !S.kopplung) return;
    const j = new Date(), name = `AndyCare_Handy_${j.getFullYear()}-${zwei(j.getMonth() + 1)}-${zwei(j.getDate())}_${zwei(j.getHours())}${zwei(j.getMinutes())}.hbhandy`;
    const datei = new File([await dateiInhalt(j)], name, { type: 'application/json' });
    let geteilt = false;
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [datei] })) {
      try { await navigator.share({ files: [datei], title: 'AndyCare' }); geteilt = true; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    if (!geteilt) { const u = URL.createObjectURL(datei), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); }
    S.eintraege.forEach(e => { if (e.status === 'wartet') e.status = 'uebergeben'; e.uebergeben = j.toISOString(); });
    await sichern(); zeichnen();
    toast(geteilt ? 'Übergabedatei geteilt' : 'Übergabedatei gespeichert (Downloads)');
  }
  // nur per Datei Übergebenes; Gesendetes verschwindet erst mit der Quittung von AndyCare
  async function loeschen() {
    if (!S.loeschFrage) { S.loeschFrage = true; zeichnen(); return; }
    S.eintraege = S.eintraege.filter(e => e.status !== 'uebergeben'); S.loeschFrage = false;
    await sichern(); zeichnen(); toast('Übergebene Einträge vom Handy gelöscht');
  }

  // ---------- Anzeige ----------
  const chip = (act, k, l, an, extra) => `<button type="button" class="chip${an ? ' on' : ''}${extra || ''}" data-act="${act}" data-k="${esc(k)}" aria-pressed="${!!an}">${esc(l)}</button>`;
  function erfassenHTML() {
    const c = S.cap, r = c.code && raum(c.code);
    const ort = r ? `<div class="ort"><span><b>${esc(r[1])}</b><small>${esc(r[0])}${r[2] ? ' · ' + esc(r[2]) : ''}${r[3] ? ' · ' + esc(r[3]) : ''}</small></span><button type="button" data-act="ort-x" aria-label="Ort ändern">×</button></div>`
      : c.ortText ? `<div class="ort"><span><b>${esc(c.ortText)}</b><small>Ort noch zu klären</small></span><button type="button" data-act="ort-x" aria-label="Ort ändern">×</button></div>`
      : `<input type="search" id="q" value="${esc(S.q)}" placeholder="Raum, Code oder Ort" autocomplete="off" enterkeyhint="search">
        <div id="treffer">${trefferHTML()}</div>`;
    return `<div class="feld"><span class="lbl">Foto</span><small class="hinweis">Keine Personen, keine Namen fotografieren.</small>
        <label class="btn voll"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg> Foto aufnehmen<input type="file" id="foto" accept="image/*" capture="environment" hidden></label>
        ${c.fotos.length ? `<div class="fotos">${c.fotos.map((f, i) => `<div class="foto">${fotoSVG(f, c.marken[i])}<button type="button" class="mk" data-act="mk" data-k="${i}">Markieren</button><button type="button" class="x" data-act="foto-x" data-k="${i}" aria-label="Foto entfernen">×</button></div>`).join('')}</div>` : ''}</div>
      <div class="feld"><span class="lbl">Ort</span>${ort}</div>
      <label class="feld"><span class="lbl">Beschreibung</span><textarea id="text" maxlength="2000" placeholder="Was ist kaputt?">${esc(c.text)}</textarea></label>
      <div class="feld"><span class="lbl">Zuständig</span><div class="chips">${ZUST.map(([k, l]) => chip('zust', k, l, c.zust === k)).join('')}</div></div>
      <div class="fuss"><div class="innen"><button type="button" class="btn primary" data-act="ok" ${fertig(c) ? '' : 'disabled'}>✓ Bestätigen</button></div></div>`;
  }
  function trefferHTML() {
    const l = treffer(S.q);
    if (!S.q.trim() || S.q.trim().length < 2) return '';
    return `<ul class="treffer">${l.map(r => `<li><button type="button" data-act="ort" data-k="${esc(r[0])}">${esc(r[1])}<small>${esc(r[0])}${r[2] ? ' · ' + esc(r[2]) : ''}</small></button></li>`).join('')}
      <li><button type="button" data-act="ort-frei">„${esc(S.q.trim())}“ als Ort verwenden<small>Ort noch zu klären</small></button></li></ul>`;
  }
  // „⋯“ (1.3.1-dev.3): Noch nicht Gesendetes (nur ohne Netz bzw. ohne Postfach), Datei als Rückfall, Kopplung
  function uebergabeHTML() {
    const n = S.eintraege.length, ueb = S.eintraege.filter(e => e.status === 'uebergeben').length, pf = !!S.kopplung.postfach;
    const ortT = e => { const r = e.code && raum(e.code); return r ? `${r[1]} (${r[0]})` : e.ortText || ''; };
    // gesendet, aber noch nicht von AndyCare abgeholt: ab 3 Tagen als Warnung
    const st = e => e.status === 'uebergeben' ? ' · <span class="st-ok">übergeben</span>'
      : e.status === 'gesendet' ? (tageOffen(e) >= 3 ? ` · <span class="st-warn">seit ${tageOffen(e)} Tagen nicht abgeholt</span>` : ' · gesendet') : pf ? ' · noch nicht gesendet' : '';
    return `${S.fehler ? `<p role="alert" class="fehler">${esc(S.fehler)}</p>` : ''}${n ? `<ul class="liste">${S.eintraege.map(e => `<li><b>${esc(e.text.split(/[.,!]/)[0].slice(0, 70))}</b><small>${esc(ortT(e))} · ${esc(datum(new Date(e.d)))}${st(e)}</small></li>`).join('')}</ul>
        ${pf && wartend() ? '<button type="button" class="btn primary voll abstand" data-act="nachsenden">Jetzt senden</button>' : ''}
        <button type="button" class="btn voll abstand" data-act="uebergeben">Als Datei übergeben</button>` : '<p class="leer">Alles gesendet.</p>'}
      ${ueb ? `<button type="button" class="btn voll abstand" data-act="loeschen">${S.loeschFrage ? 'Wirklich vom Handy löschen?' : `Übergebene löschen (${ueb})`}</button>` : ''}
      <div class="karte"><b>Kopplung</b><small>${S.kopplung.raeume.length} Orte · AndyCare ${esc(FASSUNG)}</small>
        <label class="btn voll abstand">Neue Kopplungsdatei<input type="file" id="kopplung" accept=".json,application/json" hidden></label></div>
      <div class="fuss"><div class="innen"><button type="button" class="btn" data-act="zurueck">Zurück</button></div></div>`;
  }
  function koppelnHTML() {
    const f = S.fehler ? `<p role="alert" class="fehler">${esc(S.fehler)}</p>` : '';
    // Schritt 2: Code vom PC-Bildschirm (Datei allein genügt nicht)
    if (S.koppelText) return `<div class="karte"><b>Code eingeben</b><small>Steht am PC unter Einstellungen → Handy.</small>
      <input type="text" id="code" class="code abstand" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" placeholder="XXXX-XXXX-XXXX">
      <button type="button" class="btn primary voll abstand" data-act="koppeln">Koppeln</button>
      <button type="button" class="btn voll abstand" data-act="koppeln-x">Abbrechen</button></div>${f}`;
    return `<div class="karte"><b>Noch nicht gekoppelt</b><small>Kopplungsdatei aus AndyCare wählen.</small>
      <label class="btn primary voll abstand">Kopplungsdatei wählen<input type="file" id="kopplung" accept=".json,application/json" hidden></label></div>${f}`;
  }
  function mkHTML() {
    const m = S.mk, f = S.cap.fotos[m.i], mk = { w: f.w, h: f.h, formen: m.formen.concat(m.vorschau ? [m.vorschau] : []) };
    return `<div class="mk-voll" role="dialog" aria-label="Markieren"><div class="bild"><svg id="mkSvg" viewBox="0 0 ${f.w} ${f.h}"><image href="${f.url}" width="${f.w}" height="${f.h}"/><g id="mkG">${formenSVG(mk)}</g></svg></div>
      <div class="leiste">${chip('mk-art', 'pfeil', 'Pfeil', m.art === 'pfeil')}${chip('mk-art', 'kreis', 'Kreis', m.art === 'kreis')}<button type="button" class="chip" data-act="mk-zurueck">Zurück</button><button type="button" class="chip on" data-act="mk-fertig">Fertig</button></div></div>`;
  }
  function zeichnen() {
    const app = document.getElementById('app'); if (!app) return;
    const kopf = `<header class="kopf"><h1>${S.ansicht === 'uebergabe' ? 'Weitere' : 'Mangel erfassen'}</h1>${S.kopplung && S.ansicht !== 'uebergabe' ? '<button type="button" class="mehr" data-act="liste" aria-label="Weitere: Übergabe und Kopplung">⋯</button>' : ''}</header>`;
    app.innerHTML = kopf + (!S.kopplung || S.koppelText ? koppelnHTML() : S.ansicht === 'uebergabe' ? uebergabeHTML() : erfassenHTML()) + (S.mk ? mkHTML() : '');
    if (S.mk) mkZiehen();
  }
  // nur die Trefferliste und den Knopf neu zeichnen, damit das Feld beim Tippen den Fokus behält
  function teilweise() {
    const t = document.getElementById('treffer'); if (t) t.innerHTML = trefferHTML();
    const ok = document.querySelector('[data-act=ok]'); if (ok) ok.disabled = !fertig(S.cap);
  }

  // ---------- Markieren: Ziehen auf dem Foto ----------
  function mkZiehen() {
    const svg = document.getElementById('mkSvg'); if (!svg || !svg.getScreenCTM) return;
    const f = S.cap.fotos[S.mk.i];
    const punkt = ev => { const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; const q = p.matrixTransform(svg.getScreenCTM().inverse()); return { x: Math.min(1, Math.max(0, q.x / f.w)), y: Math.min(1, Math.max(0, q.y / f.h)) }; };
    const form = (a, b) => S.mk.art === 'kreis' ? { art: 'kreis', x: a.x, y: a.y, r: Math.max(0.02, Math.hypot((b.x - a.x) * f.w, (b.y - a.y) * f.h) / f.w) } : { art: 'pfeil', x: a.x, y: a.y, x2: b.x, y2: b.y };
    const neuG = () => { const g = document.getElementById('mkG'); if (g) g.innerHTML = formenSVG({ w: f.w, h: f.h, formen: S.mk.formen.concat(S.mk.vorschau ? [S.mk.vorschau] : []) }); };
    let start = null;
    svg.addEventListener('pointerdown', ev => { ev.preventDefault(); start = punkt(ev); svg.setPointerCapture && svg.setPointerCapture(ev.pointerId); });
    svg.addEventListener('pointermove', ev => { if (!start) return; S.mk.vorschau = form(start, punkt(ev)); neuG(); });
    svg.addEventListener('pointerup', ev => {
      if (!start) return; const b = punkt(ev), lang = Math.hypot((b.x - start.x) * f.w, (b.y - start.y) * f.h) > Math.max(f.w, f.h) * 0.03;
      if (lang && S.mk.formen.length < 20) S.mk.formen.push(form(start, b));
      start = null; S.mk.vorschau = null; neuG();
    });
  }

  // ---------- Bedienung ----------
  const A = {
    ok: bestaetigen, liste: () => { S.ansicht = 'uebergabe'; S.loeschFrage = false; zeichnen(); }, zurueck: () => { S.ansicht = 'erfassen'; zeichnen(); },
    uebergeben: () => uebergeben().catch(e => toast('Übergabe nicht möglich: ' + (e && e.message || e))), loeschen,
    zust: el => { S.cap.zust = el.dataset.k; zeichnen(); },
    nachsenden: async () => { const n = await senden(); toast(n ? `${n} gesendet` : 'Kein Netz – später erneut'); zeichnen(); },
    koppeln: async () => {
      const c = document.getElementById('code');
      try { await koppeln(c && c.value); S.fehler = ''; S.ansicht = 'erfassen'; } catch (e) { S.fehler = e.message; toast(e.message); }
      zeichnen();
    },
    'koppeln-x': () => { S.koppelText = null; S.fehler = ''; zeichnen(); },
    ort: el => { S.cap.code = el.dataset.k; S.cap.ortText = ''; S.q = ''; zeichnen(); }, 'ort-frei': () => { S.cap.code = null; S.cap.ortText = S.q.trim(); S.q = ''; zeichnen(); },
    'ort-x': () => { S.cap.code = null; S.cap.ortText = ''; zeichnen(); const q = document.getElementById('q'); if (q) q.focus(); },
    'foto-x': el => { const i = +el.dataset.k; S.cap.fotos.splice(i, 1); S.cap.marken.splice(i, 1); zeichnen(); },
    mk: el => { const i = +el.dataset.k, m = S.cap.marken[i]; S.mk = { i, art: 'pfeil', formen: m ? m.formen.slice() : [], vorschau: null }; zeichnen(); },
    'mk-art': el => { S.mk.art = el.dataset.k; zeichnen(); }, 'mk-zurueck': () => { S.mk.formen.pop(); zeichnen(); },
    'mk-fertig': () => { const f = S.cap.fotos[S.mk.i]; S.cap.marken[S.mk.i] = S.mk.formen.length ? { w: f.w, h: f.h, formen: S.mk.formen } : null; S.mk = null; zeichnen(); }
  };
  document.addEventListener('click', ev => { const el = ev.target.closest && ev.target.closest('[data-act]'); if (!el || el.disabled || !Object.prototype.hasOwnProperty.call(A, el.dataset.act)) return; ev.preventDefault(); A[el.dataset.act](el); });
  document.addEventListener('input', ev => {
    if (ev.target.id === 'q') { S.q = ev.target.value; teilweise(); }
    else if (ev.target.id === 'text') { S.cap.text = ev.target.value; teilweise(); }
  });
  document.addEventListener('change', async ev => {
    const el = ev.target;
    if (el.id === 'kopplung' && el.files && el.files[0]) {
      try { const t = await el.files[0].text(); if (t.length > 2e6) throw new Error('Keine Kopplungsdatei.'); S.koppelText = t; S.fehler = ''; } catch (e) { S.fehler = e.message; toast(e.message); }
      zeichnen(); const c = document.getElementById('code'); if (c && c.focus) c.focus();
    } else if (el.id === 'foto' && el.files) {
      const l = Array.from(el.files).slice(0, FOTOS_MAX - S.cap.fotos.length);
      for (const d of l) { try { S.cap.fotos.push(await fotoLesen(d)); S.cap.marken.push(null); } catch (e) { toast(e.message); } }
      if (el.files.length > l.length) toast(`Höchstens ${FOTOS_MAX} Fotos`);
      zeichnen();
    }
  });

  // ---------- Start ----------
  async function start() {
    try { S.kopplung = (await lies('kopplung')) || null; S.eintraege = (await lies('eintraege')) || []; } catch (e) { toast('Achtung: Speicher nicht verfügbar – nur bis zum Schließen'); }
    zeichnen();
    // Wartendes ins Postfach nachsenden: beim Öffnen und sobald wieder Netz da ist
    senden(); window.addEventListener('online', () => senden());
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.AndyCareHandy = { S, kopplungAus, kopplungLesen, koppeln, dateiInhalt, paketInhalt, senden, abgleich, loeschen, bestaetigen, formenSVG, treffer, zeichnen, start: () => start() };
  if (!window.HAUSBLICK_HANDY_TEST) start();
})();
