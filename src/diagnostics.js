(function (global) {
  "use strict";

  const DEFAULT_LIMIT = 10000;
  const CONTROL_NAMES = Object.freeze({
    0x00: "NUL",
    0x01: "SOH",
    0x02: "STX",
    0x03: "ETX",
    0x04: "EOT",
    0x05: "ENQ",
    0x06: "ACK",
    0x07: "BEL",
    0x08: "BS",
    0x09: "HT",
    0x0a: "LF",
    0x0b: "VT",
    0x0c: "FF",
    0x0d: "CR",
    0x11: "DC1",
    0x13: "DC3",
    0x15: "NAK",
    0x17: "ETB",
    0x1a: "SUB",
    0x1b: "ESC",
    0x7f: "DEL"
  });

  function copyBytes(value) {
    if (value instanceof Uint8Array) {
      return value.slice();
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value.slice(0));
    }
    if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
      return new Uint8Array(value.slice(0));
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    }
    if (Array.isArray(value)) {
      return Uint8Array.from(value);
    }
    throw new TypeError("Expected a byte array, typed array, or ArrayBuffer.");
  }

  function toHex(value, separator) {
    const bytes = copyBytes(value);
    const joiner = separator === undefined ? " " : separator;
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(joiner);
  }

  function toAscii(value) {
    const bytes = copyBytes(value);
    return Array.from(bytes, (byte) => {
      if (CONTROL_NAMES[byte]) {
        return ".";
      }
      return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
    }).join("");
  }

  function toAnnotatedAscii(value) {
    const bytes = copyBytes(value);
    return Array.from(bytes, (byte) => {
      if (CONTROL_NAMES[byte]) {
        return `<${CONTROL_NAMES[byte]}>`;
      }
      return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : `<${toHex([byte])}>`;
    }).join("");
  }

  function parseHex(text) {
    if (typeof text !== "string") {
      throw new TypeError("Hex input must be text.");
    }

    const normalized = text
      .replace(/0x/gi, "")
      .replace(/[\s,;]/g, "");

    if (normalized === "") {
      return new Uint8Array(0);
    }
    if (!/^[0-9a-f]+$/i.test(normalized)) {
      throw new Error("Hex input may contain only 0-9, A-F, whitespace, commas, semicolons, and 0x prefixes.");
    }
    if (normalized.length % 2 !== 0) {
      throw new Error("Hex input must contain complete byte pairs.");
    }

    const bytes = new Uint8Array(normalized.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  class DiagnosticLog extends EventTarget {
    constructor(options) {
      super();
      const settings = options || {};
      this.limit = settings.limit || DEFAULT_LIMIT;
      this.now = settings.now || (() => new Date());
      this.entries = [];
      this.counters = {
        RX: 0,
        TX: 0,
        SYSTEM: 0
      };
    }

    add(direction, value, options) {
      const settings = options || {};
      const bytes = value === undefined || value === null ? new Uint8Array(0) : copyBytes(value);
      const timestamp = settings.timestamp || this.now();
      const normalizedDirection = String(direction || "SYSTEM").toUpperCase();
      const entry = {
        id: `${timestamp.getTime()}-${Math.random().toString(16).slice(2)}`,
        timestamp: timestamp.toISOString(),
        direction: normalizedDirection,
        label: settings.label || "",
        error: settings.error || "",
        byteLength: bytes.byteLength,
        bytes: Array.from(bytes)
      };

      if (Object.prototype.hasOwnProperty.call(this.counters, normalizedDirection)) {
        this.counters[normalizedDirection] += bytes.byteLength;
      }
      this.entries.push(entry);
      if (this.entries.length > this.limit) {
        this.entries.splice(0, this.entries.length - this.limit);
      }

      if (typeof CustomEvent === "function") {
        this.dispatchEvent(new CustomEvent("entry", { detail: entry }));
      }
      return entry;
    }

    clear() {
      this.entries = [];
      this.counters = {
        RX: 0,
        TX: 0,
        SYSTEM: 0
      };
      if (typeof CustomEvent === "function") {
        this.dispatchEvent(new CustomEvent("clear"));
      }
    }

    export(format) {
      if (format === "json") {
        return JSON.stringify({
          exportedAt: this.now().toISOString(),
          counters: this.counters,
          entries: this.entries
        }, null, 2);
      }

      return this.entries.map((entry) => {
        const direction = entry.direction.padEnd(6, " ");
        const label = entry.label ? ` ${entry.label}` : "";
        const error = entry.error ? ` ERROR=${entry.error}` : "";
        const hex = toHex(entry.bytes);
        const ascii = toAnnotatedAscii(entry.bytes);
        return `${entry.timestamp} ${direction}${label}${error} [${entry.byteLength} bytes] HEX ${hex || "(empty)"} ASCII ${ascii || "(empty)"}`;
      }).join("\n");
    }
  }

  global.TNCWeb = global.TNCWeb || {};
  Object.assign(global.TNCWeb, {
    CONTROL_NAMES,
    DiagnosticLog,
    copyBytes,
    parseHex,
    toAnnotatedAscii,
    toAscii,
    toHex
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.TNCWeb;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
