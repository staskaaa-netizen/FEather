(function () {
  "use strict";

  const {
    ByteStreamBuffer,
    DEFAULT_LIBRARY_ID,
    DiagnosticLog,
    Fe1DirectoryResponder,
    Fe1DeleteResponder,
    Fe1FileResponder,
    Fe1Receiver,
    NcStorage,
    WebSocketSerialTransport,
    buildDirectoryResponse,
    buildWebSocketEndpoint,
    convertGcodeToL,
    discoverW610,
    fromFe1DirectoryName,
    ipv4PrefixFromHost,
    numberProgramLines,
    parseHex,
    parseIpv4SubnetPrefix,
    prepareLocalNetworkAccess,
    queryLocalNetworkPermission,
    toAnnotatedAscii,
    toAscii,
    toFe1DirectoryName,
    toHex,
    validateLProgram
  } = window.TNCWeb;

  let directoryFiles = [];
  const programBytes = new Map();

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
    discoverySubnet: byId("discoverySubnetInput"),
    discoveryButton: byId("discoveryButton"),
    discoveryStatus: byId("discoveryStatus"),
    autoConnectToggle: byId("autoConnectToggle"),
    about: byId("aboutDialog"),
    aboutButton: byId("aboutButton"),
    aboutClose: byId("aboutCloseButton"),
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
    libraryTabs: byId("libraryTabs"),
    libraryStatus: byId("libraryStatus"),
    addLibrary: byId("addLibraryButton"),
    renameLibrary: byId("renameLibraryButton"),
    deleteLibrary: byId("deleteLibraryButton"),
    filePreviewName: byId("filePreviewName"),
    filePreviewMeta: byId("filePreviewMeta"),
    filePreview: byId("filePreview"),
    fileEditor: byId("fileEditor"),
    saveFile: byId("saveFileButton"),
    moveUp: byId("moveUpButton"),
    moveDown: byId("moveDownButton"),
    convertGCode: byId("convertGCodeButton"),
    gcodeDialog: byId("gcodeDialog"),
    gcodeForm: byId("gcodeForm"),
    gcodeInput: byId("gcodeInput"),
    gcodeProgramName: byId("gcodeProgramName"),
    gcodeStatus: byId("gcodeStatus"),
    gcodeClose: byId("gcodeCloseButton"),
    gcodeCancel: byId("gcodeCancelButton"),
    moveLibraryDialog: byId("moveLibraryDialog"),
    moveLibraryForm: byId("moveLibraryForm"),
    moveLibraryFile: byId("moveLibraryFile"),
    moveLibraryTarget: byId("moveLibraryTarget"),
    moveLibraryStatus: byId("moveLibraryStatus"),
    moveLibraryClose: byId("moveLibraryCloseButton"),
    moveLibraryCancel: byId("moveLibraryCancelButton"),
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
  let libraries = [];
  let activeLibraryId = null;
  let selectedFileName = null;
  let draggedFileName = null;
  let moveLibraryFileName = null;
  let editContext = null;
  let renumberTimer = null;
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
        const record = await storage.saveReceived(
          result.filename,
          result.bytes,
          reservedNames,
          activeLibraryId
        );
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
      if (!existing || existing.libraryId !== activeLibraryId) {
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

  async function findW610() {
    let subnet;
    try {
      subnet = parseIpv4SubnetPrefix(
        elements.discoverySubnet.value || ipv4PrefixFromHost(elements.host.value.trim())
      );
    } catch (error) {
      elements.discoveryStatus.textContent = error.message;
      elements.discoverySubnet.focus();
      return;
    }

    const port = Number(elements.port.value);
    const path = elements.path.value.trim() || "/";
    elements.discoverySubnet.value = subnet;
    elements.discoveryButton.disabled = true;
    elements.discoveryStatus.textContent =
      `Scanning ${subnet}.1-${subnet}.254 for HTTP devices. Allow local-network access if prompted.`;

    try {
      const permission = await queryLocalNetworkPermission(
        navigator.permissions,
        `${subnet}.1`
      );
      if (permission.state === "denied") {
        throw new Error(
          "Local-network permission is blocked for this site. Allow it in browser site settings, reload, and try again."
        );
      }

      const result = await discoverW610({
        subnet,
        preferredHost: elements.host.value.trim(),
        port,
        path,
        onHttpProgress(completed, total) {
          elements.discoveryStatus.textContent =
            `Scanning local hosts: ${completed}/${total} checked...`;
        },
        onWebSocketProgress(completed, total) {
          elements.discoveryStatus.textContent =
            `Checking W610 port ${port}: ${completed}/${total} HTTP devices checked...`;
        }
      });

      const permissionAfter = await queryLocalNetworkPermission(
        navigator.permissions,
        `${subnet}.1`
      );
      if (permissionAfter.state === "denied") {
        throw new Error(
          "Local-network permission was denied. Allow it in browser site settings and try again."
        );
      }

      if (result.devices.length > 0) {
        const found = result.devices.map((device) => device.host);
        elements.host.value = found[0];
        updateEndpoint();
        elements.discoveryStatus.textContent = found.length === 1
          ? `Found W610 WebSocket at ${found[0]}. Review the endpoint and save settings.`
          : `Found W610-compatible WebSockets at ${found.join(", ")}. The first address was selected.`;
        diagnostics.add("SYSTEM", null, {
          label: `W610 discovery found ${found.join(", ")}`
        });
      } else if (result.httpHosts.length > 0) {
        elements.discoveryStatus.textContent =
          `Found HTTP devices at ${result.httpHosts.join(", ")}, but none accepted WebSocket port ${port}.`;
      } else {
        elements.discoveryStatus.textContent =
          `No HTTP devices found in ${subnet}.1-${subnet}.254. Confirm this PC is on the W610 network and enter the correct first three octets.`;
      }
    } catch (error) {
      elements.discoveryStatus.textContent = error.message;
    } finally {
      elements.discoveryButton.disabled = false;
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
      editContext = null;
      setEditingMode(false);
      elements.filePreviewName.textContent = "Select a file";
      elements.filePreviewMeta.textContent = "Choose a program from the list.";
      elements.filePreview.textContent = "No file selected.";
      return;
    }
    const bytes = new Uint8Array(record.bytes);
    elements.filePreviewName.textContent = record.name;
    elements.filePreviewMeta.textContent = `${formatBytes(bytes.byteLength)} · ${new Date(record.updatedAt).toLocaleString()}`;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      startEditing(text, {
        recordName: record.name,
        saveName: record.name,
        source: record.source,
        libraryId: record.libraryId,
        dirty: false
      });
    } catch (error) {
      editContext = null;
      setEditingMode(false);
      elements.filePreview.hidden = false;
      elements.filePreview.textContent = "This file is not valid text and cannot be opened in the text editor.";
    }
  }

  function setEditingMode(active) {
    elements.fileEditor.hidden = !active;
    elements.filePreview.hidden = active;
    elements.saveFile.hidden = !active;
    elements.moveUp.hidden = !active;
    elements.moveDown.hidden = !active;
  }

  function lineMetadata(text, position) {
    const safePosition = Math.max(0, Math.min(position, text.length));
    const lineStart = text.lastIndexOf("\n", Math.max(0, safePosition - 1)) + 1;
    const prefix = text.slice(lineStart).match(/^\s*(?:\/\s*)?\d+\s*/);
    const prefixLength = prefix ? prefix[0].length : 0;
    return {
      lineIndex: text.slice(0, lineStart).split("\n").length - 1,
      column: Math.max(0, safePosition - lineStart - prefixLength)
    };
  }

  function positionFromLineColumn(lines, lineIndex, column) {
    const safeLine = Math.max(0, Math.min(lineIndex, Math.max(0, lines.length - 1)));
    const lineStart = lines.slice(0, safeLine).join("\n").length + (safeLine > 0 ? 1 : 0);
    const prefix = lines[safeLine].match(/^\s*(?:\/\s*)?\d+\s*/);
    return lineStart + (prefix ? prefix[0].length : 0) + column;
  }

  function renumberEditor(selectionLines) {
    if (!editContext) {
      return;
    }
    const text = elements.fileEditor.value;
    const startMeta = lineMetadata(text, elements.fileEditor.selectionStart);
    const endMeta = lineMetadata(text, elements.fileEditor.selectionEnd);
    const numbered = numberProgramLines(text, 0).replace(/\r\n/g, "\n");
    if (numbered !== text) {
      editContext.dirty = true;
      elements.filePreviewName.textContent = `${editContext.saveName} *`;
    }
    elements.fileEditor.value = numbered;
    const lines = numbered.split("\n");
    const startLine = selectionLines ? selectionLines.start : startMeta.lineIndex;
    const endLine = selectionLines ? selectionLines.end : endMeta.lineIndex;
    const startColumn = selectionLines ? 0 : startMeta.column;
    const endColumn = selectionLines ? lines[endLine].replace(/^\s*(?:\/\s*)?\d+\s*/, "").length : endMeta.column;
    elements.fileEditor.setSelectionRange(
      positionFromLineColumn(lines, startLine, startColumn),
      positionFromLineColumn(lines, endLine, endColumn)
    );
  }

  function startEditing(text, context) {
    clearTimeout(renumberTimer);
    editContext = Object.assign({
      recordName: null,
      saveName: "PROGRAM.H",
      source: "import",
      libraryId: activeLibraryId,
      warnings: [],
      dirty: true
    }, context || {});
    elements.fileEditor.value = String(text).replace(/\r\n?/g, "\n");
    elements.filePreviewName.textContent = `${editContext.saveName}${editContext.dirty ? " *" : ""}`;
    elements.filePreviewMeta.textContent = editContext.warnings.length
      ? `Converted with ${editContext.warnings.length} warning${editContext.warnings.length === 1 ? "" : "s"}. Review marked source lines.`
      : "Edit blocks, move selected lines, then save.";
    setEditingMode(true);
    const initiallyDirty = editContext.dirty;
    renumberEditor();
    editContext.dirty = initiallyDirty;
    editContext.originalText = initiallyDirty ? null : elements.fileEditor.value;
    elements.filePreviewName.textContent = `${editContext.saveName}${initiallyDirty ? " *" : ""}`;
    elements.fileEditor.focus();
  }

  async function saveEditing() {
    if (!editContext) {
      return;
    }
    if (session.transferActive) {
      showError("Wait for the active FE transfer to finish before saving an edit.");
      return;
    }

    let text = numberProgramLines(elements.fileEditor.value.replace(/\r\n?/g, "\n"), 0);
    if (!text.endsWith("\r\n")) {
      text += "\r\n";
    }
    if (!/^[\x00-\x7f]*$/.test(text)) {
      showError("Edited programs must contain ASCII characters only.");
      return;
    }
    const validation = validateLProgram(text);
    if (!validation.valid) {
      showError(validation.error);
      return;
    }

    try {
      const bytes = new TextEncoder().encode(text);
      let saved;
      if (editContext.recordName) {
        saved = await storage.save(editContext.recordName, bytes, {
          source: editContext.source,
          libraryId: editContext.libraryId || activeLibraryId
        });
      } else {
        const reserved = storedRecords.map((record) => record.name);
        saved = await storage.saveImported(
          editContext.saveName,
          bytes,
          reserved,
          activeLibraryId
        );
      }
      selectedFileName = saved.name;
      editContext = null;
      await refreshStoredFiles();
      elements.importStatus.textContent = `Saved ${saved.name}.`;
      clearError();
    } catch (error) {
      showError("Could not save the edited program.", error);
    }
  }

  function moveSelectedLines(direction) {
    if (!editContext) {
      return;
    }
    const text = elements.fileEditor.value;
    const startLine = text.slice(0, elements.fileEditor.selectionStart).split("\n").length - 1;
    let endLine = elements.fileEditor.selectionEnd === elements.fileEditor.selectionStart
      ? startLine
      : text.slice(0, elements.fileEditor.selectionEnd).split("\n").length - 1;
    if (endLine < startLine) {
      endLine = startLine;
    }
    if (direction < 0 && startLine === 0) {
      return;
    }

    const lines = text.split("\n");
    if (direction > 0 && endLine >= lines.length - 1) {
      return;
    }
    const selected = lines.splice(startLine, endLine - startLine + 1);
    const target = direction < 0 ? startLine - 1 : startLine + 1;
    lines.splice(target, 0, ...selected);
    elements.fileEditor.value = lines.join("\n");
    editContext.dirty = true;
    elements.filePreviewName.textContent = `${editContext.saveName} *`;
    renumberEditor({ start: target, end: target + selected.length - 1 });
    editContext.dirty = editContext.originalText === null || elements.fileEditor.value !== editContext.originalText;
    elements.filePreviewName.textContent = `${editContext.saveName}${editContext.dirty ? " *" : ""}`;
    elements.fileEditor.focus();
  }

  function renderLibraryTabs(allRecords) {
    const counts = new Map();
    for (const record of allRecords || []) {
      counts.set(record.libraryId, (counts.get(record.libraryId) || 0) + 1);
    }
    elements.libraryTabs.replaceChildren();
    for (const library of libraries) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "library-tab";
      tab.dataset.libraryId = library.id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(library.id === activeLibraryId));
      tab.classList.toggle("active", library.id === activeLibraryId);
      tab.textContent = library.name;
      const count = document.createElement("span");
      count.textContent = String(counts.get(library.id) || 0);
      tab.append(count);
      tab.addEventListener("click", () => switchLibrary(library.id));
      tab.addEventListener("dragover", (event) => {
        if (!draggedFileName || library.id === activeLibraryId) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        tab.classList.add("drop-target");
      });
      tab.addEventListener("dragleave", () => tab.classList.remove("drop-target"));
      tab.addEventListener("drop", async (event) => {
        if (!draggedFileName || library.id === activeLibraryId) {
          return;
        }
        event.preventDefault();
        tab.classList.remove("drop-target");
        const name = draggedFileName;
        draggedFileName = null;
        await moveFileToLibrary(name, library.id);
      });
      elements.libraryTabs.append(tab);
    }
    const active = libraries.find((library) => library.id === activeLibraryId);
    elements.libraryStatus.textContent = active
      ? `Only files in "${active.name}" are shared with the TNC.`
      : "Select a library to control which files are shared with the TNC.";
    elements.deleteLibrary.disabled = activeLibraryId === DEFAULT_LIBRARY_ID;
    elements.renameLibrary.disabled = !active;
  }

  function clearLibraryDropTargets() {
    for (const tab of elements.libraryTabs.querySelectorAll(".drop-target")) {
      tab.classList.remove("drop-target");
    }
  }

  async function moveFileToLibrary(name, targetLibraryId) {
    if (targetLibraryId === activeLibraryId) {
      return false;
    }
    if (session.transferActive) {
      const message = "Wait for the active FE transfer to finish before moving a program.";
      showError(message);
      if (elements.moveLibraryDialog.open) {
        elements.moveLibraryStatus.textContent = message;
      }
      return false;
    }
    const record = storedRecords.find((item) => item.name === name);
    if (!record) {
      showError(`File not found: ${name}`);
      return false;
    }
    if (editContext?.dirty && selectedFileName === name &&
        !window.confirm("Discard unsaved changes and move this program?")) {
      return false;
    }
    const target = libraries.find((library) => library.id === targetLibraryId);
    if (!target) {
      showError("Destination library not found.");
      return false;
    }
    try {
      await storage.moveToLibrary(name, targetLibraryId);
      if (selectedFileName === name) {
        selectedFileName = null;
        editContext = null;
        setEditingMode(false);
      }
      await refreshStoredFiles();
      elements.importStatus.textContent = `Moved ${name} to ${target.name}.`;
      clearError();
      diagnostics.add("SYSTEM", null, {
        label: `Moved ${name} to library ${target.name}`
      });
      return true;
    } catch (error) {
      showError("Could not move the program.", error);
      if (elements.moveLibraryDialog.open) {
        elements.moveLibraryStatus.textContent = error.message;
      }
      return false;
    }
  }

  function openMoveLibraryDialog(name) {
    const record = storedRecords.find((item) => item.name === name);
    if (!record) {
      return;
    }
    const targets = libraries.filter((library) => library.id !== activeLibraryId);
    if (targets.length === 0) {
      showError("Create another library before moving a program.");
      return;
    }
    moveLibraryFileName = name;
    elements.moveLibraryFile.textContent = `Move ${name} out of "${libraries.find(
      (library) => library.id === activeLibraryId
    ).name}".`;
    elements.moveLibraryTarget.replaceChildren();
    for (const library of targets) {
      const option = document.createElement("option");
      option.value = library.id;
      option.textContent = library.name;
      elements.moveLibraryTarget.append(option);
    }
    elements.moveLibraryStatus.textContent = "";
    elements.moveLibraryDialog.showModal();
    elements.moveLibraryTarget.focus();
  }

  async function switchLibrary(id) {
    if (id === activeLibraryId) {
      return;
    }
    if (session.transferActive) {
      showError("Wait for the active FE transfer to finish before changing libraries.");
      return;
    }
    if (editContext?.dirty && !window.confirm("Discard unsaved changes and switch library?")) {
      return;
    }
    try {
      await storage.setActiveLibrary(id);
      activeLibraryId = id;
      selectedFileName = null;
      editContext = null;
      setEditingMode(false);
      await refreshStoredFiles();
      clearError();
      diagnostics.add("SYSTEM", null, {
        label: `Active library: ${libraries.find((library) => library.id === id).name}`
      });
    } catch (error) {
      showError("Could not switch libraries.", error);
    }
  }

  async function addLibrary() {
    if (session.transferActive) {
      showError("Wait for the active FE transfer to finish before adding a library.");
      return;
    }
    const name = window.prompt("New library name", `Library ${libraries.length + 1}`);
    if (name === null) {
      return;
    }
    try {
      const result = await storage.createLibrary(name);
      libraries = result.libraries;
      await storage.setActiveLibrary(result.library.id);
      activeLibraryId = result.library.id;
      selectedFileName = null;
      editContext = null;
      setEditingMode(false);
      await refreshStoredFiles();
      clearError();
    } catch (error) {
      showError("Could not create the library.", error);
    }
  }

  async function renameActiveLibrary() {
    const active = libraries.find((library) => library.id === activeLibraryId);
    if (!active) {
      return;
    }
    const name = window.prompt("Rename library", active.name);
    if (name === null || name === active.name) {
      return;
    }
    try {
      libraries = await storage.renameLibrary(active.id, name);
      await refreshStoredFiles();
      clearError();
    } catch (error) {
      showError("Could not rename the library.", error);
    }
  }

  async function deleteActiveLibrary() {
    const active = libraries.find((library) => library.id === activeLibraryId);
    if (!active || active.id === DEFAULT_LIBRARY_ID) {
      return;
    }
    if (session.transferActive) {
      showError("Wait for the active FE transfer to finish before deleting a library.");
      return;
    }
    const fallback = libraries.find((library) => library.id === DEFAULT_LIBRARY_ID);
    if (!window.confirm(
      `Delete library "${active.name}"? Its files will be moved to "${fallback ? fallback.name : "Library 1"}".`
    )) {
      return;
    }
    try {
      const result = await storage.deleteLibrary(active.id);
      libraries = result.libraries;
      activeLibraryId = result.activeLibraryId;
      selectedFileName = null;
      editContext = null;
      setEditingMode(false);
      await refreshStoredFiles();
      clearError();
    } catch (error) {
      showError("Could not delete the library.", error);
    }
  }

  function selectStoredFile(name) {
    if (editContext?.dirty && !window.confirm("Discard unsaved changes?")) {
      return;
    }
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
      row.draggable = libraries.length > 1;
      row.classList.toggle("selected", record.name === selectedFileName);
      const choose = () => selectStoredFile(record.name);
      row.addEventListener("click", choose);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose();
        }
      });
      row.addEventListener("dragstart", (event) => {
        if (session.transferActive) {
          event.preventDefault();
          showError("Wait for the active FE transfer to finish before moving a program.");
          return;
        }
        draggedFileName = record.name;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-feather-file", record.name);
        event.dataTransfer.setData("text/plain", record.name);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        draggedFileName = null;
        row.classList.remove("dragging");
        clearLibraryDropTargets();
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
      const moveButton = document.createElement("button");
      moveButton.type = "button";
      moveButton.textContent = "Move";
      moveButton.disabled = libraries.length < 2;
      moveButton.title = libraries.length < 2
        ? "Create another library before moving this program."
        : "Move this program to another library";
      moveButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openMoveLibraryDialog(record.name);
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
      actions.append(downloadButton, moveButton, deleteButton);
      row.append(label, actions);
      elements.storedFileList.append(row);
    }
    if (!editContext?.dirty) {
      renderFilePreview(records.find((record) => record.name === selectedFileName) || null);
    }
  }

  async function refreshStoredFiles() {
    const allRecords = await storage.list();
    renderLibraryTabs(allRecords);
    const records = allRecords.filter((record) => record.libraryId === activeLibraryId);
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
    const state = await storage.initializeLibraries();
    libraries = state.libraries;
    activeLibraryId = state.activeLibraryId;
    await refreshStoredFiles();
    if (storage.lastLibraryMigrationCount > 0) {
      diagnostics.add("SYSTEM", null, {
        label: `Migrated ${storage.lastLibraryMigrationCount} files into ${libraries[0].name}`
      });
    }
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return;
    }
    if (editContext?.dirty && !window.confirm("Discard unsaved changes before importing files?")) {
      return;
    }
    editContext = null;
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
        const saved = await storage.saveImported(file.name, bytes, reserved, activeLibraryId);
        imported.push(saved.name);
        diagnostics.add("SYSTEM", null, {
          label: `Imported ${file.name} as ${saved.name} (${bytes.byteLength} bytes)`
        });
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`);
      }
    }

    if (imported.length > 0) {
      selectedFileName = imported[imported.length - 1];
    }
    await refreshStoredFiles();
    elements.importStatus.textContent = `${imported.length} imported${errors.length ? `, ${errors.length} rejected` : ""}.`;
    if (errors.length > 0) {
      showError(`Some files were rejected: ${errors.join(" | ")}`);
    }
  }

  function openGCodeDialog() {
    if (editContext?.dirty && !window.confirm("Discard unsaved changes before converting G-code?")) {
      return;
    }
    const selected = storedRecords.find((item) => item.name === selectedFileName);
    const base = selected ? selected.name.replace(/\.[^.]+$/, "") : "GCONV";
    elements.gcodeProgramName.value = base.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 15) || "GCONV";
    elements.gcodeInput.value = "";
    elements.gcodeStatus.textContent = "";
    elements.gcodeDialog.showModal();
    elements.gcodeInput.focus();
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
      showError("Serial controller lock is unavailable. Keep only one FEather tab open and retry.", error);
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

  async function connect(options) {
    if (session.connecting || (session.transport && session.transport.state !== "closed")) {
      return;
    }

    const userInitiated = Boolean(options && options.userInitiated);
    let localAccess = null;
    let websocketUrl = "";
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
      const url = endpointValue();
      websocketUrl = url;
      const timeout = Math.max(1000, Math.min(30000, Number(elements.timeout.value) || 5000));
      elements.protocolState.textContent = "CHECKING LOCAL NETWORK";
      localAccess = await prepareLocalNetworkAccess({
        pageUrl: window.location.href,
        websocketUrl: url
      });
      diagnostics.add("SYSTEM", null, {
        label: `Local-network access: ${localAccess.state}`
      });
      if (localAccess.required && localAccess.supported &&
          localAccess.state === "prompt" && !userInitiated) {
        elements.connect.disabled = false;
        elements.disconnect.disabled = true;
        setLinkState("inactive", "Local-network permission required");
        elements.protocolState.textContent = "PRESS CONNECT TO ALLOW LOCAL NETWORK";
        showError(
          "Chromium needs your permission to reach the W610. Press Connect, then choose Allow when the local-network prompt appears."
        );
        return;
      }

      if (!await acquireControllerLock()) {
        throw new Error("Another browser tab currently owns the FEather serial controller.");
      }

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
      let latestPermission = null;
      if (localAccess && localAccess.required && websocketUrl) {
        try {
          latestPermission = await queryLocalNetworkPermission(
            navigator.permissions,
            new URL(websocketUrl).hostname
          );
        } catch (permissionError) {
          diagnostics.add("SYSTEM", null, {
            label: "Local-network permission recheck failed",
            error: permissionError.message
          });
        }
      }
      if (error.code === "LOCAL_NETWORK_DENIED") {
        showError(error.message);
      } else if (latestPermission && latestPermission.state === "denied") {
        showError(
          "Local-network access is blocked for this site. Open the browser's site settings, allow local-network access for FEather, reload the page, and press Connect."
        );
      } else if (localAccess && localAccess.required) {
        showError(
          `Could not open the local W610 WebSocket: ${error.message} Press Connect and allow local-network access when Chromium asks. If this browser blocks HTTPS pages from opening ws:// connections, use the local FEather build.`
        );
      } else {
        showError("Could not open the W610 WebSocket.", error);
      }
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
    connect({ userInitiated: true });
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
    download(`feather-trace-${stamp}.txt`, diagnostics.export("text"), "text/plain;charset=utf-8");
  });
  elements.exportJson.addEventListener("click", () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`feather-trace-${stamp}.json`, diagnostics.export("json"), "application/json");
  });
  elements.logView.addEventListener("change", renderLog);
  elements.saveFile.addEventListener("click", saveEditing);
  elements.moveUp.addEventListener("click", () => moveSelectedLines(-1));
  elements.moveDown.addEventListener("click", () => moveSelectedLines(1));
  elements.fileEditor.addEventListener("input", () => {
    if (!editContext) {
      return;
    }
    editContext.dirty = editContext.originalText === null || elements.fileEditor.value !== editContext.originalText;
    elements.filePreviewName.textContent = `${editContext.saveName} *`;
  });
  elements.fileEditor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && editContext) {
      clearTimeout(renumberTimer);
      renumberTimer = setTimeout(() => renumberEditor(), 0);
    }
  });
  elements.fileEditor.addEventListener("paste", () => {
    if (editContext) {
      clearTimeout(renumberTimer);
      renumberTimer = setTimeout(() => renumberEditor(), 0);
    }
  });
  elements.fileEditor.addEventListener("blur", () => {
    if (editContext) {
      renumberEditor();
    }
  });
  elements.convertGCode.addEventListener("click", openGCodeDialog);
  elements.gcodeClose.addEventListener("click", () => elements.gcodeDialog.close());
  elements.gcodeCancel.addEventListener("click", () => elements.gcodeDialog.close());
  elements.moveLibraryClose.addEventListener("click", () => elements.moveLibraryDialog.close());
  elements.moveLibraryCancel.addEventListener("click", () => elements.moveLibraryDialog.close());
  elements.moveLibraryDialog.addEventListener("close", () => {
    moveLibraryFileName = null;
    elements.moveLibraryStatus.textContent = "";
  });
  elements.moveLibraryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = moveLibraryFileName;
    const targetId = elements.moveLibraryTarget.value;
    if (!name || !targetId) {
      return;
    }
    if (await moveFileToLibrary(name, targetId)) {
      elements.moveLibraryDialog.close();
    }
  });
  elements.gcodeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const result = convertGcodeToL(elements.gcodeInput.value, {
        programName: elements.gcodeProgramName.value
      });
      elements.gcodeDialog.close();
      startEditing(result.text, {
        recordName: null,
        saveName: `${result.programName}.H`,
        source: "import",
        warnings: result.warnings
      });
      elements.importStatus.textContent = result.warnings.length
        ? `G-code converted with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`
        : "G-code converted. Review and save the generated L program.";
    } catch (error) {
      elements.gcodeStatus.textContent = error.message;
    }
  });
  elements.settingsButton.addEventListener("click", () => {
    if (!elements.discoverySubnet.value) {
      elements.discoverySubnet.value = ipv4PrefixFromHost(elements.host.value.trim());
    }
    updateEndpoint();
    elements.settings.showModal();
  });
  elements.discoveryButton.addEventListener("click", findW610);
  elements.aboutButton.addEventListener("click", () => elements.about.showModal());
  elements.aboutClose.addEventListener("click", () => elements.about.close());
  elements.settingsClose.addEventListener("click", () => elements.settings.close());
  elements.settingsCancel.addEventListener("click", () => elements.settings.close());
  elements.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (saveSettings()) {
      elements.settings.close();
    }
  });
  elements.addLibrary.addEventListener("click", addLibrary);
  elements.renameLibrary.addEventListener("click", renameActiveLibrary);
  elements.deleteLibrary.addEventListener("click", deleteActiveLibrary);
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

  window.addEventListener("beforeunload", (event) => {
    if (editContext?.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
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
    label: "FEather Milestone 1 loaded"
  });
  diagnostics.add("SYSTEM", null, {
    label: "FE1 directory, retrieval, receive, and delete services are ready"
  });

  if (elements.autoConnectToggle.checked && elements.host.value.trim()) {
    setTimeout(() => {
      if (!session.transport) {
        connect({ userInitiated: false });
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
