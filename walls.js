/* walls.js — click-to-measure wall takeoff for R Estimator.
 *
 * Lets the estimator open the uploaded plan PDF, set the drawing scale, and click
 * along each wall by type. Linear feet are measured, never assumed. app.js uses
 * the result for metal-stud framing, gypsum board and painting; any floor that has
 * not been measured falls back to the old factor, and the basis column says so.
 *
 * Loaded by app.js at start-up (loadScript('walls.js')). Pure math lives in
 * WallsCore so it can be unit-tested in Node.
 */
(function (root) {
  'use strict';

  var TYPES = [
    { key: 'part',  label: 'Interior partition',        faces: 2, color: '#d6336c' },
    { key: 'demis', label: 'Demising / rated (Type X)', faces: 2, color: '#e8590c' },
    { key: 'corr',  label: 'Corridor wall',             faces: 2, color: '#7048e8' },
    { key: 'shaft', label: 'Shaft / stair enclosure',   faces: 1, color: '#0b7285' },
    { key: 'furr',  label: 'Exterior furring',          faces: 1, color: '#2b8a3e' }
  ];

  /* ---------------- pure math (unit-testable) ---------------- */
  function dist(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); }

  function runLF(pts, ptPerFt) {
    if (!pts || pts.length < 2 || !(ptPerFt > 0)) return 0;
    var t = 0;
    for (var i = 1; i < pts.length; i++) t += dist(pts[i - 1], pts[i]);
    return t / ptPerFt;
  }

  // "43'-4 1/2\"", "43.5", "100", "100 ft" -> feet (NaN if unreadable)
  function parseFtIn(s) {
    s = String(s == null ? '' : s).trim();
    var m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)?\s*(?:-?\s*(\d+(?:\.\d+)?)\s*(?:(\d+)\/(\d+))?\s*(?:"|in)?)?$/i);
    if (!m) return NaN;
    var ft = parseFloat(m[1]);
    var inch = m[2] ? parseFloat(m[2]) : 0;
    if (m[3] && +m[4]) inch += parseInt(m[3], 10) / parseInt(m[4], 10);
    return ft + inch / 12;
  }

  function facesOf(plan, key) {
    var f = plan && plan.faces && plan.faces[key];
    if (f === 1 || f === 2) return f;
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].key === key) return TYPES[i].faces;
    return 2;
  }

  // LF per wall type across every record, each record counted once per floor it represents
  function totalsByType(plan) {
    var by = {}, aiBy = {}, floorsMeasured = 0, floorsAI = 0, hand = {};
    TYPES.forEach(function (t) { by[t.key] = 0; aiBy[t.key] = 0; });
    var recs = (plan && plan.records) || [];
    // sheets that were measured by hand: an AI estimate for the same sheet is ignored
    recs.forEach(function (r) {
      if (r.ai) return;
      var lf = 0; (r.runs || []).forEach(function (run) { lf += runLF(run.pts, r.ptPerFt); });
      if (lf > 0) hand[r.key] = true;
    });
    recs.forEach(function (r) {
      var n = Math.max(1, +r.floors || 1), lf = 0;
      if (r.cad) {
        var anyc = 0;
        TYPES.forEach(function (t) { var v = Math.max(0, +(r.lf && r.lf[t.key]) || 0); by[t.key] += v * n; anyc += v; });
        if (anyc > 0) floorsMeasured += n;
        return;
      }
      if (r.ai) {
        if (hand[String(r.key).replace(/^ai:/, '')]) return;
        var any = 0;
        TYPES.forEach(function (t) {
          var v = Math.max(0, +(r.lf && r.lf[t.key]) || 0);
          by[t.key] += v * n; aiBy[t.key] += v * n; any += v;
        });
        if (any > 0) floorsAI += n;
        return;
      }
      (r.runs || []).forEach(function (run) {
        var v = runLF(run.pts, r.ptPerFt);
        if (by[run.type] === undefined) by[run.type] = 0;
        by[run.type] += v * n; lf += v;
      });
      if (lf > 0) floorsMeasured += n;
    });
    return { by: by, aiBy: aiBy, floorsMeasured: floorsMeasured, floorsAI: floorsAI };
  }

  /* Quantities for the takeoff. Returns null when nothing has been measured.
   * m: {nsf}, wallht in ft, factor = fallback LF per net SF, floorsTotal = floors in the building.
   * Floors not yet measured keep using the factor so the estimate is never short. */
  function quantities(plan, m, wallht, factor, floorsTotal) {
    var t = totalsByType(plan), totalLF = 0, aiLF = 0, k;
    for (k in t.by) totalLF += t.by[k];
    for (k in t.aiBy) aiLF += t.aiBy[k];
    if (!(totalLF > 0)) return null;
    var handLF = totalLF - aiLF;
    floorsTotal = Math.max(1, +floorsTotal || 1);
    var fm = Math.min(t.floorsMeasured + t.floorsAI, floorsTotal);
    var rest = Math.max(0, 1 - fm / floorsTotal);
    var restLF = factor * (m.nsf || 0) * rest;
    var board = 0;
    for (k in t.by) board += t.by[k] * facesOf(plan, k) * wallht;
    board += restLF * wallht * 2;
    var restTxt = restLF > 0 ? ' + factor for ' + (floorsTotal - fm) + ' unmeasured floor' + (floorsTotal - fm === 1 ? '' : 's') : '';
    var fmt = function (v) { return Math.round(v).toLocaleString('en-US'); };
    var what = (handLF > 0 && aiLF > 0) ? 'MEASURED ' + fmt(handLF) + ' LF + AI-ESTIMATED ' + fmt(aiLF) + ' LF'
             : (aiLF > 0 ? 'AI-ESTIMATED ' + fmt(aiLF) + ' LF (verify by measuring)' : 'MEASURED ' + fmt(handLF) + ' LF');
    var head = what + ' on ' + fm + ' of ' + floorsTotal + ' floors' + restTxt;
    return {
      measured: aiLF <= 0 || handLF > 0,
      measuredLF: handLF, aiLF: aiLF, restLF: restLF,
      framingLF: totalLF + restLF,
      gwbSF: board + (m.nsf || 0),
      floorsMeasured: fm, floorsTotal: floorsTotal,
      byType: t.by,
      basisFrame: head,
      basisGwb: head + ' · wall ht × faces + ceilings'
    };
  }

  var WallsCore = { TYPES: TYPES, runLF: runLF, parseFtIn: parseFtIn, totalsByType: totalsByType, quantities: quantities, facesOf: facesOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = WallsCore;
  root.WallsCore = WallsCore;
  if (!root.wallPlan) root.wallPlan = { records: [], faces: {} };
  if (typeof document === 'undefined') return;

  /* ---------------- UI ---------------- */
  var S = {
    entry: null, pdf: null, pageNum: 1, zoom: 0.6, page: null, rec: null,
    type: 'part', cur: [], hover: null, calib: null, titles: {}, rendering: false, pending: false
  };
  var el = {};

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function injectStyles() {
    if ($('walls-css')) return;
    var st = document.createElement('style'); st.id = 'walls-css';
    st.textContent =
      '#walls-modal{position:fixed;inset:0;z-index:9999;background:rgba(10,20,40,.72);display:none;font-family:inherit}' +
      '#walls-modal.open{display:flex}' +
      '#walls-box{margin:auto;width:min(1500px,97vw);height:94vh;background:#fff;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)}' +
      '.w-bar{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:8px 12px;border-bottom:1px solid #d9dee7;background:#f5f7fb;font-size:13px}' +
      '.w-bar select,.w-bar input[type=number]{padding:4px 6px;border:1px solid #b9c2d3;border-radius:5px;font-size:13px}' +
      '.w-bar button,.w-types button{padding:5px 10px;border:1px solid #b9c2d3;border-radius:6px;background:#fff;cursor:pointer;font-size:13px}' +
      '.w-bar button.primary{background:#1a3a6b;color:#fff;border-color:#1a3a6b;font-weight:600}' +
      '.w-main{flex:1;display:flex;min-height:0}' +
      '#walls-scroll{flex:1;overflow:auto;background:#6b7280;position:relative}' +
      '#walls-stage{position:relative;display:inline-block;cursor:crosshair}' +
      '#walls-stage canvas{display:block}' +
      '#walls-over{position:absolute;left:0;top:0}' +
      '.w-side{width:310px;border-left:1px solid #d9dee7;padding:10px;overflow:auto;font-size:13px;background:#fff}' +
      '.w-types button{display:flex;align-items:center;gap:8px;width:100%;margin:4px 0;text-align:left}' +
      '.w-types button.on{outline:2px solid #1a3a6b;background:#eef3ff}' +
      '.w-sw{width:14px;height:14px;border-radius:3px;flex:none}' +
      '.w-row{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px dotted #d9dee7}' +
      '.w-note{color:#555;font-size:12px;margin:8px 0;line-height:1.4}' +
      '.w-warn{color:#b45309}';
    document.head.appendChild(st);
  }

  function buildModal() {
    if ($('walls-modal')) return;
    injectStyles();
    var m = document.createElement('div'); m.id = 'walls-modal';
    var typeBtns = TYPES.map(function (t) {
      return '<button data-type="' + t.key + '"><span class="w-sw" style="background:' + t.color + '"></span><span style="flex:1">' + esc(t.label) + '</span><span class="w-lf" data-lf="' + t.key + '">0 LF</span></button>';
    }).join('');
    m.innerHTML =
      '<div id="walls-box">' +
      '<div class="w-bar">' +
        '<strong>📐 Measure walls</strong>' +
        '<label>Plan PDF <input type="file" id="w-file" accept="application/pdf"></label>' +
        '<label>Sheet <select id="w-page"></select></label>' +
        '<label>Floor <select id="w-floor"></select></label>' +
        '<label>Same on <input type="number" id="w-nfloors" min="1" max="60" value="1" style="width:58px"> floor(s)</label>' +
        '<label>Scale <select id="w-scale">' +
          '<option value="18">1/4" = 1\'-0"</option><option value="9">1/8" = 1\'-0"</option>' +
          '<option value="13.5">3/16" = 1\'-0"</option><option value="36">1/2" = 1\'-0"</option>' +
          '<option value="6">3/32" = 1\'-0"</option><option value="custom">Calibrated</option></select></label>' +
        '<button id="w-calib">Set scale from a known length</button>' +
        '<span id="w-scale-note" class="w-note" style="margin:0"></span>' +
        '<button id="w-ai1" title="Ask the AI to estimate wall footage on this sheet">🤖 AI estimate this sheet</button>' +
        '<button id="w-aiall" title="AI estimate every proposed floor plan sheet">🤖 AI estimate all floor plans</button>' +
        '<button id="w-aistop" style="display:none">Stop</button>' +
        '<span style="flex:1"></span>' +
        '<button id="w-zout">−</button><span id="w-zlbl">60%</span><button id="w-zin">+</button>' +
        '<button class="primary" id="w-done">Done — use in estimate</button>' +
      '</div>' +
      '<div class="w-main">' +
        '<div id="walls-scroll"><div id="walls-stage"><canvas id="walls-pdf"></canvas><canvas id="walls-over"></canvas></div></div>' +
        '<div class="w-side">' +
          '<div style="font-weight:600;margin-bottom:4px">Wall type to draw</div>' +
          '<div class="w-types">' + typeBtns + '</div>' +
          '<div class="w-note">Click along the wall centerline. <b>Double-click</b> or press <b>Enter</b> to finish a run. Hold <b>Shift</b> for straight lines. <b>Backspace</b> undoes the last point or run. <b>Esc</b> cancels the run in progress.</div>' +
          '<div style="margin:6px 0"><button id="w-undo">Undo</button> <button id="w-finish">Finish run</button> <button id="w-clear">Clear this sheet</button></div>' +
          '<div style="font-weight:600;margin-top:10px">Drywall faces per wall type</div>' +
          '<div id="w-faces"></div>' +
          '<div style="font-weight:600;margin-top:12px">Totals — all sheets</div>' +
          '<div id="w-totals"></div>' +
          '<div id="w-status" class="w-note"></div>' +
        '</div>' +
      '</div></div>';
    document.body.appendChild(m);
    el = { modal: m, pdf: $('walls-pdf'), over: $('walls-over'), scroll: $('walls-scroll') };
    wireModal();
  }

  /* ---------- records ---------- */
  function floorNames() {
    var names = [];
    try { if (typeof floorRows !== 'undefined' && floorRows.length) names = floorRows.map(function (r) { return r.name; }); } catch (e) {}
    if (!names.length) {
      var n = +(($('m-floors') || {}).value) || 1;
      if ($('m-cellar') && +$('m-cellar').value) names.push('Cellar');
      for (var i = 1; i <= n; i++) names.push('Floor ' + i);
    }
    return names;
  }
  function floorsTotal() {
    try { if (typeof floorRows !== 'undefined' && floorRows.length) return floorRows.length; } catch (e) {}
    return floorNames().length;
  }
  function recKey() { return (S.entry ? S.entry.name || 'plans' : 'plans') + '#' + S.pageNum; }
  function currentRec(create) {
    var key = recKey(), recs = root.wallPlan.records;
    for (var i = 0; i < recs.length; i++) if (recs[i].key === key) return recs[i];
    if (!create) return null;
    var r = { key: key, file: S.entry ? S.entry.name : 'plans', page: S.pageNum, title: S.titles[S.pageNum] || '',
              floor: $('w-floor').value, floors: 1, ptPerFt: +$('w-scale').value || 18, scaleMode: 'preset', runs: [] };
    recs.push(r); return r;
  }

  /* ---------- PDF handling ---------- */
  function pageTitle(items) {
    var best = '';
    items.forEach(function (it) {
      var s = (it.str || '').trim();
      if (s.length >= 8 && s.length <= 70 && /(PLAN|ELEVATION|SECTION|DETAIL|LEGEND)/i.test(s) && /^(PROPOSED|CELLAR|DEMOLITION|[0-9]+(ST|ND|RD|TH)|FRONT|REAR|RIGHT|LEFT|ROOF|CEILING|INNER|FLOOR|SECTION)/i.test(s) && !best) best = s;
    });
    return best;
  }

  async function openEntry(entry) {
    S.entry = entry; S.titles = {};
    var pdfjs = await ensurePdfJs();
    if (!entry._pdf) entry._pdf = await pdfjs.getDocument({ data: await entry.file.arrayBuffer() }).promise;
    S.pdf = entry._pdf;
    var sel = $('w-page'); sel.innerHTML = '';
    for (var p = 1; p <= S.pdf.numPages; p++) {
      var o = document.createElement('option'); o.value = p; o.textContent = 'Page ' + p; sel.appendChild(o);
    }
    // fill in sheet titles in the background so the list is readable
    (async function () {
      for (var q = 1; q <= S.pdf.numPages; q++) {
        try {
          var pg = await S.pdf.getPage(q), tc = await pg.getTextContent();
          var t = pageTitle(tc.items); S.titles[q] = t;
          if (sel.options[q - 1]) sel.options[q - 1].textContent = 'Page ' + q + (t ? ' — ' + t : '');
        } catch (e) {}
      }
    })();
    S.pageNum = 1; sel.value = 1;
    await gotoPage(1);
  }

  async function gotoPage(n) {
    S.pageNum = n; S.cur = []; S.hover = null; S.calib = null;
    S.page = await S.pdf.getPage(n);
    S.rec = currentRec(false);
    syncControlsFromRec();
    await renderPage();
  }

  async function renderPage() {
    if (!S.page) return;
    if (S.rendering) { S.pending = true; return; }
    S.rendering = true;
    try {
      var vp = S.page.getViewport({ scale: S.zoom });
      el.pdf.width = Math.ceil(vp.width); el.pdf.height = Math.ceil(vp.height);
      el.over.width = el.pdf.width; el.over.height = el.pdf.height;
      var ctx = el.pdf.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, el.pdf.width, el.pdf.height);
      await S.page.render({ canvasContext: ctx, viewport: vp }).promise;
      $('w-zlbl').textContent = Math.round(S.zoom * 100) + '%';
    } finally { S.rendering = false; }
    draw(); updateTotals();
    if (S.pending) { S.pending = false; renderPage(); }
  }

  /* ---------- drawing the overlay ---------- */
  function typeColor(k) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i].key === k) return TYPES[i].color; return '#000'; }

  function draw() {
    var c = el.over.getContext('2d'), z = S.zoom;
    c.clearRect(0, 0, el.over.width, el.over.height);
    c.lineJoin = 'round'; c.lineCap = 'round';
    var rec = currentRec(false);
    if (rec) rec.runs.forEach(function (run) { stroke(c, run.pts, typeColor(run.type), 3, z); });
    if (S.cur.length) {
      var pts = S.cur.slice(); if (S.hover) pts.push(S.hover);
      stroke(c, pts, typeColor(S.type), 3, z, true);
      S.cur.forEach(function (p) { dot(c, p, typeColor(S.type), z); });
    }
    if (S.calib) { S.calib.forEach(function (p) { dot(c, p, '#111', z); }); if (S.calib.length === 2) stroke(c, S.calib, '#111', 2, z); }
  }
  function stroke(c, pts, color, w, z, dashed) {
    if (pts.length < 2) return;
    c.beginPath(); c.strokeStyle = color; c.lineWidth = w; c.setLineDash(dashed ? [6, 5] : []);
    pts.forEach(function (p, i) { if (i) c.lineTo(p[0] * z, p[1] * z); else c.moveTo(p[0] * z, p[1] * z); });
    c.stroke(); c.setLineDash([]);
  }
  function dot(c, p, color, z) { c.beginPath(); c.fillStyle = color; c.arc(p[0] * z, p[1] * z, 4, 0, 6.2832); c.fill(); }


  /* ---------- AI pre-fill (estimates only; hand-measured sheets always win) ---------- */
  var AI_CAP = { part: 2500, demis: 1500, corr: 1500, shaft: 600, furr: 3000 };
  function aiPrompt(pxPerFt, floorName) {
    return 'You are a construction estimator reading one architectural floor plan sheet (' + floorName + '). ' +
      'Scale: about ' + (Math.round(pxPerFt * 10) / 10) + ' image pixels = 1 foot. ' +
      'Estimate the TOTAL LINEAR FEET (centerline) of NEW framed (stud) walls that will need framing and drywall on THIS floor, by type: ' +
      'part = interior partitions within units/rooms; demis = demising walls between units or units and corridor/stairs (rated); ' +
      'corr = corridor walls (non-demising); shaft = shaft/elevator/stair enclosure walls; furr = furring on existing exterior/masonry walls to remain. ' +
      'Do NOT count existing masonry or brick walls to remain (except as furr), exterior walls, windows or doors openings (measure through them), or walls shown dashed for demolition. ' +
      'Use dimension strings and the scale to size things. Return JSON only: {"part":number,"demis":number,"corr":number,"shaft":number,"furr":number,"confidence":"low|medium|high","notes":"one short sentence"}';
  }
  function isFloorPlanTitle(t) {
    t = t || '';
    return /PLAN/i.test(t) && /(PROPOSED|CELLAR|FLOOR|^[0-9]+(ST|ND|RD|TH))/i.test(t) && !/(DEMOLITION|CEILING|ROOF|ELEVATION|SECTION|DETAIL|LEGEND|SCHEDULE|SITE|FOUNDATION|FRAMING)/i.test(t);
  }
  function floorForTitle(t, names) {
    t = (t || '').toUpperCase();
    if (/CELLAR|BASEMENT/.test(t)) { for (var i = 0; i < names.length; i++) if (/cellar|basement/i.test(names[i])) return names[i]; return names[0]; }
    var ord = { FIRST: 1, '1ST': 1, SECOND: 2, '2ND': 2, THIRD: 3, '3RD': 3, FOURTH: 4, '4TH': 4, FIFTH: 5, '5TH': 5, SIXTH: 6, '6TH': 6, SEVENTH: 7, '7TH': 7, EIGHTH: 8, '8TH': 8 };
    for (var k in ord) if (t.indexOf(k) >= 0) {
      for (var j = 0; j < names.length; j++) if (new RegExp('(^|\\D)' + ord[k] + '(\\D|$)').test(names[j]) || names[j].toUpperCase().indexOf(k) >= 0) return names[j];
      var off = names.some(function (n) { return /cellar|basement/i.test(n); }) ? 1 : 0;
      return names[Math.min(names.length - 1, ord[k] - 1 + off)];
    }
    return null;
  }
  function cleanAI(j) {
    if (!j) return null;
    var out = {}, any = false;
    TYPES.forEach(function (t) { var v = +j[t.key]; if (!(v >= 0) || !isFinite(v)) v = 0; out[t.key] = Math.min(Math.round(v), AI_CAP[t.key] || 3000); if (out[t.key] > 0) any = true; });
    return any ? out : null;
  }
  async function aiEstimateCurrent(floorName, pageNum) {
    var scale = +$('w-scale').value || 18;
    var pg = await S.pdf.getPage(pageNum);
    var base = pg.getViewport({ scale: 1 }), long = 2400;
    var pxPerFt = long / Math.max(base.width, base.height) * scale;
    var canvas = await renderPageCanvas(S.entry, pageNum - 1, long);
    var b64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    var txt = await callExtractor([{ media_type: 'image/jpeg', data: b64 }], '', aiPrompt(pxPerFt, floorName));
    var vals = cleanAI(parseJSON(txt));
    if (!vals) throw new Error('the AI did not return usable wall lengths');
    var j = parseJSON(txt) || {};
    var key = 'ai:' + (S.entry ? S.entry.name || 'plans' : 'plans') + '#' + pageNum;
    var recs = root.wallPlan.records;
    root.wallPlan.records = recs.filter(function (r) { return r.key !== key; });
    root.wallPlan.records.push({ ai: true, key: key, file: S.entry.name || 'plans', page: pageNum, title: S.titles[pageNum] || '',
      floor: floorName, floors: 1, lf: vals, confidence: j.confidence || '', notes: String(j.notes || '').slice(0, 160) });
    return vals;
  }
  var aiStop = false;
  async function runAI(all) {
    if (!S.entry || !S.page) { $('w-status').innerHTML = '<span class="w-warn">Open the plan PDF first.</span>'; return; }
    if (typeof callExtractor !== 'function' || typeof renderPageCanvas !== 'function' || typeof parseJSON !== 'function') { $('w-status').innerHTML = '<span class="w-warn">AI helper not available in this build.</span>'; return; }
    var names = floorNames(), startPage = S.pageNum, jobs = [];
    if (all) {
      for (var p = 1; p <= S.pdf.numPages; p++) { var t = S.titles[p] || ''; if (isFloorPlanTitle(t)) { var fl = floorForTitle(t, names); if (fl) jobs.push({ page: p, floor: fl }); } }
      if (!jobs.length) { $('w-status').innerHTML = '<span class="w-warn">No floor-plan sheets recognised by title. Pick a sheet and use “AI estimate this sheet”.</span>'; return; }
    } else jobs.push({ page: S.pageNum, floor: $('w-floor').value || names[0] });
    aiStop = false; ['w-ai1', 'w-aiall'].forEach(function (i) { $(i).disabled = true; }); $('w-aistop').style.display = '';
    var ok = 0, fail = [], fin = 0, next = 0;
    $('w-status').innerHTML = '🤖 AI reading ' + jobs.length + ' sheet(s) in parallel…';
    async function worker() {
      while (next < jobs.length && !aiStop) {
        var jb = jobs[next++];
        try {
          var done = false;
          for (var a = 0; a < 2 && !done; a++) { try { await aiEstimateCurrent(jb.floor, jb.page); done = true; } catch (e) { if (a === 1) throw e; } }
          ok++;
        } catch (e) { fail.push('p' + jb.page + ': ' + (e && e.message || e)); }
        fin++; $('w-status').innerHTML = '🤖 AI done ' + fin + ' of ' + jobs.length + '…';
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    ['w-ai1', 'w-aiall'].forEach(function (i) { $(i).disabled = false; }); $('w-aistop').style.display = 'none';
    await gotoPage(all ? startPage : jobs[0].page);
    $('w-page').value = S.pageNum;
    $('w-status').insertAdjacentHTML('beforeend', '<div>🤖 AI estimated ' + ok + ' sheet(s)' + (fail.length ? '; failed: ' + esc(fail.join(' | ')) : '') + '. <b>These are estimates — verify by measuring.</b></div>');
  }

  /* ---------- totals / controls ---------- */
  function updateTotals() {
    var plan = root.wallPlan, t = totalsByType(plan);
    var rec = currentRec(false), here = {};
    TYPES.forEach(function (ty) { here[ty.key] = 0; });
    if (rec) rec.runs.forEach(function (r) { here[r.type] = (here[r.type] || 0) + runLF(r.pts, rec.ptPerFt); });
    TYPES.forEach(function (ty) {
      var b = el.modal.querySelector('[data-lf="' + ty.key + '"]');
      if (b) b.textContent = Math.round(here[ty.key]) + ' LF';
    });
    var rows = TYPES.map(function (ty) {
      return '<div class="w-row"><span><span class="w-sw" style="display:inline-block;background:' + ty.color + '"></span> ' + esc(ty.label) + '</span><b>' + Math.round(t.by[ty.key]).toLocaleString('en-US') + ' LF</b></div>';
    }).join('');
    var total = 0; for (var k in t.by) total += t.by[k];
    var ft = floorsTotal();
    rows += '<div class="w-row"><span>Total measured</span><b>' + Math.round(total).toLocaleString('en-US') + ' LF</b></div>';
    $('w-totals').innerHTML = rows;
    var covered = Math.min(ft, t.floorsMeasured + t.floorsAI), warn = covered < ft, aiTot = 0;
    for (var ak in t.aiBy) aiTot += t.aiBy[ak];
    var aiHere = null; root.wallPlan.records.forEach(function (r) { if (r.ai && r.key === 'ai:' + recKey()) aiHere = r; });
    $('w-status').innerHTML = 'Measured floors: <b>' + t.floorsMeasured + '</b>' + (t.floorsAI ? ' · AI-estimated floors: <b>' + t.floorsAI + '</b> (' + Math.round(aiTot).toLocaleString('en-US') + ' LF — <span class="w-warn">estimate, verify</span>)' : '') + ' · of ' + ft + ' floors.' +
      (warn ? ' <span class="w-warn">Remaining floors use the 0.30 LF/SF factor.</span>' : ' All floors covered.') +
      (aiHere ? '<div class="w-note">AI on this sheet (' + esc(aiHere.floor) + '): ' + TYPES.map(function (ty) { return ty.label.split(' ')[0] + ' ' + (aiHere.lf[ty.key] || 0); }).join(', ') + ' LF · confidence ' + esc(aiHere.confidence || '?') + (aiHere.notes ? ' — ' + esc(aiHere.notes) : '') + '. Measuring this sheet by hand replaces it.</div>' : '');
    $('w-faces').innerHTML = TYPES.map(function (ty) {
      var f = facesOf(plan, ty.key);
      return '<div class="w-row"><span>' + esc(ty.label) + '</span><select data-faces="' + ty.key + '"><option value="1"' + (f === 1 ? ' selected' : '') + '>1 face</option><option value="2"' + (f === 2 ? ' selected' : '') + '>2 faces</option></select></div>';
    }).join('');
    [].forEach.call($('w-faces').querySelectorAll('select'), function (s) {
      s.onchange = function () { root.wallPlan.faces = root.wallPlan.faces || {}; root.wallPlan.faces[s.getAttribute('data-faces')] = +s.value; updateTotals(); };
    });
    [].forEach.call(el.modal.querySelectorAll('.w-types button'), function (b) {
      b.className = (b.getAttribute('data-type') === S.type) ? 'on' : '';
    });
    var sc = rec ? rec.ptPerFt : (+$('w-scale').value || 18);
    $('w-scale-note').textContent = sc ? '(' + (Math.round(sc * 100) / 100) + ' pt per ft)' : '';
  }

  function syncControlsFromRec() {
    var r = S.rec;
    var names = floorNames(), fs = $('w-floor');
    fs.innerHTML = names.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('');
    if (r) {
      if (names.indexOf(r.floor) < 0) fs.insertAdjacentHTML('beforeend', '<option>' + esc(r.floor) + '</option>');
      fs.value = r.floor; $('w-nfloors').value = r.floors || 1;
      var preset = [].some.call($('w-scale').options, function (o) { return o.value !== 'custom' && Math.abs(+o.value - r.ptPerFt) < 0.001; });
      if (preset) $('w-scale').value = String(r.ptPerFt); else { $('w-scale').value = 'custom'; }
    } else { $('w-nfloors').value = 1; }
  }

  function pushRecFields() {
    var r = currentRec(false); if (!r) return;
    r.floor = $('w-floor').value; r.floors = Math.max(1, +$('w-nfloors').value || 1);
  }

  /* ---------- events ---------- */
  function ptFromEvent(e) {
    var rect = el.over.getBoundingClientRect();
    var x = (e.clientX - rect.left) / S.zoom, y = (e.clientY - rect.top) / S.zoom;
    if (e.shiftKey) {
      var base = S.calib && S.calib.length ? S.calib[S.calib.length - 1] : S.cur[S.cur.length - 1];
      if (base) { if (Math.abs(x - base[0]) > Math.abs(y - base[1])) y = base[1]; else x = base[0]; }
    }
    return [x, y];
  }

  function finishRun() {
    if (S.cur.length >= 2) {
      var rec = currentRec(true); rec.runs.push({ type: S.type, pts: S.cur.slice() });
      rec.floor = $('w-floor').value; rec.floors = Math.max(1, +$('w-nfloors').value || 1);
      S.rec = rec;
    }
    S.cur = []; S.hover = null; draw(); updateTotals();
  }
  function undo() {
    if (S.cur.length) { S.cur.pop(); } else {
      var rec = currentRec(false); if (rec && rec.runs.length) rec.runs.pop();
    }
    draw(); updateTotals();
  }

  function onCanvasClick(e) {
    var p = ptFromEvent(e);
    if (S.calib) {
      S.calib.push(p);
      if (S.calib.length === 2) {
        draw();
        var a = S.calib, d = dist(a[0], a[1]);
        var ans = window.prompt('Real-world length of the line you just drew (e.g. 100, 43\'-4", 12.5):', '');
        var ft = parseFtIn(ans);
        if (ft > 0 && d > 0) {
          var rec = currentRec(true); rec.ptPerFt = d / ft; rec.scaleMode = 'calibrated';
          $('w-scale').value = 'custom';
        } else if (ans !== null) { window.alert('Could not read that length. Scale not changed.'); }
        S.calib = null;
      }
      draw(); updateTotals(); return;
    }
    var last = S.cur[S.cur.length - 1];
    if (last && dist(last, p) * S.zoom < 2) return;   // swallow the 2nd click of a double-click
    S.cur.push(p); draw();
  }

  function wireModal() {
    el.over.addEventListener('click', onCanvasClick);
    el.over.addEventListener('dblclick', function (e) { e.preventDefault(); finishRun(); });
    el.over.addEventListener('mousemove', function (e) { if (S.cur.length) { S.hover = ptFromEvent(e); draw(); } });
    [].forEach.call(el.modal.querySelectorAll('.w-types button'), function (b) {
      b.onclick = function () { if (S.cur.length) finishRun(); S.type = b.getAttribute('data-type'); updateTotals(); };
    });
    $('w-undo').onclick = undo; $('w-finish').onclick = finishRun;
    $('w-clear').onclick = function () {
      if (!window.confirm('Remove all measured walls on this sheet?')) return;
      var key = recKey(); root.wallPlan.records = root.wallPlan.records.filter(function (r) { return r.key !== key && r.key !== 'ai:' + key; });
      S.cur = []; S.rec = null; draw(); updateTotals();
    };
    $('w-calib').onclick = function () { S.cur = []; S.calib = []; draw(); $('w-status').innerHTML = '<b>Scale:</b> click the two ends of a dimension you know (a dimensioned wall, the lot line), then enter its length.'; };
    $('w-scale').onchange = function () {
      var v = $('w-scale').value; if (v === 'custom') return;
      var rec = currentRec(true); rec.ptPerFt = +v; rec.scaleMode = 'preset'; draw(); updateTotals();
    };
    $('w-floor').onchange = pushRecFields; $('w-nfloors').onchange = pushRecFields;
    $('w-ai1').onclick = function () { runAI(false); };
    $('w-aiall').onclick = function () { runAI(true); };
    $('w-aistop').onclick = function () { aiStop = true; };
    $('w-page').onchange = function () { gotoPage(+$('w-page').value); };
    $('w-zin').onclick = function () { S.zoom = Math.min(2.5, Math.round((S.zoom + 0.15) * 100) / 100); S.cur = []; renderPage(); };
    $('w-zout').onclick = function () { S.zoom = Math.max(0.25, Math.round((S.zoom - 0.15) * 100) / 100); S.cur = []; renderPage(); };
    $('w-file').onchange = function () {
      var f = this.files && this.files[0]; if (!f) return;
      var ent = { file: f, name: f.name, size: f.size, images: null, status: 'ready' };
      openEntry(ent).catch(function (e) { window.alert('Could not open that PDF: ' + (e && e.message || e)); });
    };
    $('w-done').onclick = closeModal;
    document.addEventListener('keydown', function (e) {
      if (!el.modal.classList.contains('open')) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT') return;
      if (e.key === 'Enter') { finishRun(); e.preventDefault(); }
      else if (e.key === 'Escape') { if (S.cur.length || S.calib) { S.cur = []; S.calib = null; draw(); } else closeModal(); }
      else if (e.key === 'Backspace') { undo(); e.preventDefault(); }
    });
  }

  function closeModal() {
    if (S.cur.length) finishRun();
    pushRecFields();
    el.modal.classList.remove('open');
    refreshSummary();
    try { if (typeof recalc === 'function' && $('step-3') && !$('step-3').classList.contains('hidden')) recalc(); } catch (e) {}
  }

  /* ---------- entry point + summary chip on the verify page ---------- */
  function pickEntry() {
    try {
      if (typeof files !== 'undefined' && files.length) {
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          if (f && f.file && (f.file.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''))) return f;
        }
      }
    } catch (e) {}
    return null;
  }

  async function openWalls() {
    buildModal();
    el.modal.classList.add('open');
    syncControlsFromRec();
    var ent = pickEntry();
    if (ent && ent !== S.entry) {
      try { await openEntry(ent); } catch (e) { window.alert('Could not open the plan PDF: ' + (e && e.message || e)); }
    } else if (S.entry) { await gotoPage(S.pageNum); }
    else { $('w-status').innerHTML = '<span class="w-warn">Choose the plan PDF above to start measuring.</span>'; updateTotals(); }
  }

  function refreshSummary() {
    var s = $('wall-summary'); if (!s) return;
    var t = totalsByType(root.wallPlan), total = 0;
    for (var k in t.by) total += t.by[k];
    var aiT = 0; for (var q in t.aiBy) aiT += t.aiBy[q];
    s.textContent = total > 0
      ? (aiT > 0 ? 'AI-estimated ' + Math.round(aiT).toLocaleString('en-US') + ' LF (verify) + ' : '') + 'measured ' + Math.round(total - aiT).toLocaleString('en-US') + ' LF of wall on ' + Math.min(floorsTotal(), t.floorsMeasured + t.floorsAI) + ' of ' + floorsTotal() + ' floors'
      : 'Not measured — framing & sheetrock use a 0.30 LF/SF factor';
  }

  function injectButton() {
    if ($('wall-measure-btn')) return;
    var anchor = document.querySelector('button[onclick="addFloorRow()"]');
    if (!anchor || !anchor.parentNode) return;
    var b = document.createElement('button'); b.className = 'btn'; b.id = 'wall-measure-btn';
    b.textContent = '📐 Measure walls from plans'; b.onclick = openWalls;
    anchor.parentNode.insertBefore(b, anchor.nextSibling);
    var sp = document.createElement('span'); sp.id = 'wall-summary'; sp.style.cssText = 'margin-left:10px;font-size:12px;color:#555';
    anchor.parentNode.insertBefore(sp, b.nextSibling);
    refreshSummary();
  }


  /* Automatic run right after plan analysis: AI-estimate every proposed floor-plan sheet in the background. */
  async function autoWalls() {
    var ent = pickEntry(); if (!ent) return;
    var chip = $('wall-summary'); if (chip) chip.textContent = '🤖 AI is estimating walls from the floor plans…';
    try {
      buildModal();
      await openEntry(ent);
      var t0 = Date.now();
      while (Date.now() - t0 < 12000) { if (Object.keys(S.titles).length >= S.pdf.numPages) break; await new Promise(function (r) { setTimeout(r, 300); }); }
      await runAI(true);
    } catch (e) { console.warn('auto wall estimate failed', e); }
    refreshSummary();
    try { if (typeof recalc === 'function') recalc(); } catch (e) {}
  }
  root.autoWalls = autoWalls;
  root.openWalls = openWalls;
  root.refreshWallSummary = refreshSummary;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton); else injectButton();
})(typeof window !== 'undefined' ? window : globalThis);
