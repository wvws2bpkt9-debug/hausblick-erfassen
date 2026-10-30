// Hausblick Erfassen – Handyseite (1.3.1, U-37, E-87, Lösung C). Nur „Mangel erfassen“: Foto (mit Markieren), Ort, Beschreibung,
// Zuständigkeit, Gefährdung. „Bestätigen“ legt den Eintrag auf DIESEM Handy ab (IndexedDB, auch ohne Netz). „An PC übergeben“
// erzeugt eine verschlüsselte Datei (AES-GCM mit dem Schlüssel aus der Kopplungsdatei); Andy gibt sie selbst an den PC
// (Mail, Teams, USB), Hausblick liest sie unter Einträge → „Vom Handy“. Seit U-38 (Freigabe IT 30.10.2026): Mit Postfach in der
// Kopplungsdatei geht jeder bestätigte Eintrag gleich verschlüsselt ins Hausblick-Postfach (Cloudflare Worker, sieht nur
// verschlüsselte Daten); Hausblick holt ihn dort mit „Gemeldete Mängel abrufen“. Ohne Netz wird nachgesendet.
(function () {
  'use strict';
  const FASSUNG = '1.3.1';
  const S = { kopplung: null, eintraege: [], ansicht: 'erfassen', cap: null, q: '', mk: null, loeschFrage: false, fehler: '' };
  const leer = () => ({ fotos: [], marken: [], code: null, ortText: '', text: '', zust: null, typ: 'Mangel' });
  S.cap = leer();
  const ZUST = [['intern', 'Haustechnik'], ['TeDi', 'Technischer Dienst'], ['Firma', 'Firma'], ['offen', 'noch zu klären']];
  const FOTOS_MAX = 6, KANTE = 1600, QUALITAET = 0.82, B64 = /^[A-Za-z0-9+/]{43}=$/, KENNUNG = /^[0-9a-f]{12}$/;

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
  function kopplungAus(text) {
    let j; try { j = JSON.parse(text); } catch (e) { throw new Error('Keine Kopplungsdatei.'); }
    if (!j || j.format !== 'hausblick-handy-kopplung' || j.version !== 1 || !KENNUNG.test(j.kennung) || !B64.test(j.schluessel)) throw new Error('Keine Kopplungsdatei.');
    const raeume = (Array.isArray(j.raeume) ? j.raeume : []).slice(0, 5000).filter(r => Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string')
      .map(r => [r[0].slice(0, 40), r[1].slice(0, 120), String(r[2] || '').slice(0, 60), String(r[3] || '').slice(0, 60)]);
    // Postfach im Netz (1.3.1, U-38): nur eine Worker-Adresse (bzw. localhost für die Vorschau) und eine zufällige Kennung
    const p = j.postfach && typeof j.postfach === 'object' && /^(https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev|http:\/\/localhost:\d{2,5})$/.test(String(j.postfach.url || '')) && /^[0-9a-f]{32}$/.test(String(j.postfach.id || '')) ? { url: j.postfach.url, id: j.postfach.id } : null;
    return { kennung: j.kennung, schluessel: j.schluessel, postfach: p, raeume, erstellt: String(j.erstellt || '').slice(0, 30) };
  }
  async function koppeln(datei) {
    const k = kopplungAus(await datei.text());
    S.kopplung = k; await schreib('kopplung', k).catch(() => {});
    toast(`Gekoppelt · ${k.raeume.length} Orte`);
  }

  // ---------- Foto verkleinern (wie Hausblick: längste Kante 1600 px, JPEG) ----------
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

  // ---------- Markierung (Pfeil, Kreis) – gleiche Daten und gleiche Darstellung wie Hausblick (U-28) ----------
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
    S.eintraege.unshift({ hid: hex(crypto.getRandomValues(new Uint8Array(10))), d: new Date().toISOString(), text: c.text.trim().slice(0, 2000), code: c.code,
      ortText: c.code ? null : c.ortText.trim().slice(0, 120), zust: c.zust, typ: c.typ, fotos: c.fotos, marken: c.marken, status: 'wartet' });
    await sichern();
    S.cap = leer(); S.q = ''; window.scrollTo(0, 0); zeichnen();
    const n = S.kopplung.postfach ? await senden() : 0;
    toast(n ? 'Gesendet' : `Gespeichert · ${wartend()} ${wartend() === 1 ? 'wartet' : 'warten'} auf Übergabe`);
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
  let sendet = null;
  function senden() {
    if (sendet) return sendet;
    sendet = (async () => {
      const k = S.kopplung; let n = 0;
      if (!k || !k.postfach) return 0;
      for (const e of S.eintraege.filter(x => x.status === 'wartet')) {
        try {
          const r = await fetch(`${k.postfach.url}/p/${k.postfach.id}/${e.hid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: await paketInhalt([e]), cache: 'no-store' });
          if (!r.ok) break;
          e.status = 'gesendet'; e.gesendet = new Date().toISOString(); n++;
        } catch (err) { break; }   // kein Netz: später erneut
      }
      if (n) { await sichern(); zeichnen(); }
      return n;
    })().finally(() => { sendet = null; });
    return sendet;
  }
  async function uebergeben() {
    if (!S.eintraege.length || !S.kopplung) return;
    const j = new Date(), name = `Hausblick_Handy_${j.getFullYear()}-${zwei(j.getMonth() + 1)}-${zwei(j.getDate())}_${zwei(j.getHours())}${zwei(j.getMinutes())}.hbhandy`;
    const datei = new File([await dateiInhalt(j)], name, { type: 'application/json' });
    let geteilt = false;
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [datei] })) {
      try { await navigator.share({ files: [datei], title: 'Hausblick' }); geteilt = true; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    if (!geteilt) { const u = URL.createObjectURL(datei), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); }
    S.eintraege.forEach(e => { if (e.status === 'wartet') e.status = 'uebergeben'; e.uebergeben = j.toISOString(); });
    await sichern(); zeichnen();
    toast(geteilt ? 'Übergabedatei geteilt' : 'Übergabedatei gespeichert (Downloads)');
  }
  async function loeschen() {
    if (!S.loeschFrage) { S.loeschFrage = true; zeichnen(); return; }
    S.eintraege = S.eintraege.filter(e => e.status === 'wartet'); S.loeschFrage = false;
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
    return `<div class="feld"><span class="lbl">Foto</span>
        <label class="btn voll"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg> Foto aufnehmen<input type="file" id="foto" accept="image/*" capture="environment" hidden></label>
        ${c.fotos.length ? `<div class="fotos">${c.fotos.map((f, i) => `<div class="foto">${fotoSVG(f, c.marken[i])}<button type="button" class="mk" data-act="mk" data-k="${i}">Markieren</button><button type="button" class="x" data-act="foto-x" data-k="${i}" aria-label="Foto entfernen">×</button></div>`).join('')}</div>` : ''}</div>
      <div class="feld"><span class="lbl">Ort</span>${ort}</div>
      <label class="feld"><span class="lbl">Beschreibung</span><textarea id="text" maxlength="2000" placeholder="Was ist kaputt?">${esc(c.text)}</textarea></label>
      <div class="feld"><span class="lbl">Zuständig</span><div class="chips">${ZUST.map(([k, l]) => chip('zust', k, l, c.zust === k)).join('')}</div></div>
      <div class="feld"><div class="chips">${chip('gefahr', '', 'Gefährdung', c.typ === 'Gefährdung', ' gefahr')}</div></div>
      <div class="fuss"><div class="innen"><button type="button" class="btn primary" data-act="ok" ${fertig(c) ? '' : 'disabled'}>✓ Bestätigen</button></div></div>`;
  }
  function trefferHTML() {
    const l = treffer(S.q);
    if (!S.q.trim() || S.q.trim().length < 2) return '';
    return `<ul class="treffer">${l.map(r => `<li><button type="button" data-act="ort" data-k="${esc(r[0])}">${esc(r[1])}<small>${esc(r[0])}${r[2] ? ' · ' + esc(r[2]) : ''}</small></button></li>`).join('')}
      <li><button type="button" data-act="ort-frei">„${esc(S.q.trim())}“ als Ort verwenden<small>Ort noch zu klären</small></button></li></ul>`;
  }
  function uebergabeHTML() {
    const n = S.eintraege.length, ueb = S.eintraege.filter(e => e.status !== 'wartet').length;
    const ortT = e => { const r = e.code && raum(e.code); return r ? `${r[1]} (${r[0]})` : e.ortText || ''; };
    const st = { uebergeben: ' · <span class="st-ok">übergeben</span>', gesendet: ' · <span class="st-ok">gesendet</span>' };
    return `<ul class="liste">${n ? S.eintraege.map(e => `<li><b>${esc(e.text.split(/[.,!]/)[0].slice(0, 70))}</b><small>${esc(ortT(e))} · ${esc(datum(new Date(e.d)))}${st[e.status] || ''}</small></li>`).join('') : '<li class="leer">Keine Einträge auf dem Handy.</li>'}</ul>
      ${ueb ? `<button type="button" class="btn voll abstand" data-act="loeschen">${S.loeschFrage ? 'Wirklich vom Handy löschen?' : `Gesendete löschen (${ueb})`}</button>` : ''}
      <div class="karte"><b>Kopplung</b><small>${S.kopplung.raeume.length} Orte · Hausblick ${esc(FASSUNG)}</small>
        <label class="btn voll abstand">Neue Kopplungsdatei<input type="file" id="kopplung" accept=".json,application/json" hidden></label></div>
      <div class="fuss"><div class="innen"><button type="button" class="btn" data-act="zurueck">Zurück</button><button type="button" class="btn primary" data-act="uebergeben" ${n ? '' : 'disabled'}>An PC übergeben</button></div></div>`;
  }
  function koppelnHTML() {
    return `<div class="karte"><b>Noch nicht gekoppelt</b><small>Kopplungsdatei aus Hausblick wählen.</small>
      <label class="btn primary voll abstand">Kopplungsdatei wählen<input type="file" id="kopplung" accept=".json,application/json" hidden></label></div>
      ${S.fehler ? `<p role="alert" class="fehler">${esc(S.fehler)}</p>` : ''}`;
  }
  function mkHTML() {
    const m = S.mk, f = S.cap.fotos[m.i], mk = { w: f.w, h: f.h, formen: m.formen.concat(m.vorschau ? [m.vorschau] : []) };
    return `<div class="mk-voll" role="dialog" aria-label="Markieren"><div class="bild"><svg id="mkSvg" viewBox="0 0 ${f.w} ${f.h}"><image href="${f.url}" width="${f.w}" height="${f.h}"/><g id="mkG">${formenSVG(mk)}</g></svg></div>
      <div class="leiste">${chip('mk-art', 'pfeil', 'Pfeil', m.art === 'pfeil')}${chip('mk-art', 'kreis', 'Kreis', m.art === 'kreis')}<button type="button" class="chip" data-act="mk-zurueck">Zurück</button><button type="button" class="chip on" data-act="mk-fertig">Fertig</button></div></div>`;
  }
  function zeichnen() {
    const app = document.getElementById('app'); if (!app) return;
    const n = wartend();
    const kopf = `<header class="kopf"><h1>${S.ansicht === 'uebergabe' ? 'An PC übergeben' : 'Mangel erfassen'}</h1>${S.kopplung && S.ansicht !== 'uebergabe' ? `<button type="button" class="zaehler" data-act="liste" data-n="${S.eintraege.length}" aria-label="${n} warten auf Übergabe">${n} ${n === 1 ? 'wartet' : 'warten'}</button>` : ''}</header>`;
    app.innerHTML = kopf + (!S.kopplung ? koppelnHTML() : S.ansicht === 'uebergabe' ? uebergabeHTML() : erfassenHTML()) + (S.mk ? mkHTML() : '');
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
    zust: el => { S.cap.zust = el.dataset.k; zeichnen(); }, gefahr: () => { S.cap.typ = S.cap.typ === 'Gefährdung' ? 'Mangel' : 'Gefährdung'; zeichnen(); },
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
      try { await koppeln(el.files[0]); S.fehler = ''; S.ansicht = 'erfassen'; } catch (e) { S.fehler = e.message; toast(e.message); }
      zeichnen();
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
  window.HausblickHandy = { S, kopplungAus, dateiInhalt, paketInhalt, senden, bestaetigen, formenSVG, treffer, zeichnen, start: () => start() };
  if (!window.HAUSBLICK_HANDY_TEST) start();
})();
