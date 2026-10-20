(function () {
  "use strict";

  const {
    ByteStreamBuffer,
    DiagnosticLog,
    Fe1DirectoryResponder,
    Fe1DeleteResponder,
    Fe1FileResponder,
    Fe1Receiver,
    NcStorage,
    WebSocketSerialTransport,
    buildDirectoryResponse,
    buildWebSocketEndpoint,
    fromFe1DirectoryName,
    parseHex,
    toAnnotatedAscii,
    toAscii,
    toFe1DirectoryName,
    toHex
  } = window.TNCWeb;

  const ncCatalog = Array.isArray(window.TNCWeb.NC_FILES) ? window.TNCWeb.NC_FILES : [];
  let directoryFiles = ncCatalog.map((file) => ({ name: file.name, size: file.size }));

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  const programBytes = new Map(ncCatalog.map((file) => [
    toFe1DirectoryName(file.name),
    decodeBase64(file.base64)
  ]));

  const byId = (id) => document.getElementById(id);
  const elements = {
    form: byId("connectionForm"),
    host: byId("hostInput"),
    port: byId("portInput"),
    path: byId("pathInput"),
    timeout: byId("timeoutInput"),
    endpoint: byId("endpointPreview"),
    endpointSummary: byId("endpointSummary"),
    connect: byId("connectButton"),
    disconnect: byId("disconnectButton"),
    linkChip: byId("linkChip"),
    serverIndicator: byId("serverIndicator"),
    settings: byId("settingsDialog"),
    settingsForm: byId("settingsForm"),
    settingsButton: byId("settingsButton"),
    settingsClose: byId("settingsCloseButton"),
    settingsCancel: byId("settingsCancelButton"),
    autoConnectToggle: byId("autoConnectToggle"),
    diagnosticsToggle: byId("diagnosticsToggle"),
    diagnosticsPanel: byId("diagnosticsPanel"),
    protocolState: byId("protocolState"),
    rxCount: byId("rxCount"),
    txCount: byId("txCount"),
    queueCount: byId("queueCount"),
    speed: byId("speedValue"),
    lastActivity: byId("lastActivity"),
    error: byId("errorBanner"),
    transferNotice: byId("transferNotice"),
    currentProgram: byId("currentProgram"),
    storedFileList: byId("storedFileList"),
    storedSummary: byId("storedSummary"),
    filePreviewName: byId("filePreviewName"),
    filePreviewMeta: byId("filePreviewMeta"),
    filePreview: byId("filePreview"),
    previewMode: byId("previewMode"),
    fileDropZone: byId("fileDropZone"),
    browseFiles: byId("browseFilesButton"),
    fileInput: byId("fileInput"),
    importStatus: byId("importStatus"),
    sendLockNote: byId("sendLockNote"),
    log: byId("logOutput"),
    logCounter: byId("logCounter"),
    logView: byId("logView"),
    hexInput: byId("hexInput"),
    sendHex: byId("sendHexButton"),
    clearLog: byId("clearLogButton"),
    exportText: byId("exportTextButton"),
    exportJson: byId("exportJsonButton"),
    origin: byId("browserOrigin")
  };

  const diagnostics = new DiagnosticLog({ limit: 20000 });
  const storage = new NcStorage();
  const receiveBuffer = new ByteStreamBuffer({ maxBytes: 4 * 1024 * 1024 });
  let storedRecords = [];
  let selectedFileName = null;
  const session = {
    transport: null,
    controllerHeld: false,
    connecting: false,
    manualDisconnect: false,
    transferActive: false,
    lastActivity: null,
    lastSampleRx: 0,
    lastSampleAt: performance.now()
  };

  const directoryResponder = new Fe1DirectoryResponder({
    getFiles: () => directoryFiles,
    options: {
      totalSectors: 3088
    },
    onResponse: (bytes, detail) => {
      const transport = session.transport;
      if (!transport || transport.state !== "open") {
        return;
      }
      try {
        transport.write(bytes);
        elements.serverIndicator.dataset.state = "active";
        elements.serverIndicator.textContent = `Directory served - ${detail.files.length} files`;
        elements.protocolState.textContent = "FE1 DIRECTORY SERVED - FILE TRANSFER PENDING";
        diagnostics.add("SYSTEM", null, {
          label: `FE1 directory response: ${detail.files.length} files, ${bytes.byteLength} bytes`
        });
      } catch (error) {
        showError("Could not send the FE1 directory response.", error);
        diagnostics.add("SYSTEM", null, {
          label: "FE1 directory response failed",
          error: error.message
        });
      }
    }
  });

  const fileResponder = new Fe1FileResponder({
    getFile: (identifier) => programBytes.get(identifier) || null,
    onWrite: (bytes) => {
      const transport = session.transport;
      if (!transport || transport.state !== "open") {
        throw new Error("W610 transport closed during file retrieval.");
      }
      transport.write(bytes);
    },
    onStatus: (status) => {
      if (status.phase === "starting" || status.phase === "awaiting-ack" || status.phase === "awaiting-eot") {
        setTransferActive(true);
        elements.currentProgram.textContent = status.identifier;
        elements.serverIndicator.dataset.state = "active";
        elements.serverIndicator.textContent = `Serving ${status.identifier}`;
        elements.protocolState.textContent = `FE1 RETRIEVAL · LINE ${status.lineIndex}/${status.lineCount}`;
        elements.transferNotice.textContent = `Serving ${status.identifier}: line ${status.lineIndex} of ${status.lineCount}.`;
      } else if (status.phase === "complete") {
        setTransferActive(false);
        elements.currentProgram.textContent = "—";
        elements.serverIndicator.dataset.state = "active";
        elements.serverIndicator.textContent = `File served · ${status.identifier}`;
        elements.protocolState.textContent = "FE1 RETRIEVAL COMPLETE";
        diagnostics.add("SYSTEM", null, {
          label: `FE1 retrieval complete: ${status.identifier}, ${status.lineCount} lines`
        });
      } else if (status.phase === "failed") {
        setTransferActive(false);
        elements.currentProgram.textContent = "—";
        elements.serverIndicator.textContent = "TNC FE1 server ready";
        elements.protocolState.textContent = "FE1 RETRIEVAL FAILED";
      }
    },
    onError: (error) => {
      showError("FE1 file retrieval failed.", error);
      diagnostics.add("SYSTEM", null, {
        label: "FE1 file retrieval failed",
        error: error.message
      });
    }
  });

  const receiver = new Fe1Receiver({
    onWrite: (bytes) => {
      const transport = session.transport;
      if (!transport || transport.state !== "open") {
        throw new Error("W610 transport closed during incoming transfer.");
      }
      transport.write(bytes);
    },
    onStatus: (status) => {
      if (status.phase === "receiving") {
        setTransferActive(true);
        elements.currentProgram.textContent = `${status.filename} ← TNC`;
        elements.serverIndicator.dataset.state = "active";
        elements.serverIndicator.textContent = `Receiving ${status.filename}`;
        elements.protocolState.textContent = `FE1 RECEIVE · ${status.lineCount} BLOCKS`;
        elements.transferNotice.textContent = `Receiving ${status.filename} from TNC: ${status.lineCount} committed blocks.`;
      } else if (status.phase === "complete") {
        elements.protocolState.textContent = "FE1 RECEIVE COMPLETE · SAVING";
      } else if (status.phase === "failed") {
        setTransferActive(false);
        elements.currentProgram.textContent = "—";
        elements.serverIndicator.textContent = "TNC FE1 server ready";
        elements.protocolState.textContent = "FE1 RECEIVE FAILED";
      }
    },
    onComplete: async (result) => {
      try {
        const reservedNames = directoryFiles.map((file) => file.name);
        const record = await storage.saveReceived(result.filename, result.bytes, reservedNames);
        selectedFileName = record.name;
        await refreshStoredFiles();
        setTransferActive(false);
        clearError();
        elements.currentProgram.textContent = record.name;
        elements.serverIndicator.textContent = `Received · ${record.name}`;
        elements.protocolState.textContent = "FE1 RECEIVE COMPLETE · SAVED";
        diagnostics.add("SYSTEM", null, {
          label: `Saved TNC transfer ${result.filename} as ${record.name} (${result.lineCount} blocks)`
        });
      } catch (error) {
        setTransferActive(false);
        showError("Incoming file was received but could not be saved.", error);
        diagnostics.add("SYSTEM", null, {
          label: "Incoming file storage failed",
          error: error.message
        });
      }
    },
    onError: (error) => {
      showError("TNC-to-browser transfer failed.", error);
      diagnostics.add("SYSTEM", null, {
        label: "TNC-to-browser transfer failed",
        error: error.message
      });
    }
  });

  const deleteResponder = new Fe1DeleteResponder({
    onDelete: async (identifier) => {
      const filename = fromFe1DirectoryName(identifier);
      const existing = await storage.get(filename);
      if (!existing) {
        throw new Error(`External file does not exist: ${identifier}`);
      }
      await storage.remove(filename);
      await refreshStoredFiles();
      const transport = session.transport;
      if (!transport || transport.state !== "open") {
        throw new Error("W610 transport closed during delete.");
      }
      const response = buildDirectoryResponse(directoryFiles, { totalSectors: 3088 });
      transport.write(response);
      diagnostics.add("SYSTEM", null, {
        label: `Deleted ${filename}; sent refreshed external directory`
      });
    },
    onStatus: (status) => {
      if (status.phase === "deleting") {
        setTransferActive(true);
        elements.serverIndicator.textContent = `Deleting ${status.identifier}`;
        elements.protocolState.textContent = "FE1 DELETE IN PROGRESS";
      } else if (status.phase === "delete-complete") {
        setTransferActive(false);
        elements.serverIndicator.textContent = `Deleted ${status.identifier}`;
        elements.protocolState.textContent = "FE1 DELETE COMPLETE";
      } else if (status.phase === "delete-failed") {
        setTransferActive(false);
        elements.serverIndicator.textContent = "TNC FE1 server ready";
        elements.protocolState.textContent = "FE1 DELETE FAILED";
      }
    },
    onError: (error) => {
      showError("TNC delete request failed.", error);
      diagnostics.add("SYSTEM", null, {
        label: "TNC delete request failed",
        error: error.message
      });
    }
  });

  let releaseWebLock = null;
  let fallbackLeaseTimer = null;
  const tabId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fallbackLockKey = "tncweb.controller.v1";
  const settingsKey = "tncweb.settings.v1";
  const maxImportBytes = 10 * 1024 * 1024;

  function applyDiagnosticsVisibility(visible) {
    const enabled = Boolean(visible);
    elements.diagnosticsToggle.checked = enabled;
    elements.diagnosticsPanel.hidden = !enabled;
  }

  function loadSettings() {
    let settings = {};
    try {
      settings = JSON.parse(localStorage.getItem(settingsKey) || "{}");
    } catch (error) {
      settings = {};
    }
    if (typeof settings.host === "string") {
      elements.host.value = settings.host;
    }
    if (settings.port !== undefined) {
      elements.port.value = settings.port;
    }
    if (typeof settings.path === "string") {
      elements.path.value = settings.path;
    }
    if (settings.timeout !== undefined) {
      elements.timeout.value = settings.timeout;
    }
    if (typeof settings.logView === "string") {
      elements.logView.value = settings.logView;
    }
    elements.autoConnectToggle.checked = settings.autoConnect !== false;
    applyDiagnosticsVisibility(settings.diagnosticsEnabled === true);
  }

  function saveSettings() {
    const settings = {
      host: elements.host.value.trim(),
      port: elements.port.value,
      path: elements.path.value.trim() || "/",
      timeout: elements.timeout.value,
      autoConnect: elements.autoConnectToggle.checked,
      diagnosticsEnabled: elements.diagnosticsToggle.checked,
      logView: elements.logView.value
    };
    try {
      localStorage.setItem(settingsKey, JSON.stringify(settings));
      applyDiagnosticsVisibility(settings.diagnosticsEnabled);
      clearError();
      return true;
    } catch (error) {
      showError("Could not save settings in this browser.", error);
      return false;
    }
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }

  function formatClock(timestamp) {
    if (!timestamp) {
      return "Never";
    }
    return new Date(timestamp).toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function endpointValue() {
    return buildWebSocketEndpoint(elements.host.value, elements.port.value, elements.path.value);
  }

  function updateEndpoint() {
    try {
      const url = endpointValue();
      elements.endpoint.textContent = url;
      elements.endpointSummary.textContent = url;
      elements.endpoint.style.color = "";
      elements.endpointSummary.style.color = "";
    } catch (error) {
      elements.endpoint.textContent = error.message;
      elements.endpointSummary.textContent = error.message;
      elements.endpoint.style.color = "var(--bad)";
      elements.endpointSummary.style.color = "var(--bad)";
    }
  }

  function showError(message, error) {
    const detail = error && error.message ? error.message : message;
    elements.error.textContent = detail || "";
    elements.error.classList.toggle("visible", Boolean(detail));
  }

  function clearError() {
    elements.error.textContent = "";
    elements.error.classList.remove("visible");
  }

  function renderFilePreview(record) {
    if (!record) {
      elements.filePreviewName.textContent = "Select a file";
      elements.filePreviewMeta.textContent = "Choose a program from the list.";
      elements.filePreview.textContent = "No file selected.";
      return;
    }
    const bytes = new Uint8Array(record.bytes);
    elements.filePreviewName.textContent = record.name;
    elements.filePreviewMeta.textContent = `${formatBytes(bytes.byteLength)} · ${new Date(record.updatedAt).toLocaleString()}`;
    if (elements.previewMode.value === "hex") {
      const lines = [];
      for (let offset = 0; offset < bytes.byteLength; offset += 16) {
        const chunk = bytes.subarray(offset, offset + 16);
        const hex = toHex(chunk).padEnd(47, " ");
        lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  ${toAscii(chunk)}`);
      }
      elements.filePreview.textContent = lines.join("\n") || "(empty file)";
      return;
    }
    try {
      elements.filePreview.textContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      elements.filePreview.textContent = "This file is not valid text. Switch the preview to HEX.";
    }
  }

  function selectStoredFile(name) {
    selectedFileName = name;
    for (const row of elements.storedFileList.querySelectorAll(".file-row")) {
      row.classList.toggle("selected", row.dataset.name === name);
    }
    renderFilePreview(storedRecords.find((record) => record.name === name) || null);
  }

  function renderStoredFiles(records) {
    storedRecords = records;
    elements.storedFileList.replaceChildren();
    const totalBytes = records.reduce((sum, record) => sum + record.size, 0);
    elements.storedSummary.textContent = `${records.length} file${records.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`;
    if (records.length === 0) {
      const empty = document.createElement("span");
      empty.className = "empty-state";
      empty.textContent = "No files stored in this browser.";
      elements.storedFileList.append(empty);
      selectedFileName = null;
      renderFilePreview(null);
      return;
    }
    if (!records.some((record) => record.name === selectedFileName)) {
      selectedFileName = records[0].name;
    }
    for (const record of records) {
      const row = document.createElement("div");
      row.className = "file-row";
      row.dataset.name = record.name;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.classList.toggle("selected", record.name === selectedFileName);
      const choose = () => selectStoredFile(record.name);
      row.addEventListener("click", choose);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose();
        }
      });
      const label = document.createElement("span");
      label.className = "file-name";
      label.textContent = record.name;
      const meta = document.createElement("span");
      meta.className = "file-meta";
      const sourceLabel = record.source === "tnc" ? "received" : record.source === "import" ? "imported" : "bundled";
      meta.textContent = `${formatBytes(record.size)} · ${new Date(record.updatedAt).toLocaleString()} · ${sourceLabel}`;
      label.append(meta);
      const actions = document.createElement("span");
      actions.className = "file-actions";
      const downloadButton = document.createElement("button");
      downloadButton.type = "button";
      downloadButton.textContent = "Download";
      downloadButton.addEventListener("click", (event) => {
        event.stopPropagation();
        download(record.name, new Uint8Array(record.bytes), "application/octet-stream");
      });
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "danger";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!window.confirm(`Delete browser file ${record.name}?`)) {
          return;
        }
        try {
          await storage.remove(record.name);
          await refreshStoredFiles();
        } catch (error) {
          showError("Could not delete the received file.", error);
        }
      });
      actions.append(downloadButton, deleteButton);
      row.append(label, actions);
      elements.storedFileList.append(row);
    }
    renderFilePreview(records.find((record) => record.name === selectedFileName) || null);
  }

  async function refreshStoredFiles() {
    const records = await storage.list();
    renderStoredFiles(records);
    const files = [];
    programBytes.clear();
    for (const record of records) {
      const bytes = new Uint8Array(record.bytes);
      files.push({ name: record.name, size: bytes.byteLength });
      try {
        programBytes.set(toFe1DirectoryName(record.name), bytes.slice());
      } catch (error) {
        diagnostics.add("SYSTEM", null, {
          label: `Stored file is not FE1-representable: ${record.name}`,
          error: error.message
        });
      }
    }
    directoryFiles = files;
  }

  async function initializeStoredFiles() {
    await storage.initialize(ncCatalog.map((file) => ({
      name: file.name,
      bytes: decodeBase64(file.base64)
    })), "sample-nc-v1");
    if (imported.length > 0) {
      selectedFileName = imported[imported.length - 1];
    }
    await refreshStoredFiles();
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return;
    }
    if (session.transferActive) {
      showError("Wait for the active FE transfer to finish before importing files.");
      return;
    }

    const imported = [];
    const errors = [];
    elements.importStatus.textContent = `Importing ${files.length} file${files.length === 1 ? "" : "s"}...`;
    clearError();

    for (const file of files) {
      try {
        toFe1DirectoryName(file.name);
        if (file.size > maxImportBytes) {
          throw new Error(`File exceeds the ${formatBytes(maxImportBytes)} import limit.`);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const reserved = (await storage.list()).map((record) => record.name);
        const saved = await storage.saveImported(file.name, bytes, reserved);
        imported.push(saved.name);
        diagnostics.add("SYSTEM", null, {
          label: `Imported ${file.name} as ${saved.name} (${bytes.byteLength} bytes)`
        });
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`);
      }
    }

    await refreshStoredFiles();
    elements.importStatus.textContent = `${imported.length} imported${errors.length ? `, ${errors.length} rejected` : ""}.`;
    if (errors.length > 0) {
      showError(`Some files were rejected: ${errors.join(" | ")}`);
    }
  }

  function setLinkState(state, text) {
    elements.linkChip.dataset.state = state;
    elements.linkChip.textContent = text;
  }

  function touchActivity(timestamp) {
    session.lastActivity = timestamp || new Date();
    elements.lastActivity.textContent = formatClock(session.lastActivity);
  }

  function updateCounters() {
    const transport = session.transport;
    elements.rxCount.textContent = formatBytes(transport ? transport.rxBytes : 0);
    elements.txCount.textContent = formatBytes(transport ? transport.txBytes : 0);
    elements.queueCount.textContent = formatBytes(receiveBuffer.length);
    elements.sendHex.disabled = session.transferActive ||
      !transport ||
      transport.state !== "open";
  }

  function renderLog() {
    const view = elements.logView.value;
    const entries = diagnostics.entries.slice(-1500);
    const lines = entries.map((entry) => {
      const time = entry.timestamp.slice(11, 23);
      const direction = entry.direction.padEnd(6, " ");
      const label = entry.label ? ` ${entry.label}` : "";
      const error = entry.error ? ` ERROR ${entry.error}` : "";
      if (view === "hex") {
        return `${time} ${direction}${label}${error} ${toHex(entry.bytes) || "(empty)"}`;
      }
      if (view === "ascii") {
        return `${time} ${direction}${label}${error} ${toAnnotatedAscii(entry.bytes) || "(empty)"}`;
      }
      return `${time} ${direction}${label}${error} [${entry.byteLength}] ${toHex(entry.bytes) || "(empty)"}  ${toAnnotatedAscii(entry.bytes)}`;
    });
    elements.log.textContent = lines.length ? lines.join("\n") : "No traffic.";
    elements.logCounter.textContent = `${diagnostics.entries.length} entries`;
    elements.log.scrollTop = elements.log.scrollHeight;
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function acquireControllerLock() {
    if (session.controllerHeld) {
      return true;
    }

    if (navigator.locks && typeof navigator.locks.request === "function") {
      let acquired = false;
      await new Promise((resolve, reject) => {
        navigator.locks.request("tncweb-serial-controller", { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve();
            return undefined;
          }
          acquired = true;
          session.controllerHeld = true;
          resolve();
          return new Promise((release) => {
            releaseWebLock = release;
          });
        }).catch(reject);
      });
      return acquired;
    }

    try {
      const lease = JSON.parse(localStorage.getItem(fallbackLockKey) || "null");
      if (lease && lease.owner !== tabId && Number(lease.expires) > Date.now()) {
        return false;
      }
      localStorage.setItem(fallbackLockKey, JSON.stringify({
        owner: tabId,
        expires: Date.now() + 15000
      }));
      session.controllerHeld = true;
      fallbackLeaseTimer = setInterval(() => {
        localStorage.setItem(fallbackLockKey, JSON.stringify({
          owner: tabId,
          expires: Date.now() + 15000
        }));
      }, 5000);
      return true;
    } catch (error) {
      showError("Serial controller lock is unavailable. Keep only one TNCweb tab open and retry.", error);
      return false;
    }
  }

  function releaseControllerLock() {
    if (releaseWebLock) {
      releaseWebLock();
      releaseWebLock = null;
    }
    if (fallbackLeaseTimer !== null) {
      clearInterval(fallbackLeaseTimer);
      fallbackLeaseTimer = null;
      try {
        const lease = JSON.parse(localStorage.getItem(fallbackLockKey) || "null");
        if (lease && lease.owner === tabId) {
          localStorage.removeItem(fallbackLockKey);
        }
      } catch (error) {
        // The page may be unloading; the short lease will expire.
      }
    }
    session.controllerHeld = false;
  }

  function attachTransportHandlers(transport) {
    transport.addEventListener("data", (event) => {
      const bytes = event.detail.bytes;
      diagnostics.add("RX", bytes, { label: "W610→browser" });
      directoryResponder.feed(bytes);
      try {
        fileResponder.feed(bytes);
        receiver.feed(bytes);
        deleteResponder.feed(bytes);
      } catch (error) {
        showError("FE1 file protocol error.", error);
        diagnostics.add("SYSTEM", null, {
          label: "FE1 file protocol error",
          error: error.message
        });
      }
      try {
        receiveBuffer.append(bytes);
      } catch (error) {
        receiveBuffer.clear();
        diagnostics.add("SYSTEM", null, { label: "RX buffer overflow", error: error.message });
        showError("Receive stream buffer overflowed. The link must be disconnected; no partial transfer will resume.", error);
      }
      touchActivity();
      updateCounters();
    });

    transport.addEventListener("transmit", (event) => {
      diagnostics.add("TX", event.detail.bytes, { label: "browser→W610" });
      touchActivity();
      updateCounters();
    });

    transport.addEventListener("status", (event) => {
      const detail = event.detail;
      if (detail.state === "connecting") {
        setLinkState("connecting", "W610 connecting");
        elements.protocolState.textContent = "TRANSPORT CONNECTING";
      } else if (detail.state === "open") {
        setLinkState("open", "W610 link active");
        elements.serverIndicator.dataset.state = "active";
        elements.serverIndicator.textContent = "TNC FE1 server ready";
        elements.protocolState.textContent = "FE1 DIRECTORY + FILE RETRIEVAL READY";
        diagnostics.add("SYSTEM", null, { label: `Connected ${transport.url}` });
        clearError();
      } else if (detail.state === "closing") {
        setLinkState("closing", "W610 disconnecting");
      } else if (detail.state === "closed") {
        const endedUnexpectedly = detail.unexpected && !session.manualDisconnect;
        setLinkState(endedUnexpectedly ? "error" : "inactive", endedUnexpectedly ? "W610 link lost" : "W610 link offline");
        elements.protocolState.textContent = "TRANSPORT CLOSED";
        elements.serverIndicator.dataset.state = "inactive";
        elements.serverIndicator.textContent = "TNC FE1 server offline";
        setTransferActive(false);
        elements.currentProgram.textContent = "—";
        diagnostics.add("SYSTEM", null, {
          label: endedUnexpectedly ? "Connection lost" : "Disconnected",
          error: detail.reason || (detail.lastError && detail.lastError.message) || ""
        });
        if (endedUnexpectedly) {
          showError("W610 connection was lost. No automatic reconnect or partial-transfer resume was attempted.");
        }
        receiveBuffer.clear();
        directoryResponder.reset();
        fileResponder.reset();
        receiver.reset();
        deleteResponder.reset();
        elements.connect.disabled = false;
        elements.disconnect.disabled = true;
        updateCounters();
        releaseControllerLock();
      }
    });

    transport.addEventListener("error", (event) => {
      const error = event.detail.error;
      diagnostics.add("SYSTEM", null, { label: "Transport error", error: error.message });
      showError("WebSocket error. Check the W610 endpoint, path, Wi-Fi link, and stock page behavior.", error);
    });
  }

  async function connect() {
    if (session.connecting || (session.transport && session.transport.state !== "closed")) {
      return;
    }

    clearError();
    session.connecting = true;
    elements.connect.disabled = true;
    elements.disconnect.disabled = false;
    session.manualDisconnect = false;
    receiveBuffer.clear();
    directoryResponder.reset();
    fileResponder.reset();
    receiver.reset();
    deleteResponder.reset();
    updateCounters();

    try {
      if (!await acquireControllerLock()) {
        throw new Error("Another browser tab currently owns the TNCweb serial controller.");
      }

      const url = endpointValue();
      const timeout = Math.max(1000, Math.min(30000, Number(elements.timeout.value) || 5000));
      const transport = new WebSocketSerialTransport({
        url,
        connectTimeoutMs: timeout
      });
      session.transport = transport;
      attachTransportHandlers(transport);
      await transport.connect();
    } catch (error) {
      session.transport = null;
      elements.connect.disabled = false;
      elements.disconnect.disabled = true;
      releaseControllerLock();
      setLinkState("error", "W610 connection failed");
      diagnostics.add("SYSTEM", null, { label: "Connect failed", error: error.message });
      showError("Could not open the W610 WebSocket.", error);
      updateCounters();
    } finally {
      session.connecting = false;
    }
  }

  async function disconnect() {
    if (!session.transport || session.transport.state === "closed") {
      return;
    }
    session.manualDisconnect = true;
    elements.disconnect.disabled = true;
    try {
      await session.transport.disconnect("Disconnected by operator");
    } catch (error) {
      showError("Disconnect failed.", error);
      session.manualDisconnect = false;
    }
  }

  function sendManualHex() {
    if (session.transferActive) {
      showError("Manual terminal commands are locked while an FE transfer is active.");
      return;
    }
    if (!session.transport || session.transport.state !== "open") {
      showError("Connect to the W610 before sending bytes.");
      return;
    }
    try {
      const bytes = parseHex(elements.hexInput.value);
      if (bytes.byteLength === 0) {
        throw new Error("Enter at least one byte.");
      }
      session.transport.write(bytes);
      clearError();
    } catch (error) {
      showError("Hex transmission failed.", error);
    }
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettings();
    connect();
  });
  elements.disconnect.addEventListener("click", disconnect);
  elements.sendHex.addEventListener("click", sendManualHex);
  elements.hexInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendManualHex();
    }
  });
  elements.clearLog.addEventListener("click", () => {
    diagnostics.clear();
    diagnostics.add("SYSTEM", null, { label: "Diagnostic log cleared" });
  });
  elements.exportText.addEventListener("click", () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`tncweb-trace-${stamp}.txt`, diagnostics.export("text"), "text/plain;charset=utf-8");
  });
  elements.exportJson.addEventListener("click", () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`tncweb-trace-${stamp}.json`, diagnostics.export("json"), "application/json");
  });
  elements.logView.addEventListener("change", renderLog);
  elements.previewMode.addEventListener("change", () => {
    renderFilePreview(storedRecords.find((record) => record.name === selectedFileName) || null);
  });
  elements.settingsButton.addEventListener("click", () => {
    updateEndpoint();
    elements.settings.showModal();
  });
  elements.settingsClose.addEventListener("click", () => elements.settings.close());
  elements.settingsCancel.addEventListener("click", () => elements.settings.close());
  elements.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (saveSettings()) {
      elements.settings.close();
    }
  });
  elements.browseFiles.addEventListener("click", (event) => {
    event.stopPropagation();
    elements.fileInput.click();
  });
  elements.fileDropZone.addEventListener("click", (event) => {
    if (event.target !== elements.browseFiles && event.target !== elements.fileInput) {
      elements.fileInput.click();
    }
  });
  elements.fileDropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
  elements.fileInput.addEventListener("change", () => {
    importFiles(elements.fileInput.files).finally(() => {
      elements.fileInput.value = "";
    });
  });
  ["dragenter", "dragover"].forEach((type) => {
    elements.fileDropZone.addEventListener(type, (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      elements.fileDropZone.classList.add("dragging");
    });
  });
  elements.fileDropZone.addEventListener("dragleave", (event) => {
    if (!elements.fileDropZone.contains(event.relatedTarget)) {
      elements.fileDropZone.classList.remove("dragging");
    }
  });
  elements.fileDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.fileDropZone.classList.remove("dragging");
    importFiles(event.dataTransfer.files);
  });
  [elements.host, elements.port, elements.path].forEach((input) => input.addEventListener("input", updateEndpoint));

  diagnostics.addEventListener("entry", renderLog);
  diagnostics.addEventListener("clear", renderLog);

  setInterval(() => {
    const now = performance.now();
    const rx = session.transport ? session.transport.rxBytes : 0;
    const seconds = Math.max(1, (now - session.lastSampleAt) / 1000);
    const rate = Math.max(0, rx - session.lastSampleRx) / seconds;
    elements.speed.textContent = `${formatBytes(rate)}/s`;
    session.lastSampleRx = rx;
    session.lastSampleAt = now;
    updateCounters();
    if (session.lastActivity) {
      elements.lastActivity.textContent = formatClock(session.lastActivity);
    }
  }, 1000);

  window.addEventListener("beforeunload", () => {
    saveSettings();
    if (session.transport && session.transport.socket) {
      try {
        session.transport.socket.close(1001, "Page closed");
      } catch (error) {
        // The browser will close the socket with the page.
      }
    }
    releaseControllerLock();
  });

  function setTransferActive(value) {
    session.transferActive = Boolean(value);
    elements.sendLockNote.textContent = session.transferActive
      ? "Manual terminal input is locked during the active FE transfer."
      : "Binary WebSocket frames are used for transmitted bytes. Received text frames are converted as UTF-8 for diagnostics.";
    elements.transferNotice.textContent = session.transferActive
      ? "An FE transfer is active. Manual terminal input is locked."
      : "FE1 directory, retrieval, receive, and delete services are ready.";
    updateCounters();
  }

  elements.origin.textContent = window.location.origin === "null"
    ? "file:// (opaque or browser-defined origin)"
    : window.location.origin;
  loadSettings();
  updateEndpoint();
  updateCounters();
  initializeStoredFiles().catch((error) => {
    showError("Received-file storage is unavailable.", error);
  });
  diagnostics.add("SYSTEM", null, {
    label: "TNCweb Milestone 1 loaded"
  });
  diagnostics.add("SYSTEM", null, {
    label: "FE1 directory, retrieval, receive, and delete services are ready"
  });

  if (elements.autoConnectToggle.checked) {
    setTimeout(() => {
      if (!session.transport) {
        connect();
      }
    }, 250);
  }

  // Exposed for a future FE1 controller and for the browser test harness.
  window.TNCWebConsole = {
    diagnostics,
    deleteResponder,
    fileResponder,
    receiveBuffer,
    receiver,
    session,
    storage,
    setTransferActive
  };
})();
