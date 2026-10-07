/* DXF import for R Estimator: reads ASCII DXF, totals wall length by layer and counts door/window blocks.
   Results feed window.wallPlan as a hand-grade ("cad") record, so framing & sheetrock use exact lengths. */
(function (root) {
  'use strict';
  var UNIT_FT = { 1: 1 / 12, 2: 1, 4: 1 / 304.8, 5: 1 / 30.48, 6: 3.280840, 0: 1 / 12 };

  function parse(text) {
    var L = text.split(/\r?\n/), i = 0, n = L.length;
    var layers = {}, blocks = {}, insunits = 0, section = '', cur = null, poly = null, bounds = null;
    function lay(name) { return layers[name] || (layers[name] = { name: name, units: 0, ents: 0 }); }
    function pair() { var c = parseInt(L[i], 10), v = (L[i + 1] || '').trim(); i += 2; return [c, v]; }
    function addLen(layer, len) { var l = lay(layer); l.units += len; l.ents++; }
    function finishPoly(p) {
      if (!p) return; var pts = p.pts, len = 0;
      for (var k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (p.closed && pts.length > 2) len += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
      addLen(p.layer, len);
    }
    var ent = null;
    function flush() {
      if (!ent) return;
      if (ent.t === 'LINE' && ent.v.length === 4) addLen(ent.layer, Math.hypot(ent.v[2] - ent.v[0], ent.v[3] - ent.v[1]));
      else if (ent.t === 'LWPOLYLINE') finishPoly({ layer: ent.layer, pts: ent.pts, closed: ent.closed });
      else if (ent.t === 'INSERT' && ent.block) { var k = ent.layer + '\u0001' + ent.block; blocks[k] = blocks[k] || { layer: ent.layer, block: ent.block, count: 0 }; blocks[k].count++; lay(ent.layer); }
      ent = null;
    }
    while (i < n - 1) {
      var p = pair(), c = p[0], v = p[1];
      if (c === 0) {
        if (poly && v !== 'VERTEX') { if (v === 'SEQEND' || true) { finishPoly(poly); poly = null; } }
        flush();
        if (v === 'SECTION') { section = ''; continue; }
        if (v === 'ENDSEC') { section = ''; continue; }
        if (section === 'ENTITIES') {
          if (v === 'LINE') ent = { t: 'LINE', layer: '0', v: [] , _x: {} };
          else if (v === 'LWPOLYLINE') ent = { t: 'LWPOLYLINE', layer: '0', pts: [], closed: false };
          else if (v === 'INSERT') ent = { t: 'INSERT', layer: '0', block: '' };
          else if (v === 'POLYLINE') { poly = { layer: '0', pts: [], closed: false }; }
          else if (v === 'VERTEX' && poly) ent = { t: 'VERTEX', layer: '0', v: [] };
        }
        continue;
      }
      if (c === 2 && v === 'ENTITIES' && !ent) { section = 'ENTITIES'; continue; }
      if (c === 9 && v === '$INSUNITS') { var q = pair(); insunits = parseInt(q[1], 10) || 0; continue; }
      if (section !== 'ENTITIES') continue;
      if (poly && !ent) { if (c === 8) poly.layer = v; else if (c === 70) poly.closed = (parseInt(v, 10) & 1) === 1; continue; }
      if (!ent) continue;
      if (ent.t === 'VERTEX') {
        if (c === 10) ent.v[0] = parseFloat(v); else if (c === 20) { ent.v[1] = parseFloat(v); if (poly) poly.pts.push([ent.v[0], ent.v[1]]); }
        continue;
      }
      if (c === 8) ent.layer = v;
      else if (ent.t === 'LINE') { if (c === 10) ent.v[0] = parseFloat(v); else if (c === 20) ent.v[1] = parseFloat(v); else if (c === 11) ent.v[2] = parseFloat(v); else if (c === 21) ent.v[3] = parseFloat(v); }
      else if (ent.t === 'LWPOLYLINE') { if (c === 70) ent.closed = (parseInt(v, 10) & 1) === 1; else if (c === 10) ent.pts.push([parseFloat(v), 0]); else if (c === 20 && ent.pts.length) ent.pts[ent.pts.length - 1][1] = parseFloat(v); }
      else if (ent.t === 'INSERT') { if (c === 2) ent.block = v; }
    }
    if (poly) finishPoly(poly);
    flush();
    return { layers: layers, blocks: blocks, insunits: insunits, ftPerUnit: UNIT_FT[insunits] || UNIT_FT[0] };
  }

  /* DWG: read with the open-source LibreDWG (WebAssembly, runs in the browser, nothing is uploaded). */
  function fromDb(db) {
    var layers = {}, blocks = {};
    function lay(n) { return layers[n] || (layers[n] = { name: n, units: 0, ents: 0 }); }
    function add(layer, len) { if (!isFinite(len)) return; var l = lay(layer || '0'); l.units += len; l.ents++; }
    (db.entities || []).forEach(function (e) {
      var ly = e.layer || '0';
      if (e.type === 'LINE' && e.startPoint && e.endPoint) add(ly, Math.hypot(e.endPoint.x - e.startPoint.x, e.endPoint.y - e.startPoint.y));
      else if ((e.type === 'LWPOLYLINE' || e.type === 'POLYLINE' || e.type === 'POLYLINE2D') && e.vertices && e.vertices.length > 1) {
        var v = e.vertices, len = 0, k;
        for (k = 1; k < v.length; k++) len += Math.hypot(v[k].x - v[k - 1].x, v[k].y - v[k - 1].y);
        if ((e.flag & 1) === 1 && v.length > 2) len += Math.hypot(v[0].x - v[v.length - 1].x, v[0].y - v[v.length - 1].y);
        add(ly, len);
      } else if (e.type === 'INSERT' && e.name) {
        var key = ly + '\u0001' + e.name; blocks[key] = blocks[key] || { layer: ly, block: e.name, count: 0 }; blocks[key].count++; lay(ly);
      }
    });
    var iu = (db.header && +db.header.INSUNITS) || 0;
    return { layers: layers, blocks: blocks, insunits: iu, ftPerUnit: UNIT_FT[iu] || UNIT_FT[0] };
  }
  var _dwgLib = null;
  async function parseDwg(buf) {
    if (!_dwgLib) {
      var mod = await import('./vendor/libredwg/dist/libredwg-web.js');
      _dwgLib = await mod.LibreDwg.create('vendor/libredwg/wasm');
      _dwgLib._ft = mod.Dwg_File_Type;
    }
    var data = _dwgLib.dwg_read_data(buf, _dwgLib._ft.DWG);
    if (!data) throw new Error('this DWG version could not be read');
    return fromDb(_dwgLib.convert(data));
  }

  function guessLayer(name) {
    var u = name.toUpperCase();
    if (/DEMO|EXIST|E-WALL|\bEX\b|HIDDEN|DIM|TEXT|ANNO|GRID|FURN|HATCH|TITLE|VIEWPORT|DEFPOINTS/.test(u)) return 'ignore';
    if (/DEMIS|PARTY|FIRE.?WALL|RATED|\bDW\b/.test(u)) return 'demis';
    if (/CORR/.test(u)) return 'corr';
    if (/SHAFT|ELEV|STAIR/.test(u) && /WALL/.test(u)) return 'shaft';
    if (/FURR/.test(u)) return 'furr';
    if (/PRTN|PART|INT.?WALL|STUD|A-WALL|WALL/.test(u)) return 'part';
    if (/DOOR|\bDR\b|A-DOOR/.test(u)) return 'door';
    if (/WIND|WDW|GLAZ/.test(u)) return 'window';
    return 'ignore';
  }
  function guessBlock(layer, block) {
    var s = (layer + ' ' + block).toUpperCase();
    if (/DOOR|\bDR\b|^D[-_ ]?\d/.test(s)) return 'door';
    if (/WIND|WDW|GLAZ|^W[-_ ]?\d/.test(s)) return 'window';
    return 'ignore';
  }

  root.DxfCore = { parse: parse, fromDb: fromDb, guessLayer: guessLayer, guessBlock: guessBlock, UNIT_FT: UNIT_FT };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DxfCore;
  if (typeof document === 'undefined') return;

  /* ---------------- UI ---------------- */
  var D = null, box = null;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var TYPES = [['ignore', 'Ignore'], ['part', 'Partition'], ['demis', 'Demising'], ['corr', 'Corridor'], ['shaft', 'Shaft/stair'], ['furr', 'Furring'], ['door', 'Doors (count)'], ['window', 'Windows (count)']];
  function opts(sel) { return TYPES.map(function (t) { return '<option value="' + t[0] + '"' + (t[0] === sel ? ' selected' : '') + '>' + t[1] + '</option>'; }).join(''); }

  function build() {
    if (box) return;
    var st = document.createElement('style');
    st.textContent = '#dxf-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;align-items:center;justify-content:center}#dxf-modal.open{display:flex}#dxf-box{background:#fff;border-radius:10px;width:min(900px,95vw);max-height:90vh;overflow:auto;padding:16px;font-size:13px}#dxf-box table{width:100%;border-collapse:collapse;margin:8px 0}#dxf-box th,#dxf-box td{border-bottom:1px solid #e3e7ee;padding:4px 6px;text-align:left}#dxf-box .p{background:#1a3a6b;color:#fff;border:0;border-radius:6px;padding:7px 14px;font-weight:600;cursor:pointer}';
    document.head.appendChild(st);
    box = document.createElement('div'); box.id = 'dxf-modal';
    box.innerHTML = '<div id="dxf-box"><div style="display:flex;gap:10px;align-items:center"><strong>📁 Import CAD (DWG / DXF)</strong><input type="file" id="dxf-file" accept=".dxf,.dwg"><span style="flex:1"></span><button id="dxf-close">Close</button></div><div id="dxf-body" style="margin-top:8px">Choose a .dxf or .dwg file. DWG files are read directly in your browser (nothing is uploaded).</div></div>';
    document.body.appendChild(box);
    $('dxf-close').onclick = function () { box.classList.remove('open'); };
    $('dxf-file').onchange = function () { if (this.files[0]) handleFile(this.files[0]); };
  }
  function handleFile(f) {
    {
      var isDwg = /\.dwg$/i.test(f.name);
      $('dxf-body').innerHTML = isDwg ? 'Reading DWG… (first time loads a ~3 MB reader)' : 'Reading…';
      var rd = new FileReader();
      rd.onload = async function () {
        try {
          var res = isDwg ? await parseDwg(rd.result) : parse(String(rd.result));
          D = { name: f.name, res: res };
          if (!Object.keys(res.layers).length) throw new Error('no drawing entities found' + (isDwg ? '' : ' (is it a binary DXF?)'));
          render();
        } catch (e) { $('dxf-body').innerHTML = '<b style="color:#b00">Could not read that file: ' + esc(e.message || e) + '</b>' + (isDwg ? '<div>If this DWG is very new or unusual, save it as DXF (AutoCAD: Save As → DXF) and try again.</div>' : ''); }
      };
      if (isDwg) rd.readAsArrayBuffer(f); else rd.readAsText(f);
    }
  }

  function ftOf(l, units, dbl) { return l.units * units / (dbl ? 2 : 1); }

  function render() {
    var r = D.res, names = Object.keys(r.layers).sort(function (a, b) { return r.layers[b].units - r.layers[a].units; });
    var uSel = r.insunits ? String(r.insunits) : '0';
    var h = '<div>Drawing units: <select id="dxf-units"><option value="0">Inches (US architectural)</option><option value="2">Feet</option><option value="4">Millimeters</option><option value="5">Centimeters</option><option value="6">Meters</option></select> ' +
      '<span style="color:#666">' + (r.insunits ? 'file says units code ' + r.insunits : 'file does not state units — check a known length below') + '</span></div>';
    h += '<table><tr><th>Layer</th><th>Entities</th><th>Raw length (ft)</th><th>Use as</th><th>Double-line walls (÷2)</th><th>Length used (ft)</th></tr>';
    names.forEach(function (n, k) {
      var l = r.layers[n]; if (!l.ents) return; var g = guessLayer(n), isWall = /part|demis|corr|shaft|furr/.test(g);
      h += '<tr data-layer="' + esc(n) + '"><td>' + esc(n) + '</td><td>' + l.ents + '</td><td class="raw"></td><td><select class="use">' + opts(g) + '</select></td><td><input type="checkbox" class="dbl"' + (isWall ? ' checked' : '') + '></td><td class="used"></td></tr>';
    });
    h += '</table>';
    var bk = Object.keys(r.blocks);
    if (bk.length) {
      h += '<div style="font-weight:600">Blocks (door/window symbols)</div><table><tr><th>Layer</th><th>Block</th><th>Count</th><th>Use as</th></tr>';
      bk.sort(function (a, b) { return r.blocks[b].count - r.blocks[a].count; }).slice(0, 60).forEach(function (k) {
        var b = r.blocks[k];
        h += '<tr data-bk="' + esc(k) + '"><td>' + esc(b.layer) + '</td><td>' + esc(b.block) + '</td><td>' + b.count + '</td><td><select class="buse">' + opts(guessBlock(b.layer, b.block)).replace(/<option value="(part|demis|corr|shaft|furr)"[^>]*>[^<]*<\/option>/g, '') + '</select></td></tr>';
      });
      h += '</table>';
    }
    h += '<div>This drawing covers <input id="dxf-nf" type="number" min="1" max="60" value="1" style="width:56px"> floor(s) of the building &nbsp; <button class="p" id="dxf-apply">Use in estimate</button></div><div id="dxf-sum" style="margin-top:8px;color:#333"></div>';
    $('dxf-body').innerHTML = h;
    $('dxf-units').value = ({ 1: '0', 2: '2', 4: '4', 5: '5', 6: '6' })[uSel] || '0';
    [].forEach.call($('dxf-body').querySelectorAll('select,input[type=checkbox]'), function (e) { e.onchange = recompute; });
    recompute();
    $('dxf-apply').onclick = apply;
  }

  function collect() {
    var r = D.res, units = (UNIT_FT[+$('dxf-units').value] || UNIT_FT[0]), lf = { part: 0, demis: 0, corr: 0, shaft: 0, furr: 0 }, cnt = { door: 0, window: 0 };
    [].forEach.call($('dxf-body').querySelectorAll('tr[data-layer]'), function (tr) {
      var l = r.layers[tr.getAttribute('data-layer')], use = tr.querySelector('.use').value, dbl = tr.querySelector('.dbl').checked;
      tr.querySelector('.raw').textContent = Math.round(l.units * units).toLocaleString('en-US');
      var used = (lf[use] !== undefined) ? ftOf(l, units, dbl) : 0;
      tr.querySelector('.used').textContent = lf[use] !== undefined ? Math.round(used).toLocaleString('en-US') : '—';
      if (lf[use] !== undefined) lf[use] += used;
    });
    [].forEach.call($('dxf-body').querySelectorAll('tr[data-bk]'), function (tr) {
      var b = r.blocks[tr.getAttribute('data-bk')], u = tr.querySelector('.buse').value; if (cnt[u] !== undefined) cnt[u] += b.count;
    });
    return { lf: lf, cnt: cnt };
  }
  function recompute() {
    var c = collect(), tot = 0; for (var k in c.lf) tot += c.lf[k];
    $('dxf-sum').innerHTML = 'Walls: <b>' + Math.round(tot).toLocaleString('en-US') + ' LF</b> (' + Object.keys(c.lf).map(function (k) { return k + ' ' + Math.round(c.lf[k]); }).join(', ') + ') · Doors <b>' + c.cnt.door + '</b> · Windows <b>' + c.cnt.window + '</b>';
  }
  function apply() {
    var c = collect(), nf = Math.max(1, +$('dxf-nf').value || 1), tot = 0; for (var k in c.lf) tot += c.lf[k];
    if (!(tot > 0)) { $('dxf-sum').innerHTML += '<div style="color:#b00">No wall layers selected — set at least one layer to Partition/Demising/etc.</div>'; return; }
    var wp = root.wallPlan = root.wallPlan || { records: [], faces: {} };
    var key = 'cad:' + D.name;
    wp.records = wp.records.filter(function (r) { return r.key !== key; });
    wp.records.push({ cad: true, key: key, file: D.name, floors: nf, lf: c.lf });
    function setv(id, v) { var e = $(id); if (e && v > 0) { e.value = v * nf; e.dispatchEvent(new Event('input', { bubbles: true })); } }
    setv('m-windows', c.cnt.window); setv('m-doors-int', c.cnt.door);
    if (root.refreshWallSummary) root.refreshWallSummary();
    try { if (typeof recalc === 'function') recalc(); } catch (e) {}
    box.classList.remove('open');
  }

  function open() { build(); box.classList.add('open'); }
  root.openCadFile = function (f) { build(); box.classList.add('open'); handleFile(f); };
  function inject() {
    if ($('dxf-btn')) return;
    var a = $('wall-measure-btn') || document.querySelector('button[onclick="addFloorRow()"]');
    if (!a) { setTimeout(inject, 400); return; }
    var b = document.createElement('button'); b.className = 'btn'; b.id = 'dxf-btn'; b.textContent = '📁 Import CAD (DWG / DXF)'; b.onclick = open;
    a.parentNode.insertBefore(b, a.nextSibling);
  }
  root.openDxf = open;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(inject, 300); }); else setTimeout(inject, 300);
})(typeof window !== 'undefined' ? window : globalThis);
