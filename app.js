/* Ranking Video Builder – läuft komplett im Browser.
 * Rendering: Canvas (1080x1920) + MediaRecorder (auf iOS Safari nativ H.264/AAC in MP4).
 * Ton: Web Audio (MediaElementSource -> MediaStreamDestination).
 */
'use strict';

(() => {
  const W = 1080;
  const H = 1920;
  const FPS = 30;
  const DEFAULT_DURATION = 7;
  const FONT = '-apple-system, "SF Pro Display", system-ui, "Helvetica Neue", "Arial Black", Arial, sans-serif';
  const MIN_TOTAL = 61;

  const $ = (id) => document.getElementById(id);
  const el = {
    title: $('title'),
    fileInput: $('fileInput'),
    autoPlaces: $('autoPlaces'),
    defaultDuration: $('defaultDuration'),
    applyDuration: $('applyDuration'),
    totalBar: $('totalBar'),
    totalTime: $('totalTime'),
    totalWarn: $('totalWarn'),
    clipCount: $('clipCount'),
    clipList: $('clipList'),
    emptyState: $('emptyState'),
    previewBtn: $('previewBtn'),
    exportBtn: $('exportBtn'),
    renderView: $('renderView'),
    renderStatus: $('renderStatus'),
    stage: $('stage'),
    progressBar: $('progressBar'),
    progressText: $('progressText'),
    cancelBtn: $('cancelBtn'),
    resultView: $('resultView'),
    resultVideo: $('resultVideo'),
    resultInfo: $('resultInfo'),
    shareBtn: $('shareBtn'),
    downloadLink: $('downloadLink'),
    closeResult: $('closeResult'),
    toast: $('toast'),
  };
  const players = [$('playerA'), $('playerB')];

  const state = {
    clips: [],
    nextId: 1,
  };

  // ---------- Hilfsfunktionen ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function fmtSec(sec) {
    return (Math.round(sec * 10) / 10).toLocaleString('de-DE') + ' s';
  }

  function parseNum(v) {
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }

  let toastTimer = null;
  function toast(msg, ms = 4500) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  // Wartet auf ein Event; lehnt bei 'error' oder Timeout ab.
  function once(target, event, timeoutMs, { softTimeout = false } = {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(event, onEvent);
        target.removeEventListener('error', onError);
      };
      const onEvent = () => { cleanup(); resolve(true); };
      const onError = () => { cleanup(); reject(new Error('Video konnte nicht geladen werden.')); };
      target.addEventListener(event, onEvent);
      target.addEventListener('error', onError);
      if (timeoutMs) {
        timer = setTimeout(() => {
          cleanup();
          if (softTimeout) resolve(false);
          else reject(new Error(`Zeitüberschreitung (${event}).`));
        }, timeoutMs);
      }
    });
  }

  // ---------- Einstellungen merken ----------

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('rvb-settings') || '{}');
      if (typeof s.title === 'string') el.title.value = s.title;
      if (s.defaultDuration) el.defaultDuration.value = s.defaultDuration;
      if (typeof s.autoPlaces === 'boolean') el.autoPlaces.checked = s.autoPlaces;
    } catch (_) { /* ignorieren */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem('rvb-settings', JSON.stringify({
        title: el.title.value,
        defaultDuration: el.defaultDuration.value,
        autoPlaces: el.autoPlaces.checked,
      }));
    } catch (_) { /* ignorieren */ }
  }

  function getDefaultDuration() {
    const d = parseNum(el.defaultDuration.value);
    return Number.isFinite(d) && d > 0 ? Math.min(d, 600) : DEFAULT_DURATION;
  }

  // ---------- Clips ----------

  function effectiveDuration(c) {
    let d = c.duration;
    if (c.srcDuration && Number.isFinite(c.srcDuration)) {
      d = Math.min(d, Math.max(0.1, c.srcDuration - c.start));
    }
    return d;
  }

  function totalDuration() {
    return state.clips.reduce((sum, c) => sum + effectiveDuration(c), 0);
  }

  function renumber() {
    if (!el.autoPlaces.checked) return;
    const n = state.clips.length;
    state.clips.forEach((c, i) => { c.place = n - i; });
  }

  function addFiles(files) {
    const vids = files.filter((f) => (f.type && f.type.startsWith('video/')) || /\.(mov|mp4|m4v|webm)$/i.test(f.name));
    if (!vids.length) {
      if (files.length) toast('Bitte Videodateien (MP4/MOV) auswählen.');
      return;
    }
    const dur = getDefaultDuration();
    for (const file of vids) {
      state.clips.push({
        id: state.nextId++,
        file,
        url: URL.createObjectURL(file),
        name: '',
        place: state.clips.length + 1,
        duration: dur,
        start: 0,
        srcDuration: null,
        thumb: null,
        loadError: false,
      });
    }
    renumber();
    renderList();
    queueProbe();
  }

  function removeClip(id) {
    const i = state.clips.findIndex((c) => c.id === id);
    if (i < 0) return;
    const [c] = state.clips.splice(i, 1);
    setTimeout(() => URL.revokeObjectURL(c.url), 1000);
    renumber();
    renderList();
  }

  function moveClip(id, delta) {
    const i = state.clips.findIndex((c) => c.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= state.clips.length) return;
    const [c] = state.clips.splice(i, 1);
    state.clips.splice(j, 0, c);
    renumber();
    renderList();
    const btn = el.clipList.querySelector(`[data-id="${id}"] .${delta < 0 ? 'up' : 'down'}`);
    if (btn && !btn.disabled) btn.focus({ preventScroll: true });
  }

  // Metadaten + Vorschaubild nacheinander laden (schont iOS-Speicher).
  let probing = false;
  async function queueProbe() {
    if (probing) return;
    probing = true;
    try {
      let c;
      while ((c = state.clips.find((x) => x.srcDuration === null && !x.loadError && !x.probed))) {
        c.probed = true;
        await probe(c);
        updateClipCard(c);
        updateTotals();
      }
    } finally {
      probing = false;
    }
  }

  async function probe(clip) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.src = clip.url;
    try {
      await once(v, 'loadedmetadata', 20000);
      const srcDuration = Number.isFinite(v.duration) ? v.duration : null;
      try {
        const t = Math.min(0.5, (v.duration || 1) / 3);
        v.currentTime = t;
        await once(v, 'seeked', 6000);
        if (v.readyState < 2) await once(v, 'loadeddata', 3000, { softTimeout: true });
        const tw = 144;
        const th = 256;
        const cv = document.createElement('canvas');
        cv.width = tw;
        cv.height = th;
        const cx = cv.getContext('2d');
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        if (vw && vh) {
          const s = Math.max(tw / vw, th / vh);
          cx.drawImage(v, (tw - vw * s) / 2, (th - vh * s) / 2, vw * s, vh * s);
          clip.thumb = cv.toDataURL('image/jpeg', 0.7);
        }
      } catch (_) { /* Vorschaubild optional */ }
      clip.srcDuration = srcDuration;
    } catch (e) {
      clip.loadError = true;
    } finally {
      v.removeAttribute('src');
      v.load();
    }
  }

  // ---------- Liste rendern ----------

  function renderList() {
    const list = el.clipList;
    list.innerHTML = '';
    state.clips.forEach((c, i) => list.appendChild(buildCard(c, i)));
    el.emptyState.hidden = state.clips.length > 0;
    updateTotals();
  }

  function buildCard(c, i) {
    const li = document.createElement('li');
    li.className = 'clip';
    li.dataset.id = c.id;
    li.innerHTML = `
      <div class="handle" tabindex="0" role="button" aria-label="Ziehen zum Verschieben">☰</div>
      <div class="thumb"></div>
      <div class="clip-fields">
        <div>
          <label>Platz</label>
          <input class="place-input" type="number" inputmode="numeric" min="0" step="1">
        </div>
        <div>
          <label>Name</label>
          <input class="name-input" type="text" placeholder="Name" autocomplete="off" enterkeyhint="done">
        </div>
        <div>
          <label>Dauer (s)</label>
          <input class="dur-input" type="number" inputmode="decimal" min="0.5" step="0.5">
        </div>
        <div>
          <label>Start ab Sekunde</label>
          <input class="start-input" type="number" inputmode="decimal" min="0" step="0.5">
        </div>
      </div>
      <div class="clip-meta">
        <span class="clip-info"></span>
        <span class="clip-btns">
          <button class="icon-btn up" type="button" aria-label="Nach oben">▲</button>
          <button class="icon-btn down" type="button" aria-label="Nach unten">▼</button>
          <button class="icon-btn del" type="button" aria-label="Entfernen">✕</button>
        </span>
      </div>`;

    const q = (s) => li.querySelector(s);
    const placeIn = q('.place-input');
    const nameIn = q('.name-input');
    const durIn = q('.dur-input');
    const startIn = q('.start-input');

    placeIn.value = c.place ?? '';
    nameIn.value = c.name;
    durIn.value = c.duration;
    startIn.value = c.start;

    placeIn.addEventListener('input', () => {
      const n = parseInt(placeIn.value, 10);
      c.place = Number.isFinite(n) ? n : null;
      if (el.autoPlaces.checked) {
        el.autoPlaces.checked = false;
        saveSettings();
        toast('Automatische Nummerierung ausgeschaltet – du vergibst die Plätze jetzt selbst.');
      }
    });
    nameIn.addEventListener('input', () => { c.name = nameIn.value; });
    durIn.addEventListener('input', () => {
      const d = parseNum(durIn.value);
      if (Number.isFinite(d) && d > 0) { c.duration = Math.min(d, 600); updateClipCard(c); updateTotals(); }
    });
    durIn.addEventListener('blur', () => { durIn.value = c.duration; });
    startIn.addEventListener('input', () => {
      const s = parseNum(startIn.value);
      if (Number.isFinite(s) && s >= 0) {
        c.start = c.srcDuration ? Math.min(s, Math.max(0, c.srcDuration - 0.5)) : s;
        updateClipCard(c);
        updateTotals();
      }
    });
    startIn.addEventListener('blur', () => { startIn.value = c.start; });

    q('.up').disabled = i === 0;
    q('.down').disabled = i === state.clips.length - 1;
    q('.up').addEventListener('click', () => moveClip(c.id, -1));
    q('.down').addEventListener('click', () => moveClip(c.id, 1));
    q('.del').addEventListener('click', () => {
      if (confirm('Diesen Clip entfernen?')) removeClip(c.id);
    });

    const handle = q('.handle');
    handle.addEventListener('pointerdown', (e) => startDrag(e, li));
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); moveClip(c.id, -1); focusHandle(c.id); }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveClip(c.id, 1); focusHandle(c.id); }
    });

    fillCardInfo(li, c);
    return li;
  }

  function focusHandle(id) {
    const h = el.clipList.querySelector(`[data-id="${id}"] .handle`);
    if (h) h.focus({ preventScroll: false });
  }

  function fillCardInfo(li, c) {
    const thumb = li.querySelector('.thumb');
    if (c.thumb && !thumb.querySelector('img')) {
      thumb.innerHTML = '';
      const img = new Image();
      img.src = c.thumb;
      img.alt = '';
      thumb.appendChild(img);
    } else if (!c.thumb) {
      thumb.textContent = c.loadError ? '⚠️' : '🎞️';
    }
    const info = li.querySelector('.clip-info');
    const eff = effectiveDuration(c);
    info.classList.remove('short');
    if (c.loadError) {
      info.textContent = '⚠️ Video kann nicht gelesen werden';
      info.classList.add('short');
    } else if (c.srcDuration == null) {
      info.textContent = 'Lade…';
    } else if (eff < c.duration - 0.05) {
      info.textContent = `Clip nur ${fmtSec(c.srcDuration - c.start)} → ${fmtSec(eff)}`;
      info.classList.add('short');
    } else {
      info.textContent = `Original ${fmtSec(c.srcDuration)} → ${fmtSec(eff)}`;
    }
  }

  function updateClipCard(c) {
    const li = el.clipList.querySelector(`[data-id="${c.id}"]`);
    if (li) fillCardInfo(li, c);
  }

  function updatePlaceInputs() {
    state.clips.forEach((c) => {
      const inp = el.clipList.querySelector(`[data-id="${c.id}"] .place-input`);
      if (inp) inp.value = c.place ?? '';
    });
  }

  function updateTotals() {
    const n = state.clips.length;
    const total = totalDuration();
    el.totalTime.textContent = fmtTime(total);
    el.clipCount.textContent = `${n} ${n === 1 ? 'Clip' : 'Clips'} · ${fmtSec(total)}`;
    const warn = n > 0 && total < MIN_TOTAL;
    el.totalWarn.hidden = !warn;
    el.totalWarn.textContent = warn ? `⚠️ Unter ${MIN_TOTAL} Sekunden (noch ${fmtSec(MIN_TOTAL - total)})` : '';
    el.totalBar.classList.toggle('warn', warn);
    el.totalBar.classList.toggle('ok', n > 0 && !warn);
    const usable = state.clips.some((c) => !c.loadError);
    el.exportBtn.disabled = !usable;
    el.previewBtn.disabled = !usable;
  }

  // ---------- Drag & Drop (Touch + Maus über Pointer Events) ----------

  function startDrag(e, li) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
    const list = el.clipList;
    li.classList.add('dragging');
    let startPageY = e.pageY;
    let lastClientY = e.clientY;
    let lastPageY = e.pageY;
    let raf = 0;
    let moved = false;

    const apply = () => {
      const dy = lastPageY - startPageY;
      li.style.transform = `translateY(${dy}px)`;
      const r = li.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const next = li.nextElementSibling;
      const prev = li.previousElementSibling;
      if (next) {
        const nr = next.getBoundingClientRect();
        if (mid > nr.top + nr.height / 2) {
          const before = li.offsetTop;
          list.insertBefore(next, li);
          startPageY += li.offsetTop - before;
          moved = true;
          li.style.transform = `translateY(${lastPageY - startPageY}px)`;
          return;
        }
      }
      if (prev) {
        const pr = prev.getBoundingClientRect();
        if (mid < pr.top + pr.height / 2) {
          const before = li.offsetTop;
          // Nachbarn verschieben statt li selbst – sonst geht die Pointer-Capture verloren
          list.insertBefore(prev, li.nextSibling);
          startPageY += li.offsetTop - before;
          moved = true;
          li.style.transform = `translateY(${lastPageY - startPageY}px)`;
        }
      }
    };

    // Automatisches Scrollen am Bildschirmrand
    const autoScroll = () => {
      const edge = 90;
      let v = 0;
      if (lastClientY < edge + 60) v = -Math.ceil((edge + 60 - lastClientY) / 6);
      else if (lastClientY > window.innerHeight - edge) v = Math.ceil((lastClientY - (window.innerHeight - edge)) / 6);
      if (v) {
        const beforeY = window.scrollY;
        window.scrollBy(0, v);
        lastPageY += window.scrollY - beforeY;
        apply();
      }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);

    const onMove = (ev) => {
      ev.preventDefault();
      lastClientY = ev.clientY;
      lastPageY = ev.pageY;
      apply();
    };
    const onUp = () => {
      cancelAnimationFrame(raf);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      li.classList.remove('dragging');
      li.style.transform = '';
      if (moved) {
        const order = [...list.children].map((x) => Number(x.dataset.id));
        state.clips.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        renumber();
        renderList();
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  // ---------- Text / Overlays ----------

  function fontStr(size) {
    return `900 ${Math.round(size)}px ${FONT}`;
  }

  function wrapLines(ctx, text, maxWidth) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width <= maxWidth || !line) line = test;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Passt Schriftgröße an, bis Text in maxLines Zeilen und Breite passt.
  function fitText(ctx, text, maxWidth, startSize, minSize, maxLines) {
    let size = startSize;
    for (;;) {
      ctx.font = fontStr(size);
      const lines = wrapLines(ctx, text, maxWidth);
      const widest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
      if ((lines.length <= maxLines && widest <= maxWidth) || size <= minSize) {
        return { size, lines };
      }
      size = Math.max(minSize, size * 0.92);
    }
  }

  function outlinedText(ctx, text, x, y, size) {
    ctx.font = fontStr(size);
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(8, size * 0.2);
    ctx.strokeStyle = '#000';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y);
  }

  function renderTitle(title) {
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = 520;
    const cx = cv.getContext('2d');
    if (!title.trim()) return cv;
    const { size, lines } = fitText(cx, title, 940, 96, 52, 3);
    cx.textAlign = 'center';
    cx.textBaseline = 'alphabetic';
    const lh = size * 1.13;
    let y = 40 + size * 0.9;
    for (const l of lines) {
      outlinedText(cx, l, W / 2, y, size);
      y += lh;
    }
    return cv;
  }

  // Unteres Overlay: große Platznummer + Name. Unterkante bei BOTTOM_Y.
  const BOTTOM_H = 760;
  const BOTTOM_Y = 1500; // oberhalb der TikTok-Beschriftung
  function renderBottom(place, name) {
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = BOTTOM_H;
    const cx = cv.getContext('2d');
    cx.textAlign = 'center';
    cx.textBaseline = 'alphabetic';
    let y = BOTTOM_H - 40; // Grundlinie der letzten Zeile
    let numberCenterY = BOTTOM_H / 2;
    if (name && name.trim()) {
      const { size, lines } = fitText(cx, name, 900, 118, 56, 2);
      const lh = size * 1.12;
      const startY = y - lh * (lines.length - 1);
      lines.forEach((l, i) => outlinedText(cx, l, W / 2, startY + i * lh, size));
      y = startY - size * 0.95;
    }
    if (place !== null && place !== undefined && place !== '') {
      const txt = `#${place}`;
      const { size } = fitText(cx, txt, 900, 280, 120, 1);
      outlinedText(cx, txt, W / 2, y, size);
      numberCenterY = y - size * 0.36;
    }
    return { canvas: cv, pivotY: numberCenterY };
  }

  function easeOutBack(x) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  // ---------- Rendering-Engine ----------

  const ctx = el.stage.getContext('2d', { alpha: false });
  let audioCtx = null;
  let job = null; // aktueller Render-/Exportvorgang

  function drawFrame(video, overlay, titleCv, t) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return false; // letztes Bild stehen lassen
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s;
    const dh = vh * s;
    ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
    drawOverlays(overlay, titleCv, t);
    return true;
  }

  function drawOverlays(overlay, titleCv, t) {
    ctx.drawImage(titleCv, 0, 160);
    if (overlay) {
      const top = BOTTOM_Y - BOTTOM_H;
      const x = Math.min(1, Math.max(0, t / 0.4));
      const sc = x >= 1 ? 1 : 0.4 + 0.6 * easeOutBack(x);
      if (sc === 1) {
        ctx.drawImage(overlay.canvas, 0, top);
      } else {
        const py = top + overlay.pivotY;
        ctx.save();
        ctx.translate(W / 2, py);
        ctx.scale(sc, sc);
        ctx.globalAlpha = Math.min(1, x * 3);
        ctx.drawImage(overlay.canvas, -W / 2, -overlay.pivotY);
        ctx.restore();
      }
    }
  }

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.4d0028,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const m of candidates) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) { /* weiter */ }
    }
    return '';
  }

  function setupAudio(mode) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
      for (const p of players) {
        if (!p._gain) {
          p._source = audioCtx.createMediaElementSource(p);
          p._gain = audioCtx.createGain();
          p._source.connect(p._gain);
        }
        try { p._gain.disconnect(); } catch (_) { /* ok */ }
        p._gain.gain.value = 0;
      }
      if (mode === 'export') {
        const dest = audioCtx.createMediaStreamDestination();
        players.forEach((p) => p._gain.connect(dest));
        return dest;
      }
      players.forEach((p) => p._gain.connect(audioCtx.destination));
      return audioCtx.destination;
    } catch (e) {
      console.warn('Audio-Setup fehlgeschlagen', e);
      return null;
    }
  }

  function setGain(p, v) {
    if (!p._gain || !audioCtx) return;
    const g = p._gain.gain;
    const now = audioCtx.currentTime;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(v, now + 0.03);
    } catch (_) { g.value = v; }
  }

  async function preparePlayer(p, clip) {
    if (p._clipUrl !== clip.url) {
      p._clipUrl = clip.url;
      p.src = clip.url;
      p.load();
    }
    if (p.readyState < 1) await once(p, 'loadedmetadata', 20000);
    if (Math.abs(p.currentTime - clip.start) > 0.02) {
      p.currentTime = clip.start;
      await once(p, 'seeked', 10000, { softTimeout: true });
    }
    if (p.readyState < 2) await once(p, 'canplay', 4000, { softTimeout: true });
  }

  async function safePlay(p) {
    try {
      await p.play();
    } catch (e) {
      if (e && e.name === 'NotAllowedError' && !p.muted) {
        // Ton wurde blockiert – stumm weiter, damit das Video trotzdem entsteht.
        p.muted = true;
        job.audioBlocked = true;
        await p.play();
      } else {
        throw e;
      }
    }
  }

  function abortError() {
    const e = new Error('abgebrochen');
    e.aborted = true;
    return e;
  }

  // Wird synchron im Klick-Handler aufgerufen (iOS: Medien-Freigabe braucht Nutzergeste).
  function startJob(mode) {
    if (job) return;
    const clips = state.clips.filter((c) => !c.loadError);
    if (!clips.length) return;

    let mimeType = null;
    if (mode === 'export') {
      mimeType = pickMimeType();
      if (mimeType === null || typeof el.stage.captureStream !== 'function') {
        toast('Dieser Browser kann keine Videos aufnehmen. Bitte Safari ab iOS 14.5 verwenden.', 7000);
        return;
      }
    }

    job = {
      mode,
      mimeType,
      aborted: false,
      audioBlocked: false,
      clips,
      recorder: null,
      wakeLock: null,
    };

    // --- synchron in der Nutzergeste ---
    const dest = setupAudio(mode);
    job.audioDest = dest;
    players.forEach((p, i) => {
      const c = clips[Math.min(i, clips.length - 1)];
      p.muted = false;
      if (p._clipUrl !== c.url) {
        p._clipUrl = c.url;
        p.src = c.url;
      }
      const pr = p.play();
      p._unlock = Promise.resolve(pr).then(() => { if (!job || !job.started) p.pause(); }).catch(() => {});
    });
    if (navigator.audioSession) {
      try { navigator.audioSession.type = 'playback'; } catch (_) { /* ok */ }
    }

    el.renderStatus.textContent = mode === 'export' ? 'Video wird erstellt…' : 'Vorschau';
    el.cancelBtn.textContent = mode === 'export' ? 'Abbrechen' : 'Vorschau beenden';
    el.progressBar.style.width = '0%';
    el.progressText.textContent = 'Vorbereiten…';
    el.renderView.hidden = false;
    document.body.style.overflow = 'hidden';

    runJob(job).then((result) => {
      if (result) showResult(result);
    }).catch((err) => {
      if (!err || !err.aborted) {
        console.error(err);
        toast(`Fehler: ${err && err.message ? err.message : err}`, 8000);
      }
    }).finally(() => {
      cleanupJob();
    });
  }

  async function runJob(j) {
    if (navigator.wakeLock) {
      navigator.wakeLock.request('screen').then((l) => { j.wakeLock = l; }).catch(() => {});
    }
    // Freigabe-Play abwarten (max. 3 s), bevor wir die Player benutzen.
    await Promise.race([Promise.all(players.map((p) => p._unlock)), sleep(3000)]);
    players.forEach((p) => p.pause());
    if (j.aborted) throw abortError();

    const plan = j.clips.map((c) => ({
      clip: c,
      dur: effectiveDuration(c),
      overlay: renderBottom(c.place, c.name),
    }));
    const titleCv = renderTitle(el.title.value);
    const total = plan.reduce((s, x) => s + x.dur, 0);
    let before = 0;
    plan.forEach((x) => { x.offset = before; before += x.dur; });

    // Clip 1 & 2 vorbereiten
    await preparePlayer(players[0], plan[0].clip);
    const prep = [Promise.resolve(), plan[1] ? preparePlayer(players[1], plan[1].clip) : Promise.resolve()];
    prep[1].catch(() => {});
    if (j.aborted) throw abortError();

    // Erstes Bild zeichnen (Recorder braucht einen Frame, bevor er startet)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawFrame(players[0], plan[0].overlay, titleCv, 0);

    let chunks = [];
    if (j.mode === 'export') {
      const stream = el.stage.captureStream(FPS);
      if (j.audioDest && j.audioDest.stream) {
        j.audioDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      }
      const opts = { videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 192_000 };
      if (j.mimeType) opts.mimeType = j.mimeType;
      let rec;
      try {
        rec = new MediaRecorder(stream, opts);
      } catch (_) {
        rec = new MediaRecorder(stream);
      }
      j.recorder = rec;
      j.stream = stream;
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      j.stopped = new Promise((r) => { rec.onstop = r; });
      rec.start(1000);
      await sleep(150); // Encoder anlaufen lassen
    }

    j.started = true;
    let current = null;
    let lastProgress = 0;

    // Zeichen-Schleife
    const tick = () => {
      if (!job || job !== j) return;
      if (current) {
        const t = Math.max(0, current.p.currentTime - current.item.clip.start);
        drawFrame(current.p, current.item.overlay, titleCv, t);
        const done = current.item.offset + Math.min(t, current.item.dur);
        const pct = total ? Math.min(100, (done / total) * 100) : 0;
        if (performance.now() - lastProgress > 200) {
          lastProgress = performance.now();
          el.progressBar.style.width = pct.toFixed(1) + '%';
          el.progressText.textContent = `Clip ${current.index + 1} von ${plan.length} · ${fmtTime(done)} / ${fmtTime(total)}`;
        }
        if (current.p.ended || t >= current.item.dur - 0.012) {
          const r = current.resolve;
          current.resolve = null;
          if (r) r();
        }
        // Hängt der Clip? (keine Zeitänderung für 10 s)
        if (current.p.currentTime !== current.lastT) {
          current.lastT = current.p.currentTime;
          current.lastChange = performance.now();
        } else if (performance.now() - current.lastChange > 10000 && current.reject) {
          current.reject(new Error(`Clip ${current.index + 1} hängt beim Abspielen.`));
          current.reject = null;
        }
      }
      j.raf = requestAnimationFrame(tick);
    };
    j.raf = requestAnimationFrame(tick);

    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      const p = players[i % 2];
      await prep[i % 2];
      if (j.aborted) throw abortError();

      const finished = new Promise((resolve, reject) => {
        current = { p, item, index: i, resolve, reject, lastT: -1, lastChange: performance.now() };
        j.rejectCurrent = reject;
      });
      finished.catch(() => {});
      await safePlay(p);
      setGain(p, 1);

      if (i > 0) {
        const q = players[(i - 1) % 2];
        q.pause();
        setGain(q, 0);
        if (plan[i + 1]) {
          prep[(i + 1) % 2] = preparePlayer(q, plan[i + 1].clip);
          prep[(i + 1) % 2].catch(() => {});
        }
      }
      await finished;
      if (j.aborted) throw abortError();
    }

    // Ende
    const last = players[(plan.length - 1) % 2];
    setGain(last, 0);
    last.pause();
    el.progressBar.style.width = '100%';

    if (j.mode !== 'export') return null;

    el.progressText.textContent = 'Speichere Video…';
    await sleep(120);
    if (j.recorder.state !== 'inactive') {
      try { j.recorder.requestData(); } catch (_) { /* ok */ }
      j.recorder.stop();
    }
    await j.stopped;
    const type = (j.recorder.mimeType || j.mimeType || 'video/mp4').split(';')[0];
    const blob = new Blob(chunks, { type });
    chunks = [];
    if (!blob.size) throw new Error('Das aufgenommene Video ist leer.');
    return { blob, type, total, audioBlocked: j.audioBlocked };
  }

  function cleanupJob() {
    const j = job;
    job = null;
    if (!j) return;
    cancelAnimationFrame(j.raf);
    players.forEach((p) => {
      try { p.pause(); } catch (_) { /* ok */ }
      if (p._gain) p._gain.gain.value = 0;
    });
    if (j.recorder && j.recorder.state !== 'inactive') {
      try { j.recorder.stop(); } catch (_) { /* ok */ }
    }
    if (j.stream) j.stream.getVideoTracks().forEach((t) => t.stop());
    if (j.wakeLock) j.wakeLock.release().catch(() => {});
    el.renderView.hidden = true;
    document.body.style.overflow = '';
  }

  function cancelJob(reason) {
    if (!job) return;
    job.aborted = true;
    if (job.rejectCurrent) job.rejectCurrent(abortError());
    if (reason) toast(reason, 7000);
  }

  // ---------- Ergebnis ----------

  let resultUrl = null;
  let resultFile = null;

  function slug(s) {
    return (s || 'ranking').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'ranking';
  }

  function showResult({ blob, type, total, audioBlocked }) {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    const ext = type.includes('mp4') ? 'mp4' : type.includes('webm') ? 'webm' : 'mp4';
    const name = `${slug(el.title.value)}.${ext}`;
    resultFile = new File([blob], name, { type });
    el.resultVideo.src = resultUrl;
    el.downloadLink.href = resultUrl;
    el.downloadLink.download = name;
    const mb = (blob.size / 1024 / 1024).toFixed(1).replace('.', ',');
    let info = `${fmtTime(total)} · 1080×1920 · ${ext.toUpperCase()} · ${mb} MB`;
    if (ext !== 'mp4') info += ' – Dieser Browser kann kein MP4 aufnehmen (auf dem iPhone mit Safari entsteht MP4).';
    if (audioBlocked) info += ' – Hinweis: Ton wurde vom Browser blockiert.';
    el.resultInfo.textContent = info;
    el.shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [resultFile] }));
    el.resultView.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  el.shareBtn.addEventListener('click', async () => {
    if (!resultFile) return;
    try {
      await navigator.share({ files: [resultFile], title: el.title.value || 'Ranking Video' });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Teilen nicht möglich – nutze „Herunterladen“.');
    }
  });

  el.closeResult.addEventListener('click', () => {
    el.resultView.hidden = true;
    el.resultVideo.pause();
    document.body.style.overflow = '';
  });

  // ---------- Events ----------

  el.fileInput.addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });

  el.title.addEventListener('input', saveSettings);
  el.defaultDuration.addEventListener('change', saveSettings);

  el.autoPlaces.addEventListener('change', () => {
    saveSettings();
    if (el.autoPlaces.checked) {
      renumber();
      updatePlaceInputs();
    }
  });

  el.applyDuration.addEventListener('click', () => {
    const d = getDefaultDuration();
    el.defaultDuration.value = d;
    state.clips.forEach((c) => { c.duration = d; });
    saveSettings();
    renderList();
    if (state.clips.length) toast(`Alle Clips auf ${fmtSec(d)} gesetzt.`);
  });

  el.exportBtn.addEventListener('click', () => startJob('export'));
  el.previewBtn.addEventListener('click', () => startJob('preview'));
  el.cancelBtn.addEventListener('click', () => cancelJob());

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !job) return;
    if (job.mode === 'export') {
      cancelJob('Export abgebrochen, weil die App verlassen wurde. Bitte erneut starten und Safari im Vordergrund lassen.');
    } else {
      cancelJob();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.clips.length) { e.preventDefault(); e.returnValue = ''; }
  });

  loadSettings();
  renderList();

  // Für automatisierte Tests
  window.__rvb = { state, renderList, effectiveDuration, totalDuration, pickMimeType };
})();
