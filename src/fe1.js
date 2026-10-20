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

  function fromFe1DirectoryName(identifier) {
    if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(identifier)) {
      throw new RangeError(`Unsupported FE1 program identifier: ${identifier}`);
    }
    const extensions = {
      H: ".H",
      I: ".I",
      T: ".T",
      D: ".D",
      P: ".P",
      A: ".A"
    };
    const extension = extensions[identifier[0]];
    if (!extension) {
      throw new RangeError(`Unsupported FE1 file type: ${identifier[0]}`);
    }
    return `${identifier.slice(1)}${extension}`;
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

  function calculateBcc(value) {
    const bytes = TNCWeb.copyBytes(value);
    let bcc = 0;
    for (const byte of bytes) {
      bcc ^= byte;
    }
    return bcc & 0x7f;
  }

  function encodeDataBlock(value) {
    const payload = TNCWeb.copyBytes(value);
    const block = new Uint8Array(payload.byteLength + 4);
    block[0] = CONTROL.STX;
    block.set(payload, 1);
    block[payload.byteLength + 1] = CONTROL.ETB;
    block[payload.byteLength + 2] = calculateBcc(block.subarray(0, payload.byteLength + 2));
    block[payload.byteLength + 3] = CONTROL.DC1;
    return block;
  }

  function splitFileLines(value) {
    const bytes = TNCWeb.copyBytes(value);
    const lines = [];
    let lineStart = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== CONTROL.LF) {
        continue;
      }
      const lineEnd = index > lineStart && bytes[index - 1] === CONTROL.CR ? index - 1 : index;
      lines.push(bytes.slice(lineStart, lineEnd));
      lineStart = index + 1;
    }
    if (lineStart < bytes.byteLength) {
      lines.push(bytes.slice(lineStart));
    }
    return lines;
  }

  class Fe1FileResponder {
    constructor(options) {
      const settings = options || {};
      this.getFile = settings.getFile || (() => null);
      this.onWrite = settings.onWrite || (() => {});
      this.onStatus = settings.onStatus || (() => {});
      this.onError = settings.onError || (() => {});
      this.timeoutMs = settings.timeoutMs || 2000;
      this.maxRetries = settings.maxRetries === undefined ? 3 : settings.maxRetries;
      this.maxBufferedBytes = settings.maxBufferedBytes || 4096;
      this.buffer = new Uint8Array(0);
      this.phase = "idle";
      this.identifier = "";
      this.lines = [];
      this.lineIndex = 0;
      this.currentBlock = null;
      this.retries = 0;
      this.timer = null;
    }

    feed(value) {
      const bytes = TNCWeb.copyBytes(value);
      if (bytes.byteLength === 0) {
        return [];
      }
      this.buffer = concatenate([this.buffer, bytes], this.buffer.byteLength + bytes.byteLength);
      if (this.phase === "idle") {
        this._processHeader();
      } else {
        this._processTransferBytes();
      }
      if (this.buffer.byteLength > this.maxBufferedBytes) {
        this.buffer = this.buffer.slice(this.buffer.byteLength - this.maxBufferedBytes);
      }
      return this.buffer;
    }

    _processHeader() {
      const soh = byteSequenceIndex(this.buffer, Uint8Array.from([CONTROL.SOH]), 0);
      if (soh === -1) {
        this.buffer = new Uint8Array(0);
        return;
      }
      if (soh > 0) {
        this.buffer = this.buffer.slice(soh);
      }
      const etb = byteSequenceIndex(this.buffer, Uint8Array.from([CONTROL.ETB]), 1);
      if (etb === -1 || this.buffer.byteLength < etb + 2) {
        return;
      }

      const expectedBcc = calculateBcc(this.buffer.subarray(0, etb + 1));
      const receivedBcc = this.buffer[etb + 1];
      if (expectedBcc !== receivedBcc) {
        this.onError(TNCWeb.connectionError(
          `Invalid BCC in selected-file header: expected 0x${expectedBcc.toString(16)}, received 0x${receivedBcc.toString(16)}.`,
          "HEADER_BCC"
        ));
        this.buffer = this.buffer.slice(1);
        return;
      }

      const payload = this.buffer.subarray(1, etb);
      if (payload.byteLength < 2 || payload[payload.byteLength - 1] !== 0x45) {
        this.buffer = this.buffer.slice(etb + 2);
        return;
      }
      const identifier = new TextDecoder("ascii").decode(payload.subarray(0, payload.byteLength - 1)).trim();
      const file = this.getFile(identifier);
      this.buffer = this.buffer.slice(etb + 2);
      if (this.buffer[0] === CONTROL.DC1) {
        this.buffer = this.buffer.slice(1);
      }
      if (!file) {
        this.onError(TNCWeb.connectionError(`Program not available: ${identifier}`, "FILE_NOT_FOUND"));
        return;
      }

      this.identifier = identifier;
      this.lines = splitFileLines(file);
      this.lineIndex = 0;
      this.retries = 0;
      this.phase = "starting";
      this.onStatus({
        phase: this.phase,
        identifier,
        lineIndex: 0,
        lineCount: this.lines.length
      });

      this.onWrite(Uint8Array.from([CONTROL.ACK]));
      this.timer = setTimeout(() => {
        if (this.phase === "starting") {
          this._sendNextBlock();
        }
      }, 10);
    }

    _sendNextBlock() {
      this._clearTimer();
      if (this.lineIndex >= this.lines.length) {
        this.phase = "awaiting-eot";
        this.currentBlock = null;
        this.onStatus({
          phase: this.phase,
          identifier: this.identifier,
          lineIndex: this.lineIndex,
          lineCount: this.lines.length,
          retries: this.retries
        });
        this.onWrite(Uint8Array.from([CONTROL.ETX]));
        this.timer = setTimeout(() => {
          this._fail(TNCWeb.connectionError("TNC did not acknowledge ETX with EOT.", "EOT_TIMEOUT"));
        }, this.timeoutMs);
        return;
      }

      this.retries = 0;
      this.phase = "awaiting-ack";
      this.currentBlock = encodeDataBlock(this.lines[this.lineIndex]);
      this._writeCurrentBlock();
    }

    _writeCurrentBlock() {
      this.onStatus({
        phase: this.phase,
        identifier: this.identifier,
        lineIndex: this.lineIndex + 1,
        lineCount: this.lines.length,
        retries: this.retries
      });
      this.onWrite(this.currentBlock);
      this._clearTimer();
      this.timer = setTimeout(() => {
        if (this.phase !== "awaiting-ack") {
          return;
        }
        this.retries += 1;
        if (this.retries > this.maxRetries) {
          this._fail(TNCWeb.connectionError(
            `ACK timeout after ${this.maxRetries} retries at line ${this.lineIndex + 1}.`,
            "ACK_TIMEOUT"
          ));
          return;
        }
        this._writeCurrentBlock();
      }, this.timeoutMs);
    }

    _processTransferBytes() {
      while (this.buffer.byteLength > 0 && this.phase !== "idle") {
        const command = this.buffer[0];
        this.buffer = this.buffer.slice(1);

        if (this.phase === "awaiting-ack") {
          if (command === CONTROL.ACK) {
            this._clearTimer();
            this.lineIndex += 1;
            this._sendNextBlock();
            continue;
          }
          if (command === CONTROL.NAK) {
            this._clearTimer();
            this.retries += 1;
            if (this.retries > this.maxRetries) {
              this._fail(TNCWeb.connectionError(
                `TNC rejected line ${this.lineIndex + 1} after ${this.maxRetries} retries.`,
                "RETRY_LIMIT"
              ));
              return;
            }
            this._writeCurrentBlock();
            continue;
          }
        } else if (this.phase === "awaiting-eot" && command === CONTROL.EOT) {
          this._clearTimer();
          const complete = {
            phase: "complete",
            identifier: this.identifier,
            lineIndex: this.lines.length,
            lineCount: this.lines.length
          };
          this.phase = "idle";
          this.onStatus(complete);
          this.identifier = "";
          this.lines = [];
          this.lineIndex = 0;
          this.currentBlock = null;
          return;
        }
      }
    }

    _fail(error) {
      this._clearTimer();
      this.onError(error);
      this.onStatus({
        phase: "failed",
        identifier: this.identifier,
        lineIndex: this.lineIndex,
        lineCount: this.lines.length,
        error: error.message
      });
      this.reset();
    }

    _clearTimer() {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }

    reset() {
      this._clearTimer();
      this.buffer = new Uint8Array(0);
      this.phase = "idle";
      this.identifier = "";
      this.lines = [];
      this.lineIndex = 0;
      this.currentBlock = null;
      this.retries = 0;
    }
  }

  function joinReceivedLineBlocks(blocks) {
    const chunks = [];
    let totalLength = 0;
    for (const value of blocks) {
      const block = TNCWeb.copyBytes(value);
      chunks.push(block);
      totalLength += block.byteLength;
      if (block.byteLength === 0 || (block[block.byteLength - 1] !== CONTROL.CR && block[block.byteLength - 1] !== CONTROL.LF)) {
        const ending = Uint8Array.from([CONTROL.CR, CONTROL.LF]);
        chunks.push(ending);
        totalLength += ending.byteLength;
      }
    }
    return concatenate(chunks, totalLength);
  }

  class Fe1Receiver {
    constructor(options) {
      const settings = options || {};
      this.onWrite = settings.onWrite || (() => {});
      this.onStatus = settings.onStatus || (() => {});
      this.onComplete = settings.onComplete || (() => {});
      this.onError = settings.onError || (() => {});
      this.maxBufferedBytes = settings.maxBufferedBytes || 65536;
      this.buffer = new Uint8Array(0);
      this.phase = "idle";
      this.identifier = "";
      this.filename = "";
      this.lines = [];
      this.invalidBlocks = 0;
    }

    feed(value) {
      const bytes = TNCWeb.copyBytes(value);
      if (bytes.byteLength === 0) {
        return;
      }
      this.buffer = concatenate([this.buffer, bytes], this.buffer.byteLength + bytes.byteLength);
      if (this.phase === "idle") {
        this._processHeader();
      }
      if (this.phase === "receiving") {
        this._processBlocks();
      }
      if (this.buffer.byteLength > this.maxBufferedBytes) {
        this._fail(TNCWeb.connectionError("Receive buffer limit exceeded.", "RECEIVE_BUFFER_OVERFLOW"));
      }
    }

    _processHeader() {
      const soh = byteSequenceIndex(this.buffer, Uint8Array.from([CONTROL.SOH]), 0);
      if (soh === -1) {
        this.buffer = new Uint8Array(0);
        return;
      }
      if (soh > 0) {
        this.buffer = this.buffer.slice(soh);
      }
      const etb = byteSequenceIndex(this.buffer, Uint8Array.from([CONTROL.ETB]), 1);
      if (etb === -1 || this.buffer.byteLength < etb + 2) {
        return;
      }

      const expectedBcc = calculateBcc(this.buffer.subarray(0, etb + 1));
      const receivedBcc = this.buffer[etb + 1];
      const payload = this.buffer.subarray(1, etb);
      this.buffer = this.buffer.slice(etb + 2);
      if (this.buffer[0] === CONTROL.DC1) {
        this.buffer = this.buffer.slice(1);
      }
      if (expectedBcc !== receivedBcc) {
        this._fail(TNCWeb.connectionError(
          `Invalid BCC in incoming file header: expected 0x${expectedBcc.toString(16)}, received 0x${receivedBcc.toString(16)}.`,
          "HEADER_BCC"
        ));
        return;
      }
      if (payload.byteLength < 2 || payload[payload.byteLength - 1] !== 0x41) {
        return;
      }

      try {
        this.identifier = new TextDecoder("ascii").decode(payload.subarray(0, payload.byteLength - 1)).trim();
        this.filename = fromFe1DirectoryName(this.identifier);
      } catch (error) {
        this._fail(error);
        return;
      }
      this.lines = [];
      this.invalidBlocks = 0;
      this.phase = "receiving";
      this.onStatus({
        phase: this.phase,
        identifier: this.identifier,
        filename: this.filename,
        lineCount: 0
      });
      this.onWrite(Uint8Array.from([CONTROL.ACK]));
    }

    _processBlocks() {
      while (this.phase === "receiving" && this.buffer.byteLength > 0) {
        if (this.buffer[0] === CONTROL.ETX) {
          this.buffer = this.buffer.slice(1);
          if (this.buffer[0] === CONTROL.EOT) {
            this.buffer = this.buffer.slice(1);
          }
          this._complete();
          return;
        }
        if (this.buffer[0] === CONTROL.EOT) {
          this._fail(TNCWeb.connectionError("TNC ended transfer without ETX.", "MISSING_ETX"));
          return;
        }
        if (this.buffer[0] !== CONTROL.STX) {
          this.buffer = this.buffer.slice(1);
          continue;
        }
        const etb = byteSequenceIndex(this.buffer, Uint8Array.from([CONTROL.ETB]), 1);
        if (etb === -1 || this.buffer.byteLength < etb + 2) {
          return;
        }
        const expectedBcc = calculateBcc(this.buffer.subarray(0, etb + 1));
        const receivedBcc = this.buffer[etb + 1];
        const payload = this.buffer.subarray(1, etb);
        let consumed = etb + 2;
        if (this.buffer[consumed] === CONTROL.DC1) {
          consumed += 1;
        }
        this.buffer = this.buffer.slice(consumed);

        if (expectedBcc !== receivedBcc) {
          this.invalidBlocks += 1;
          this.onWrite(Uint8Array.from([CONTROL.NAK]));
          if (this.invalidBlocks > 3) {
            this._fail(TNCWeb.connectionError("Too many invalid incoming data blocks.", "BLOCK_BCC_LIMIT"));
            return;
          }
          continue;
        }

        this.invalidBlocks = 0;
        this.lines.push(payload.slice());
        this.onWrite(Uint8Array.from([CONTROL.ACK]));
        this.onStatus({
          phase: this.phase,
          identifier: this.identifier,
          filename: this.filename,
          lineCount: this.lines.length
        });
      }
    }

    _complete() {
      const bytes = joinReceivedLineBlocks(this.lines);
      const result = {
        identifier: this.identifier,
        filename: this.filename,
        bytes,
        lineCount: this.lines.length
      };
      this.phase = "idle";
      this.identifier = "";
      this.filename = "";
      this.lines = [];
      this.invalidBlocks = 0;
      this.onStatus({ phase: "complete", lineCount: result.lineCount, filename: result.filename });
      this.onComplete(result);
    }

    _fail(error) {
      this.onError(error);
      this.onStatus({ phase: "failed", filename: this.filename, error: error.message });
      this.reset();
    }

    reset() {
      this.buffer = new Uint8Array(0);
      this.phase = "idle";
      this.identifier = "";
      this.filename = "";
      this.lines = [];
      this.invalidBlocks = 0;
    }
  }

  class Fe1DeleteResponder {
    constructor(options) {
      const settings = options || {};
      this.onDelete = settings.onDelete || (() => {});
      this.onStatus = settings.onStatus || (() => {});
      this.onError = settings.onError || (() => {});
      this.buffer = new Uint8Array(0);
      this.maxBufferedBytes = settings.maxBufferedBytes || 256;
      this.busy = false;
    }

    feed(value) {
      const bytes = TNCWeb.copyBytes(value);
      if (bytes.byteLength === 0 || this.busy) {
        return;
      }
      this.buffer = concatenate([this.buffer, bytes], this.buffer.byteLength + bytes.byteLength);
      const prefix = Uint8Array.from([CONTROL.DC3, CONTROL.ESC, CONTROL.DC1, 0x44, CONTROL.SP]);
      const start = byteSequenceIndex(this.buffer, prefix, 0);
      if (start === -1) {
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.byteLength - prefix.byteLength + 1));
        return;
      }
      if (start > 0) {
        this.buffer = this.buffer.slice(start);
      }
      const cr = byteSequenceIndex(this.buffer, Uint8Array.from([CONTROL.CR]), prefix.byteLength);
      if (cr === -1 || this.buffer.byteLength < cr + 2 || this.buffer[cr + 1] !== CONTROL.LF) {
        if (this.buffer.byteLength > this.maxBufferedBytes) {
          this.buffer = new Uint8Array(0);
        }
        return;
      }

      const identifier = new TextDecoder("ascii")
        .decode(this.buffer.subarray(prefix.byteLength, cr))
        .trim();
      this.buffer = this.buffer.slice(cr + 2);
      if (!identifier) {
        return;
      }
      this.busy = true;
      this.onStatus({ phase: "deleting", identifier });
      Promise.resolve(this.onDelete(identifier))
        .then(() => {
          this.onStatus({ phase: "delete-complete", identifier });
        })
        .catch((error) => {
          this.onError(error);
          this.onStatus({ phase: "delete-failed", identifier, error: error.message });
        })
        .finally(() => {
          this.busy = false;
        });
    }

    reset() {
      this.buffer = new Uint8Array(0);
      this.busy = false;
    }
  }

  Object.assign(TNCWeb, {
    CONTROL,
    DIRECTORY_REQUEST,
    DIRECTORY_REQUEST_ZERO,
    Fe1DirectoryResponder,
    Fe1DeleteResponder,
    Fe1FileResponder,
    Fe1Receiver,
    buildDirectoryResponse,
    byteSequenceIndex,
    calculateBcc,
    encodeDataBlock,
    formatDirectoryRecord,
    fromFe1DirectoryName,
    joinReceivedLineBlocks,
    splitFileLines,
    toFe1DirectoryName
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = TNCWeb;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
