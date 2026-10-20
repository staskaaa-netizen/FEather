(function () {
  "use strict";

  const {
    ByteStreamBuffer,
    DiagnosticLog,
    Fe1DirectoryResponder,
    WebSocketSerialTransport,
    buildWebSocketEndpoint,
    parseHex,
    toAnnotatedAscii,
    toHex
  } = window.TNCWeb;

  const directoryFiles = [
    { name: "CASEBOTT.H", size: 764 },
    { name: "CASEBTAP.H", size: 542 },
    { name: "CASEFSLO.H", size: 892 },
    { name: "CASEMAIN.H", size: 560 },
    { name: "CASETAP.H", size: 319 },
    { name: "CASETOP.H", size: 462 },
    { name: "CASETOPF.H", size: 340 },
    { name: "CBERNG37.H", size: 417 }
  ];

  const byId = (id) => document.getElementById(id);
  const elements = {
    form: byId("connectionForm"),
    host: byId("hostInput"),
    port: byId("portInput"),
    path: byId("pathInput"),
    timeout: byId("timeoutInput"),
    endpoint: byId("endpointPreview"),
    connect: byId("connectButton"),
    disconnect: byId("disconnectButton"),
    stockPage: byId("stockPageButton"),
    linkChip: byId("linkChip"),
    serverIndicator: byId("serverIndicator"),
    protocolState: byId("protocolState"),
    rxCount: byId("rxCount"),
    txCount: byId("txCount"),
    queueCount: byId("queueCount"),
    speed: byId("speedValue"),
    lastActivity: byId("lastActivity"),
    error: byId("errorBanner"),
    transferNotice: byId("transferNotice"),
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
  const receiveBuffer = new ByteStreamBuffer({ maxBytes: 4 * 1024 * 1024 });
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

  let releaseWebLock = null;
  let fallbackLeaseTimer = null;
  const tabId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fallbackLockKey = "tncweb.controller.v1";

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
      elements.endpoint.textContent = endpointValue();
      elements.endpoint.style.color = "";
    } catch (error) {
      elements.endpoint.textContent = error.message;
      elements.endpoint.style.color = "var(--bad)";
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
        elements.serverIndicator.textContent = "TNC directory responder ready";
        elements.protocolState.textContent = "FE1 DIRECTORY READY - FILE TRANSFER PENDING";
        diagnostics.add("SYSTEM", null, { label: `Connected ${transport.url}` });
        clearError();
      } else if (detail.state === "closing") {
        setLinkState("closing", "W610 disconnecting");
      } else if (detail.state === "closed") {
        const endedUnexpectedly = detail.unexpected && !session.manualDisconnect;
        setLinkState(endedUnexpectedly ? "error" : "inactive", endedUnexpectedly ? "W610 link lost" : "W610 link offline");
        elements.protocolState.textContent = "TRANSPORT CLOSED";
        elements.serverIndicator.dataset.state = "inactive";
        elements.serverIndicator.textContent = "TNC directory responder offline";
        diagnostics.add("SYSTEM", null, {
          label: endedUnexpectedly ? "Connection lost" : "Disconnected",
          error: detail.reason || (detail.lastError && detail.lastError.message) || ""
        });
        if (endedUnexpectedly) {
          showError("W610 connection was lost. No automatic reconnect or partial-transfer resume was attempted.");
        }
        receiveBuffer.clear();
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

  function openStockPage() {
    try {
      const host = elements.host.value.trim().replace(/^\[|\]$/g, "");
      if (!host) {
        throw new Error("Enter the W610 IP address first.");
      }
      const url = new URL("http://localhost/");
      url.hostname = host;
      url.pathname = "/websocket.html";
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    } catch (error) {
      showError("Could not open the stock W610 page.", error);
    }
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    connect();
  });
  elements.disconnect.addEventListener("click", disconnect);
  elements.stockPage.addEventListener("click", openStockPage);
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
    if (session.transport && session.transport.socket) {
      try {
        session.transport.socket.close(1001, "Page closed");
      } catch (error) {
        // The browser will close the socket with the page.
      }
    }
    releaseControllerLock();
  });

  elements.origin.textContent = window.location.origin === "null"
    ? "file:// (opaque or browser-defined origin)"
    : window.location.origin;
  updateEndpoint();
  updateCounters();
  diagnostics.add("SYSTEM", null, {
    label: "TNCweb Milestone 1 loaded"
  });
  diagnostics.add("SYSTEM", null, {
    label: "FE1 is not implemented; no directory, upload, or download commands are emitted"
  });

  // Exposed for a future FE1 controller and for the browser test harness.
  window.TNCWebConsole = {
    diagnostics,
    receiveBuffer,
    session,
    setTransferActive(value) {
      session.transferActive = Boolean(value);
      elements.sendLockNote.textContent = session.transferActive
        ? "Manual terminal input is locked during the active FE transfer."
        : "Binary WebSocket frames are used for transmitted bytes. Received text frames are converted as UTF-8 for diagnostics.";
      elements.transferNotice.textContent = session.transferActive
        ? "An FE transfer is active. Manual terminal input is locked."
        : "Raw transport milestone only. Manual TX is locked while a future FE1 transfer is active.";
      updateCounters();
    }
  };
})();
