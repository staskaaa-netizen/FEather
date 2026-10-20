(function (global) {
  "use strict";

  const TNCWeb = global.TNCWeb = global.TNCWeb || {};

  function emit(target, type, detail) {
    if (typeof CustomEvent === "function") {
      target.dispatchEvent(new CustomEvent(type, { detail }));
      return;
    }
    target.dispatchEvent({ type, detail });
  }

  function connectionError(message, code) {
    const error = new Error(message);
    error.name = "SerialTransportError";
    if (code) {
      error.code = code;
    }
    return error;
  }

  function buildWebSocketEndpoint(host, port, path) {
    const trimmedHost = String(host || "").trim();
    const numericPort = Number(port);
    const endpointPath = String(path === undefined ? "/" : path).trim() || "/";

    if (!trimmedHost) {
      throw new TypeError("W610 host is required.");
    }
    if (trimmedHost.includes("/") || /\s/.test(trimmedHost)) {
      throw new TypeError("W610 host must be a hostname or IP address without a path.");
    }
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      throw new RangeError("W610 WebSocket port must be an integer from 1 to 65535.");
    }
    if (!endpointPath.startsWith("/") || endpointPath.startsWith("//")) {
      throw new TypeError("W610 WebSocket path must begin with one slash.");
    }

    const hostForUrl = trimmedHost.includes(":") && !trimmedHost.startsWith("[")
      ? `[${trimmedHost}]`
      : trimmedHost;
    return `ws://${hostForUrl}:${numericPort}${endpointPath}`;
  }

  class ByteStreamBuffer {
    constructor(options) {
      const settings = options || {};
      this.maxBytes = settings.maxBytes || 4 * 1024 * 1024;
      this.chunks = [];
      this.length = 0;
    }

    append(value) {
      const bytes = TNCWeb.copyBytes(value);
      if (this.length + bytes.byteLength > this.maxBytes) {
        throw new RangeError(`Receive buffer limit of ${this.maxBytes} bytes exceeded.`);
      }
      if (bytes.byteLength > 0) {
        this.chunks.push(bytes);
        this.length += bytes.byteLength;
      }
      return this.length;
    }

    peek(count) {
      const requested = Math.min(Number.isFinite(count) ? count : this.length, this.length);
      const output = new Uint8Array(requested);
      let outputOffset = 0;
      for (const chunk of this.chunks) {
        if (outputOffset >= requested) {
          break;
        }
        const take = Math.min(chunk.byteLength, requested - outputOffset);
        output.set(chunk.subarray(0, take), outputOffset);
        outputOffset += take;
      }
      return output;
    }

    read(count) {
      const requested = Math.min(Number.isFinite(count) ? count : this.length, this.length);
      const output = this.peek(requested);
      let remaining = requested;
      while (remaining > 0) {
        const chunk = this.chunks[0];
        if (remaining >= chunk.byteLength) {
          remaining -= chunk.byteLength;
          this.chunks.shift();
        } else {
          this.chunks[0] = chunk.subarray(remaining);
          remaining = 0;
        }
      }
      this.length -= requested;
      return output;
    }

    drain() {
      const output = this.peek(this.length);
      this.clear();
      return output;
    }

    clear() {
      this.chunks = [];
      this.length = 0;
    }
  }

  class SerialTransport extends EventTarget {
    constructor() {
      super();
      this.state = "closed";
      this.lastActivity = null;
      this.lastError = null;
      this.rxBytes = 0;
      this.txBytes = 0;
    }

    async connect() {
      throw new Error("connect() is not implemented.");
    }

    async disconnect() {
      throw new Error("disconnect() is not implemented.");
    }

    write() {
      throw new Error("write() is not implemented.");
    }

    _setState(state, detail) {
      this.state = state;
      emit(this, "status", Object.assign({ state, lastError: this.lastError }, detail || {}));
    }
  }

  class MockSerialTransport extends SerialTransport {
    constructor() {
      super();
      this.transmitted = [];
    }

    async connect() {
      if (this.state === "open") {
        return;
      }
      this.state = "connecting";
      this._setState("connecting");
      this.state = "open";
      this.lastActivity = new Date();
      this._setState("open");
    }

    async disconnect(reason) {
      if (this.state === "closed") {
        return;
      }
      this.state = "closed";
      this._setState("closed", { reason: reason || "manual" });
    }

    write(value) {
      if (this.state !== "open") {
        throw connectionError("Serial transport is not connected.", "NOT_CONNECTED");
      }
      const bytes = TNCWeb.copyBytes(value);
      this.transmitted.push(bytes);
      this.txBytes += bytes.byteLength;
      this.lastActivity = new Date();
      emit(this, "transmit", { bytes });
      return bytes.byteLength;
    }

    inject(value) {
      if (this.state !== "open") {
        throw connectionError("Serial transport is not connected.", "NOT_CONNECTED");
      }
      const bytes = TNCWeb.copyBytes(value);
      this.rxBytes += bytes.byteLength;
      this.lastActivity = new Date();
      emit(this, "data", { bytes });
      return bytes.byteLength;
    }

    lose(reason) {
      if (this.state === "closed") {
        return;
      }
      this.state = "closed";
      this.lastError = reason || "simulated connection loss";
      this._setState("closed", { reason: this.lastError, unexpected: true });
    }
  }

  class WebSocketSerialTransport extends SerialTransport {
    constructor(options) {
      super();
      const settings = options || {};
      if (!settings.url) {
        throw new TypeError("A WebSocket URL is required.");
      }

      this.url = settings.url;
      this.connectTimeoutMs = settings.connectTimeoutMs || 5000;
      this.webSocketFactory = settings.webSocketFactory || ((url) => new WebSocket(url));
      this.protocols = settings.protocols;
      this.socket = null;
      this._generation = 0;
      this._openPromise = null;
      this._openResolve = null;
      this._openReject = null;
      this._connectTimer = null;
    }

    connect() {
      if (this.state === "open") {
        return Promise.resolve();
      }
      if (this.state === "connecting" || this.state === "closing") {
        return this._openPromise || Promise.reject(connectionError("A connection operation is already in progress.", "BUSY"));
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(this.url);
      } catch (error) {
        return Promise.reject(connectionError("The WebSocket URL is invalid.", "INVALID_URL"));
      }
      if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
        return Promise.reject(connectionError("Only ws:// and wss:// URLs are supported.", "INVALID_URL"));
      }

      this._generation += 1;
      const generation = this._generation;
      this.rxBytes = 0;
      this.txBytes = 0;
      this.lastError = null;
      this.lastActivity = new Date();
      this.state = "connecting";
      this._setState("connecting", { url: this.url });

      this._openPromise = new Promise((resolve, reject) => {
        this._openResolve = resolve;
        this._openReject = reject;
      });

      try {
        this.socket = this.protocols === undefined
          ? this.webSocketFactory(this.url)
          : this.webSocketFactory(this.url, this.protocols);
      } catch (error) {
        this._failConnect(error, "OPEN_FAILED");
        return this._openPromise;
      }

      this.socket.binaryType = "arraybuffer";
      this.socket.addEventListener("open", () => {
        if (generation !== this._generation || this.state !== "connecting") {
          return;
        }
        this._clearConnectTimer();
        this.lastActivity = new Date();
        this.state = "open";
        this._resolveOpen();
        this._setState("open");
      });
      this.socket.addEventListener("message", (event) => {
        this._handleMessage(event.data, generation);
      });
      this.socket.addEventListener("error", () => {
        if (generation !== this._generation) {
          return;
        }
        this.lastError = connectionError("The WebSocket reported a transport error.", "SOCKET_ERROR");
        emit(this, "error", {
          error: this.lastError,
          state: this.state
        });
      });
      this.socket.addEventListener("close", (event) => {
        if (generation !== this._generation) {
          return;
        }
        this._clearConnectTimer();
        const wasOpen = this.state === "open";
        const expected = this.state === "closing";
        this.state = "closed";
        this.socket = null;
        const detail = {
          code: event.code || 0,
          reason: event.reason || "",
          wasOpen,
          unexpected: wasOpen && !expected
        };
        if (this._openReject && !wasOpen) {
          this.lastError = connectionError(
            `WebSocket closed before opening${event.reason ? `: ${event.reason}` : "."}`,
            "CLOSED_BEFORE_OPEN"
          );
          this._rejectOpen(this.lastError);
        }
        this._setState("closed", Object.assign(detail, { lastError: this.lastError }));
      });

      this._connectTimer = setTimeout(() => {
        if (generation !== this._generation || this.state !== "connecting") {
          return;
        }
        this.lastError = connectionError(
          `WebSocket connection did not open within ${this.connectTimeoutMs} ms.`,
          "CONNECT_TIMEOUT"
        );
        this.state = "closed";
        this._rejectOpen(this.lastError);
        if (this.socket) {
          try {
            this.socket.close(4000, "Connection timeout");
          } catch (error) {
            // The connection is already unusable.
          }
        }
        this._setState("closed", {
          code: 4000,
          reason: "Connection timeout",
          unexpected: true,
          lastError: this.lastError
        });
      }, this.connectTimeoutMs);

      return this._openPromise;
    }

    async disconnect(reason) {
      if (this.state === "closed") {
        return;
      }

      const socket = this.socket;
      this.state = "closing";
      this._setState("closing", { reason: reason || "manual" });
      if (socket) {
        try {
          socket.close(1000, reason || "Disconnected by operator");
        } catch (error) {
          this.lastError = error;
        }
      }
    }

    write(value) {
      if (this.state !== "open" || !this.socket) {
        throw connectionError("Serial transport is not connected.", "NOT_CONNECTED");
      }

      const bytes = TNCWeb.copyBytes(value);
      if (bytes.byteLength === 0) {
        return 0;
      }

      try {
        this.socket.send(bytes);
      } catch (error) {
        this.lastError = error;
        emit(this, "error", { error, state: this.state });
        throw error;
      }

      this.txBytes += bytes.byteLength;
      this.lastActivity = new Date();
      emit(this, "transmit", { bytes });
      return bytes.byteLength;
    }

    async _handleMessage(data, generation) {
      let bytes;
      try {
        if (typeof data === "string") {
          bytes = new TextEncoder().encode(data);
        } else if (typeof Blob !== "undefined" && data instanceof Blob) {
          bytes = new Uint8Array(await data.arrayBuffer());
        } else {
          bytes = TNCWeb.copyBytes(data);
        }
      } catch (error) {
        this.lastError = error;
        emit(this, "error", { error, state: this.state });
        return;
      }

      if (generation !== this._generation || this.state !== "open") {
        return;
      }
      this.rxBytes += bytes.byteLength;
      this.lastActivity = new Date();
      emit(this, "data", { bytes });
    }

    _resolveOpen() {
      if (this._openResolve) {
        this._openResolve();
      }
      this._openResolve = null;
      this._openReject = null;
      this._openPromise = null;
    }

    _rejectOpen(error) {
      if (this._openReject) {
        this._openReject(error);
      }
      this._openResolve = null;
      this._openReject = null;
      this._openPromise = null;
    }

    _failConnect(error, code) {
      this.lastError = error;
      if (!error.code) {
        error.code = code;
      }
      this.state = "closed";
      this._rejectOpen(error);
      this._setState("closed", {
        unexpected: true,
        lastError: error
      });
    }

    _clearConnectTimer() {
      if (this._connectTimer !== null) {
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
      }
    }
  }

  Object.assign(TNCWeb, {
    ByteStreamBuffer,
    MockSerialTransport,
    SerialTransport,
    WebSocketSerialTransport,
    buildWebSocketEndpoint,
    connectionError
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = TNCWeb;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
