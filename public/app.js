(() => {
  'use strict';

  const state = {
    config: null,
    inspect: null,
    format: 'mp4',
    quality: 'best',
    bitrate: '192',
    eventSource: null,
  };

  // ---------- view management ----------

  const views = document.querySelectorAll('.view');
  const navButtons = document.querySelectorAll('[data-nav]');

  function showView(name) {
    if (state.eventSource && name !== 'download') {
      state.eventSource.close(); // also cancels the in-flight job server-side
      state.eventSource = null;
    }
    views.forEach((v) => v.classList.toggle('is-visible', v.id === `view-${name}`));
    navButtons.forEach((b) => {
      if (b.dataset.nav === name) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    if (name === 'home') loadHealth();
    if (name === 'history') loadHistory();
    if (name === 'settings') loadSettings();
  }

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.nav));
  });

  // ---------- helpers ----------

  function bytesToHuman(bytes) {
    if (!bytes && bytes !== 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDuration(totalSeconds) {
    if (typeof totalSeconds !== 'number') return null;
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Error codes that mean the backend/Cobalt/infra failed (spec's "COBALT
  // ERROR" framing: status + reason), as opposed to the user's input being
  // wrong (spec's plain "ERROR": invalid URL, unsupported domain, video
  // unavailable) — see src/errors/downloader-errors.js for the full list.
  const BACKEND_ERROR_CODES = new Set([
    'API_ERROR', 'AUTHENTICATION_ERROR', 'RATE_LIMIT', 'TIMEOUT',
    'CONFIGURATION_ERROR', 'PROCESSING_ERROR', 'DOWNLOAD_ERROR',
    'FILESYSTEM_ERROR', 'SECURITY_ERROR', 'NETWORK_ERROR',
    'CONNECTION_LOST', 'INTERNAL_ERROR',
  ]);

  function renderErrorBox(container, { code, message }) {
    const cobalt = BACKEND_ERROR_CODES.has(code);
    container.innerHTML = '';
    container.classList.remove('hidden');
    const box = document.createElement('div');
    box.className = 'error-box';
    box.setAttribute('role', 'alert');
    const title = document.createElement('div');
    title.className = 'kv-title';
    title.textContent = cobalt ? 'COBALT ERROR' : 'ERROR';
    box.appendChild(title);

    const messageRow = document.createElement('div');
    messageRow.style.marginBottom = '0.5rem';
    messageRow.textContent = message;
    box.appendChild(messageRow);

    const reasonRow = document.createElement('div');
    reasonRow.className = 'kv-row';
    reasonRow.innerHTML = `<span class="k">${cobalt ? 'status' : 'reason'}</span><span class="v">${code}</span>`;
    box.appendChild(reasonRow);

    container.appendChild(box);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry-link';
    retry.textContent = 'tentar outra URL';
    retry.addEventListener('click', () => showView('home'));
    container.appendChild(retry);
  }

  // ---------- health / status ----------

  function applyStatus(el, dotEl, state_, extra) {
    el.dataset.state = state_;
    if (dotEl) dotEl.dataset.state = state_;
    const label = { connected: 'connected', ready: 'ready', unavailable: 'unavailable', misconfigured: 'misconfigured', unsupported: 'unsupported', unknown: 'checking...' }[state_] || state_;
    el.querySelector('.status-dot')?.setAttribute('data-state', state_);
    const textNode = extra ? `${label} (${extra})` : label;
    el.lastChild.textContent = ` ${textNode}`;
  }

  async function loadHealth() {
    try {
      const res = await fetch('/api/health');
      const body = await res.json();
      applyStatus(document.getElementById('status-cobalt'), null, body.cobalt.state, body.cobalt.version);
      applyStatus(document.getElementById('status-ffmpeg'), null, body.ffmpeg.state);
      applyStatus(document.getElementById('status-storage'), null, body.storage.state);
    } catch {
      ['status-cobalt', 'status-ffmpeg', 'status-storage'].forEach((id) => applyStatus(document.getElementById(id), null, 'unavailable'));
    }
  }

  // ---------- home / url submit ----------

  const urlForm = document.getElementById('url-form');
  const urlInput = document.getElementById('url-input');
  const enterBtn = document.getElementById('enter-btn');

  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    enterBtn.disabled = true;
    startInspect(url).finally(() => { enterBtn.disabled = false; });
  });

  // ---------- inspect ----------

  const inspectLoading = document.getElementById('inspect-loading');
  const inspectResult = document.getElementById('inspect-result');
  const inspectError = document.getElementById('inspect-error');

  async function ensureConfig() {
    if (state.config) return state.config;
    const res = await fetch('/api/config');
    state.config = await res.json();
    return state.config;
  }

  async function startInspect(url) {
    state.url = url;
    showView('inspect');
    inspectLoading.classList.remove('hidden');
    inspectResult.classList.add('hidden');
    inspectError.classList.add('hidden');

    try {
      await ensureConfig();
      const res = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const body = await res.json();
      inspectLoading.classList.add('hidden');

      if (!res.ok) {
        renderErrorBox(inspectError, body);
        return;
      }

      state.inspect = body;
      state.format = state.config.defaults.format;
      state.quality = state.config.defaults.quality;
      state.bitrate = state.config.defaults.bitrate;
      renderInspectResult(body);
    } catch {
      inspectLoading.classList.add('hidden');
      renderErrorBox(inspectError, { code: 'NETWORK_ERROR', message: 'Não foi possível conectar ao servidor.' });
    }
  }

  function renderInspectResult(info) {
    document.getElementById('source-thumb').src = info.thumbnail || '';
    document.getElementById('source-thumb').alt = info.title ? `Miniatura de ${info.title}` : '';
    document.getElementById('source-service').textContent = info.service;
    document.getElementById('source-title').textContent = info.title;
    document.getElementById('source-duration').textContent = info.durationAvailable ? formatDuration(info.durationSeconds) : 'indisponível';
    document.getElementById('source-author').textContent = info.author || 'desconhecido';
    document.getElementById('source-availability').textContent = info.availability === 'available' ? 'public' : info.availability;

    renderFormatChoices();
    renderQualityChoices();
    inspectResult.classList.remove('hidden');
  }

  function renderFormatChoices() {
    const wrap = document.getElementById('format-choices');
    wrap.innerHTML = '';
    for (const fmt of state.config.formats) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice-btn';
      btn.textContent = `[ ${fmt.toUpperCase()} ]`;
      btn.setAttribute('aria-pressed', String(fmt === state.format));
      btn.addEventListener('click', () => {
        state.format = fmt;
        renderFormatChoices();
        renderQualityChoices();
      });
      wrap.appendChild(btn);
    }
  }

  function renderQualityChoices() {
    const label = document.getElementById('quality-label');
    const wrap = document.getElementById('quality-choices');
    wrap.innerHTML = '';

    if (state.format === 'mp3') {
      label.textContent = 'bitrate';
      for (const br of state.config.audioBitrates) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'choice-btn';
        btn.textContent = `[ ${br}K ]`;
        btn.setAttribute('aria-pressed', String(br === state.bitrate));
        btn.addEventListener('click', () => { state.bitrate = br; renderQualityChoices(); });
        wrap.appendChild(btn);
      }
    } else {
      label.textContent = 'quality';
      for (const q of state.config.videoQualities) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'choice-btn';
        btn.textContent = `[ ${q.toUpperCase()} ]`;
        btn.setAttribute('aria-pressed', String(q === state.quality));
        btn.addEventListener('click', () => { state.quality = q; renderQualityChoices(); });
        wrap.appendChild(btn);
      }
    }
  }

  document.getElementById('download-btn').addEventListener('click', () => {
    startDownload();
  });

  // ---------- download progress ----------

  const STEP_LABELS = {
    'Validando URL...': 'resolving source',
    'Obtendo mídia...': 'connecting cobalt',
    'Baixando...': 'requesting stream',
    'Processando...': 'processing',
    'Convertendo...': 'converting audio',
    'Finalizando...': 'validating output',
    'Concluído.': 'done',
  };
  const BAR_WIDTH = 20;

  function renderBar(percent) {
    const filled = Math.round((percent / 100) * BAR_WIDTH);
    return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled) + ` ${Math.round(percent)}%`;
  }

  function startDownload() {
    showView('download');
    const log = document.getElementById('download-log');
    const errorBox = document.getElementById('download-error');
    log.innerHTML = '';
    errorBox.classList.add('hidden');

    let currentKey = null;
    let currentLine = null;

    function appendLine(label) {
      const line = document.createElement('div');
      line.className = 'log-line is-active';
      line.innerHTML = `<span class="log-label">${label}</span><span class="log-status"><span class="cursor-blink" aria-hidden="true"></span></span>`;
      log.appendChild(line);
      return line;
    }

    function markDone(line, text = 'OK') {
      if (!line) return;
      line.classList.remove('is-active');
      line.classList.add('is-done');
      line.querySelector('.log-status').textContent = text;
    }

    const qs = new URLSearchParams({
      url: state.url,
      format: state.format,
      quality: state.quality,
      bitrate: state.bitrate,
    });
    const source = new EventSource(`/api/download-stream?${qs.toString()}`);
    state.eventSource = source;

    source.addEventListener('progress', (ev) => {
      const { step, percent } = JSON.parse(ev.data);
      const label = STEP_LABELS[step] || step;

      if (step !== currentKey) {
        markDone(currentLine);
        currentKey = step;
        currentLine = appendLine(label);
      }

      if (typeof percent === 'number') {
        currentLine.querySelector('.log-status').innerHTML = `<span class="progress-track">${renderBar(percent)}</span>`;
      } else if (step === 'Concluído.') {
        markDone(currentLine);
      }
    });

    source.addEventListener('done', (ev) => {
      markDone(currentLine);
      const data = JSON.parse(ev.data);
      source.close();
      state.eventSource = null;
      renderDone(data);
    });

    source.addEventListener('error', (ev) => {
      source.close();
      state.eventSource = null;
      if (currentLine) markDone(currentLine, 'FAIL');
      if (ev.data) {
        renderErrorBox(errorBox, JSON.parse(ev.data));
      } else {
        renderErrorBox(errorBox, { code: 'CONNECTION_LOST', message: 'A conexão com o servidor foi perdida.' });
      }
    });
  }

  function renderDone(data) {
    showView('done');
    document.getElementById('done-name').textContent = data.filename;
    document.getElementById('done-size').textContent = bytesToHuman(data.sizeBytes);
    document.getElementById('done-type').textContent = data.format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
    const saveBtn = document.getElementById('save-file-btn');
    saveBtn.href = data.downloadUrl;
    saveBtn.setAttribute('download', data.filename);
  }

  // ---------- history ----------

  async function loadHistory() {
    const container = document.getElementById('history-content');
    container.innerHTML = '<div class="prompt-line">loading...</div>';
    try {
      const res = await fetch('/api/history');
      const { history } = await res.json();
      if (history.length === 0) {
        container.innerHTML = '<div class="empty-note">nenhum download ainda.</div>';
        return;
      }
      const table = document.createElement('table');
      table.className = 'data-table';
      table.innerHTML = `<thead><tr><th>data</th><th>arquivo</th><th>qualidade/bitrate</th><th>tamanho</th></tr></thead>`;
      const tbody = document.createElement('tbody');
      for (const item of history) {
        const tr = document.createElement('tr');
        const when = new Date(item.timestamp).toISOString().replace('T', ' ').slice(0, 16);
        const spec = item.format === 'mp3' ? `${item.bitrate}k` : (item.quality || '—');
        tr.innerHTML = `<td>${when}</td><td>${item.filename}</td><td>${spec}</td><td>${bytesToHuman(item.sizeBytes)}</td>`;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      container.innerHTML = '';
      container.appendChild(table);
    } catch {
      container.innerHTML = '<div class="empty-note">não foi possível carregar o histórico.</div>';
    }
  }

  // ---------- settings ----------

  async function loadSettings() {
    const container = document.getElementById('settings-content');
    container.innerHTML = '<div class="prompt-line">loading...</div>';
    try {
      const [healthRes, cfg] = await Promise.all([fetch('/api/health').then((r) => r.json()), ensureConfig()]);

      container.innerHTML = '';

      const cobaltSection = document.createElement('div');
      cobaltSection.className = 'settings-section';
      cobaltSection.innerHTML = `
        <div class="heading">COBALT</div>
        <div class="kv-row"><span class="k">endpoint</span><span class="v">${healthRes.cobalt.state === 'misconfigured' ? 'não configurado' : 'configurado'}</span></div>
        <div class="kv-row"><span class="k">status</span><span class="v">${healthRes.cobalt.state}${healthRes.cobalt.version ? ` (v${healthRes.cobalt.version})` : ''}</span></div>
      `;

      const downloadSection = document.createElement('div');
      downloadSection.className = 'settings-section';
      downloadSection.innerHTML = `
        <div class="heading">DOWNLOAD</div>
        <div class="kv-row"><span class="k">format</span><span class="v">${cfg.defaults.format.toUpperCase()}</span></div>
        <div class="kv-row"><span class="k">quality</span><span class="v">${cfg.defaults.quality.toUpperCase()}</span></div>
      `;

      const systemSection = document.createElement('div');
      systemSection.className = 'settings-section';
      systemSection.innerHTML = `
        <div class="heading">SYSTEM</div>
        <div class="kv-row"><span class="k">ffmpeg</span><span class="v">${healthRes.ffmpeg.state === 'ready' ? 'detected' : 'unavailable'}</span></div>
        <div class="kv-row"><span class="k">storage</span><span class="v">${healthRes.storage.state}</span></div>
      `;

      container.append(cobaltSection, downloadSection, systemSection);
    } catch {
      container.innerHTML = '<div class="empty-note">não foi possível carregar as configurações.</div>';
    }
  }

  // ---------- init ----------

  ensureConfig().catch(() => {});
  loadHealth();
  setInterval(() => {
    const homeVisible = document.getElementById('view-home').classList.contains('is-visible');
    if (homeVisible) loadHealth();
  }, 20000);
})();
