(function (global) {
  "use strict";

  const TNCWeb = global.TNCWeb = global.TNCWeb || {};

  const CONTROL = Object.freeze({
    NUL: 0x00,
    SOH: 0x01,
    STX: 0x02,
    ETX: 0x03,
    EOT: 0x04,
    ACK: 0x06,
    DC1: 0x11,
    DC3: 0x13,
    NAK: 0x15,
    ETB: 0x17,
    ESC: 0x1b,
    SP: 0x20,
    CR: 0x0d,
    LF: 0x0a
  });

  const DIRECTORY_REQUEST = Uint8Array.from([
    CONTROL.DC3,
    CONTROL.ESC,
    CONTROL.DC1,
    0x4f,
    CONTROL.SP,
    0x44,
    CONTROL.CR,
    CONTROL.LF
  ]);

  const DIRECTORY_REQUEST_ZERO = Uint8Array.from([
    CONTROL.DC3,
    CONTROL.ESC,
    CONTROL.DC1,
    0x30,
    CONTROL.SP,
    0x44,
    CONTROL.CR,
    CONTROL.LF
  ]);

  function byteSequenceIndex(haystack, needle, start) {
    const from = start || 0;
    const lastStart = haystack.byteLength - needle.byteLength;
    for (let index = from; index <= lastStart; index += 1) {
      let matches = true;
      for (let offset = 0; offset < needle.byteLength; offset += 1) {
        if (haystack[index + offset] !== needle[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return index;
      }
    }
    return -1;
  }

  function concatenate(chunks, totalLength) {
    const output = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  function normalizeFiles(files) {
    return (files || []).map((file) => {
      if (!file || typeof file.name !== "string" || !file.name) {
        throw new TypeError("Each directory entry requires a filename.");
      }
      if (!/^[A-Za-z0-9_.]{1,16}$/.test(file.name)) {
        throw new RangeError(`Unsupported FE1 filename: ${file.name}`);
      }
      return {
        name: file.name,
        size: Math.max(0, Number(file.size) || 0)
      };
    }).sort((left, right) => left.name.localeCompare(right.name, "en"));
  }

  function occupiedSectors(size) {
    // The FE 401 uses fixed-size sectors. The exact physical sector size is not
    // needed for file retrieval, but keeping this deterministic avoids changing
    // the displayed count between requests.
    return Math.max(1, Math.ceil(size / 256));
  }

  function toFe1DirectoryName(filename) {
    const base = filename.replace(/\.[^.]+$/, "").toUpperCase();
    if (!/^[A-Z0-9_]{1,15}$/.test(base)) {
      throw new RangeError(`Unsupported FE1 program identifier: ${filename}`);
    }
    return `H${base}`;
  }

  function formatDirectoryRecord(name, sectors, startSector) {
    return `${name.padEnd(15, " ")}${String(sectors).padStart(9, " ")}${String(startSector).padStart(8, " ")}`;
  }

  function buildDirectoryResponse(files, options) {
    const settings = options || {};
    const headers = settings.headers || [
      "FE 401 V.01",
      "Filename       # Sector Start",
      "-----------------------------",
      "Directory"
    ];
    if (headers.length !== 4) {
      throw new RangeError("The TNC directory protocol requires exactly four ignored header lines.");
    }

    const entries = normalizeFiles(files);
    if (settings.minimalDirectory) {
      const text = `${headers.join("\r\n")}\r\n${formatDirectoryRecord("H100", 3, 5)}\r\n`;
      const bytes = new TextEncoder().encode(text);
      const response = new Uint8Array(bytes.byteLength + 1);
      response.set(bytes);
      response[response.byteLength - 1] = CONTROL.ETX;
      return response;
    }

    const lines = headers.slice();
    const fieldPad = settings.fieldPad === undefined ? "" : String(settings.fieldPad);
    let nextSector = 5;
    for (const file of entries) {
      const sectors = occupiedSectors(file.size);
      lines.push(`${fieldPad}${formatDirectoryRecord(toFe1DirectoryName(file.name), sectors, nextSector)}${fieldPad}`);
      nextSector += sectors;
    }
    const freeSectors = settings.freeSectors === undefined
      ? Math.max(0, Number(settings.totalSectors || 3088) - entries.reduce(
        (sum, file) => sum + occupiedSectors(file.size),
        0
      ))
      : Math.max(0, Number(settings.freeSectors) || 0);
    lines.push(`${fieldPad}${"FREE:".padEnd(24, " ")}${String(freeSectors).padStart(9, " ")}${fieldPad}`);

    const text = `${lines.join("\r\n")}\r\n`;
    const bytes = new TextEncoder().encode(text);
    const response = new Uint8Array(bytes.byteLength + 1);
    response.set(bytes);
    response[response.byteLength - 1] = CONTROL.ETX;
    return response;
  }

  class Fe1DirectoryResponder {
    constructor(options) {
      const settings = options || {};
      this.getFiles = settings.getFiles || (() => []);
      this.options = settings.options || {};
      this.onResponse = settings.onResponse || (() => {});
      this.buffer = new Uint8Array(0);
      this.maxBufferedBytes = settings.maxBufferedBytes || 4096;
      this.responsesBuilt = 0;
    }

    feed(value) {
      const bytes = TNCWeb.copyBytes(value);
      if (bytes.byteLength === 0) {
        return 0;
      }
      this.buffer = concatenate([this.buffer, bytes], this.buffer.byteLength + bytes.byteLength);

      let responses = 0;
      while (true) {
        const letterOIndex = byteSequenceIndex(this.buffer, DIRECTORY_REQUEST, 0);
        const zeroIndex = byteSequenceIndex(this.buffer, DIRECTORY_REQUEST_ZERO, 0);
        const useLetterO = letterOIndex !== -1 && (zeroIndex === -1 || letterOIndex <= zeroIndex);
        const index = useLetterO ? letterOIndex : zeroIndex;
        if (index === -1) {
          break;
        }
        const request = useLetterO ? DIRECTORY_REQUEST : DIRECTORY_REQUEST_ZERO;
        this.buffer = this.buffer.slice(index + request.byteLength);
        const response = buildDirectoryResponse(this.getFiles(), this.options);
        this.responsesBuilt += 1;
        this.onResponse(response, {
          request: request.slice(),
          files: normalizeFiles(this.getFiles())
        });
        responses += 1;
      }

      if (this.buffer.byteLength > this.maxBufferedBytes) {
        this.buffer = this.buffer.slice(this.buffer.byteLength - this.maxBufferedBytes);
      }
      return responses;
    }

    reset() {
      this.buffer = new Uint8Array(0);
    }
  }

  Object.assign(TNCWeb, {
    CONTROL,
    DIRECTORY_REQUEST,
    DIRECTORY_REQUEST_ZERO,
    Fe1DirectoryResponder,
    buildDirectoryResponse,
    byteSequenceIndex,
    formatDirectoryRecord,
    toFe1DirectoryName
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = TNCWeb;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
