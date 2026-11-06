// AndyCare – Kilometerstand per QR-Code durch die Fahrer (1.4.0-dev.17, U-63 Block 2, E-103; Konzept und Bauplan
// Update/Konzept_Fuhrpark_QR_Kilometer_2026-11-05.md). Aufkleber an der Fahrer-Sonnenblende: km.html#<Geheimnis>.<Busname>.
// Der Fahrer gibt den gemeinsamen Code (Vorgabe der IT) und den km-Stand ein. Aus Geheimnis und Code entstehen per
// HKDF-SHA-256 Postfach-Kennung, Schreibzugang und Schlüssel. Der Code steht weder hier noch auf dem Aufkleber noch im Paket;
// ein falscher Code führt auf ein Postfach, das es nicht gibt (401 → „Code falsch“). Das Postfach (Worker Fassung 3, „klein“)
// bestimmt den Bus, nicht der Inhalt. „Gesendet“ nur nach Antwort 201 oder 409; 410 = Aufkleber ersetzt.
// Keine Installation, kein Service Worker, keine Namen, keine Uhrzeit im Paket. Ein nicht gesendeter Stand bleibt ohne
// Geheimnis und ohne Code im Speicher der Seite, soweit der Browser ihn behält, und wird beim nächsten Scan vorbelegt.
(function () {
  'use strict';
  const FASSUNG = '1.4.0-dev.18';
  let POSTFACH_URL = 'https://hausblick-postfach.k2cnzmm9ws.workers.dev';   // Cloudflare, Konto Philipp (wie handy.js)
  const KM_MAX = 2000000, ZURUECK_TAGE = 14, SPEICHER = 'andycare-km-offen', OFFEN_MAX = 10;
  const GEHEIM = /^[A-Za-z0-9_-]{43}$/, HID = /^[0-9a-f]{20}$/;
  // Bildmarke „Grundriss“ wie handy.js und App.logoMarke (E-91, E-94)
  const LOGO = '<svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><path d="M18 45H3V3H45V45H30M3 27H9M15 27H21V3" fill="none" stroke="#1F4FA3" stroke-width="3"/><path d="M27 24A6 6 0 1 0 39 24A6 6 0 1 0 27 24Z" fill="#1F4FA3"/></svg>';
  const S = { zustand: 'start', bus: '', geheim: null, fp: null, code: '', km: '', datum: '', fehler: {}, meldung: '', offen: null, offenAlt: false, gesendet: null };

  // ---------- Hilfen ----------
  const enc = s => new TextEncoder().encode(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
  const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const b64url = u8 => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const ausB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  const zwei = n => String(n).padStart(2, '0');
  const heute = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  const plusTage = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const iso = d => `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`;
  const tag = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); if (!m) return null; const d = new Date(+m[1], +m[2] - 1, +m[3]); return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null; };
  const deutsch = s => { const d = tag(s); return d ? `${zwei(d.getDate())}.${zwei(d.getMonth() + 1)}.${d.getFullYear()}` : ''; };
  const kmText = n => Number(n).toLocaleString('de-DE');

  // ---------- Aufkleber und Ableitung ----------
  // Teil hinter „#“: <Geheimnis (32 Byte, base64url)>.<Busname (nur zur Anzeige)>
  function ausAdresse(hash) {
    const h = String(hash || '').replace(/^#/, ''), i = h.indexOf('.'), geheim = i < 0 ? h : h.slice(0, i);
    if (!GEHEIM.test(geheim)) return null;
    let bus = ''; try { bus = decodeURIComponent(i < 0 ? '' : h.slice(i + 1)); } catch (e) { bus = ''; }
    bus = bus.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
    return { geheim, bus: bus || 'Bus' };
  }
  // dieselbe Ableitung macht AndyCare am PC beim Einrichten des Postfachs (Block 3)
  async function ableiten(geheim, code) {
    const ikm = await crypto.subtle.importKey('raw', ausB64url(geheim), 'HKDF', false, ['deriveBits']), salt = enc('andycare-km-v1:' + code);
    const bits = async (info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc(info) }, ikm, n * 8));
    return { postfach: hex(await bits('postfach', 16)), schreib: b64url(await bits('schreib', 32)), schluessel: await bits('schluessel', 32) };
  }
  // Paket wie bei den Mängeln, aber ohne „erstellt“ und ohne Kennung: nur Stand, Tag und Zufallskennung, gebunden an das Postfach
  async function paket(a, e) {
    const k = await crypto.subtle.importKey('raw', a.schluessel, 'AES-GCM', false, ['encrypt']), iv = crypto.getRandomValues(new Uint8Array(12));
    const klar = enc(JSON.stringify({ art: 'km', fassung: FASSUNG, hid: e.hid, km: e.km, datum: e.datum }));
    const daten = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc(a.postfach) }, k, klar));
    return JSON.stringify({ format: 'hausblick-handy-uebergabe', version: 1, art: 'km', iv: b64(iv), daten: b64(daten) });
  }

  // ---------- Prüfen ----------
  function pruefen(x) {
    const f = {}, km = String(x.km || '').replace(/[\s.]/g, ''), d = tag(x.datum), h = heute();
    if (!/^\d{4}$/.test(String(x.code || ''))) f.code = 'Code: 4 Ziffern';
    if (!km) f.km = 'Kilometerstand fehlt';
    else if (!/^\d{1,7}$/.test(km) || +km > KM_MAX) f.km = 'Nur Ziffern, z. B. 123456';
    if (!d) f.datum = 'Datum fehlt';
    else if (d > h) f.datum = 'Datum liegt in der Zukunft';
    else if (d < plusTage(h, -ZURUECK_TAGE)) f.datum = 'Höchstens 14 Tage zurück';
    return Object.keys(f).length ? { fehler: f } : { km: +km, datum: iso(d) };
  }

  // ---------- Speicher der Seite: nur Nichtgesendetes, ohne Geheimnis und ohne Code ----------
  const fpVon = async geheim => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc('andycare-km-fp:' + geheim)))).slice(0, 16);
  function offenLesen() { try { const j = JSON.parse(localStorage.getItem(SPEICHER) || '{}'); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { return {}; } }
  function offenSchreiben(o) { try { localStorage.setItem(SPEICHER, JSON.stringify(o)); } catch (e) { /* ohne Speicher nur bis zum Schließen */ } }
  function merken(e) { const o = offenLesen(); delete o[S.fp]; o[S.fp] = { hid: e.hid, km: e.km, datum: e.datum }; const k = Object.keys(o); while (k.length > OFFEN_MAX) delete o[k.shift()]; offenSchreiben(o); }
  function vergessen() { const o = offenLesen(); if (S.fp in o) { delete o[S.fp]; offenSchreiben(o); } }
  const offenGueltig = o => !!o && HID.test(String(o.hid || '')) && Number.isInteger(o.km) && o.km >= 0 && o.km <= KM_MAX && !!tag(o.datum)
    && tag(o.datum) <= heute() && tag(o.datum) >= plusTage(heute(), -ZURUECK_TAGE);

  // ---------- Senden ----------
  let sendet = false;
  async function senden() {
    if (sendet || S.zustand !== 'eingabe') return 0;
    const w = pruefen(S); S.meldung = '';
    if (w.fehler) { S.fehler = w.fehler; zeichnen(Object.keys(w.fehler)[0]); return 0; }
    S.fehler = {};
    // gleicher Stand wie der nicht gesendete: gleiche Kennung, damit er nie doppelt ankommt (409 = liegt schon dort)
    const e = S.offen && S.offen.km === w.km && S.offen.datum === w.datum ? S.offen : { hid: hex(crypto.getRandomValues(new Uint8Array(10))), km: w.km, datum: w.datum };
    S.offen = e; merken(e);
    sendet = true; zeichnen();
    let st = 0;
    try {
      const a = await ableiten(S.geheim, S.code);
      const r = await fetch(`${POSTFACH_URL}/p/${a.postfach}/${e.hid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + a.schreib }, body: await paket(a, e), cache: 'no-store' });
      st = r.status;
    } catch (err) { st = 0; }   // kein Netz
    sendet = false;
    if (st === 201 || st === 409) { vergessen(); S.offen = null; S.offenAlt = false; S.gesendet = e; S.code = ''; S.zustand = 'gesendet'; }
    else if (st === 401) S.fehler = { code: 'Code falsch' };
    else if (st === 410) { vergessen(); S.offen = null; S.code = ''; S.zustand = 'ersetzt'; }
    else S.meldung = 'nicht';
    zeichnen(st === 401 ? 'code' : null);
    return st;
  }

  // ---------- Anzeige ----------
  const statusHTML = (art, titel, text) => `<div class="status ${art}" role="status"><b>${esc(titel)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  function zeichnen(fokus) {
    const app = document.getElementById('app'); if (!app) return;
    const kopf = `<header class="kopf"><h1>${LOGO}AndyCareGo</h1></header>`, bus = `<p class="bus">Kilometerstand<b>${esc(S.bus)}</b></p>`;
    if (S.zustand === 'technik') { app.innerHTML = kopf + statusHTML('warn', 'Browser nicht geeignet', 'Bitte Andy fragen.'); return; }
    if (S.zustand === 'ungueltig') { app.innerHTML = kopf + statusHTML('warn', 'QR-Code ungültig', 'Bitte Andy fragen.'); return; }
    if (S.zustand === 'ersetzt') { app.innerHTML = kopf + bus + statusHTML('warn', 'Nicht mehr gültig', 'QR-Code oder Code geändert. Bitte Andy fragen.'); return; }
    if (S.zustand === 'gesendet') {
      app.innerHTML = kopf + bus + statusHTML('ok', '✓ Gesendet', `${kmText(S.gesendet.km)} km · ${deutsch(S.gesendet.datum)}`)
        + '<button type="button" class="btn voll abstand" data-act="neu">Neuer Stand</button>';
      return;
    }
    if (S.zustand !== 'eingabe') { app.innerHTML = kopf; return; }
    const f = S.fehler || {}, h = heute();
    const feld = (id, lbl, attr, wert) => `<label class="feld"><span class="lbl">${lbl}</span><input id="${id}" ${attr} value="${esc(wert)}"${f[id] ? ` aria-invalid="true" aria-describedby="${id}-f"` : ''}>${f[id] ? `<span class="fehler" id="${id}-f">${esc(f[id])}</span>` : ''}</label>`;
    app.innerHTML = kopf + bus + '<form id="form" novalidate>'
      + feld('code', 'Code', 'type="text" class="pin" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" autocapitalize="off" spellcheck="false"', S.code)
      + feld('km', 'Kilometerstand', 'type="text" class="km" inputmode="numeric" pattern="[0-9]*" maxlength="9" autocomplete="off"', S.km)
      + feld('datum', 'Datum', `type="date" min="${iso(plusTage(h, -ZURUECK_TAGE))}" max="${iso(h)}"`, S.datum)
      + (S.offen && S.offenAlt ? `<p class="offen">Noch nicht gesendet: ${esc(kmText(S.offen.km))} km</p>` : '')
      + '<p class="motor">Nur bei ausgeschaltetem Motor.</p>'
      + (S.meldung === 'nicht' ? statusHTML('warn', 'Nicht gesendet', 'Netz prüfen, dann erneut senden.') : '')
      + `<div class="fuss"><div class="innen"><button type="submit" class="btn primary" ${sendet ? 'disabled' : ''}>${sendet ? 'Wird gesendet …' : S.meldung === 'nicht' ? 'Nochmal senden' : 'Senden'}</button></div></div></form>`;
    if (fokus) { const i = document.getElementById(fokus); if (i && i.focus) i.focus(); }
  }

  // ---------- Bedienung ----------
  document.addEventListener('input', ev => {
    const t = ev.target; if (!t || !t.id) return;
    if (t.id === 'code') S.code = String(t.value).slice(0, 4); else if (t.id === 'km') S.km = String(t.value).slice(0, 9); else if (t.id === 'datum') S.datum = String(t.value);
  });
  document.addEventListener('submit', ev => { ev.preventDefault(); senden(); });
  document.addEventListener('click', ev => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (b && b.dataset.act === 'neu') { S.zustand = 'eingabe'; S.km = ''; S.datum = iso(heute()); S.fehler = {}; S.meldung = ''; zeichnen('code'); }
  });

  // ---------- Start ----------
  async function start() {
    S.datum = iso(heute());
    if (!(window.crypto && crypto.subtle && window.TextEncoder)) { S.zustand = 'technik'; zeichnen(); return; }
    const a = ausAdresse(location.hash);
    if (!a) { S.zustand = 'ungueltig'; zeichnen(); return; }
    // Vorschau am PC: Postfach-Stellvertreter nur, wenn die Seite selbst auf localhost läuft
    try { const p = new URLSearchParams(location.search || '').get('pf'); if (p && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^http:\/\/localhost:\d{2,5}$/.test(p)) POSTFACH_URL = p; } catch (e) { /* ohne Vorschau */ }
    S.geheim = a.geheim; S.bus = a.bus; S.fp = await fpVon(a.geheim);
    const o = offenLesen()[S.fp];
    if (offenGueltig(o)) { S.offen = { hid: o.hid, km: o.km, datum: o.datum }; S.offenAlt = true; S.km = String(o.km); S.datum = o.datum; } else if (o) vergessen();
    S.zustand = 'eingabe'; zeichnen('code');
    window.addEventListener('online', () => { if (S.meldung === 'nicht' && S.code) senden(); });
  }
  window.AndyCareKm = { S, ausAdresse, ableiten, paket, pruefen, senden, zeichnen, start: () => start(), get postfachUrl() { return POSTFACH_URL; } };
  if (!window.ANDYCARE_KM_TEST) start();
})();
