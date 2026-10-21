# Browser and hardware testing

Document status: 20 October 2026. Transport and FE1 directory tested on the target TNC.

## Automated browser tests

Open `tests/test-runner.html` in Firefox or a Chromium browser. The suite currently contains 37 tests:

- Hex parsing, control-character naming, and diagnostic export.
- Configurable endpoint validation.
- Exact outbound bytes `0x00`–`0x7F`.
- Fragmented `ArrayBuffer` receive data.
- Text and Blob receive conversion.
- Fragmented and coalesced stream buffering.
- Explicit disconnect behavior.
- Unexpected connection loss without automatic reconnect.
- Bounded connection timeout.
- Invalid URL rejection.
- Disconnected write rejection.
- Scripted mock W610 fragmented responses.
- Mock serial connection loss.
- FE1 directory request fragmentation and exact response framing.
- Coalesced and unrelated FE1 directory request handling.
- Minimal single-entry directory response used for live TNC isolation.
- FE401-type `H100` identifier mapping and the equivalent zero/letter-O request variant.
- Selected-file BCC validation, line blocking, ACK/NAK retransmission, and ETX/EOT completion.
- Bundled NC catalog byte lengths and CRLF preservation.
- Incoming TNC file headers, valid/invalid block BCCs, ACK/NAK responses, and commit-on-ETX behavior.
- IndexedDB persistence, binary-exact retrieval, and duplicate-name handling.
- Fragmented TNC delete-command parsing and idempotent bundled-file seeding.
- Multi-format filename-to-FE1 type mapping and imported-file storage.
- G-code linear/arc conversion, unsupported-instruction reporting, structural validation, and auto-numbering.

The WebSocket tests use an injected `FakeWebSocket`. The mock TNC responses use synthetic byte sequences. They validate the browser transport and buffering code; they are **not** documented FE1 examples and do not prove TNC compatibility.

## Manual hardware validation

Record browser, operating system, W610 firmware, W610 page version, serial settings, timeout values, exact endpoint, and trace files with every stage.

### Stage 1 — Browser to W610

1. Join the W610 network and confirm `http://192.168.8.187/websocket.html` opens.
2. Inspect the stock page’s WebSocket URL, path, subprotocol, outgoing frame types, and incoming frame types.
3. Enter those exact values into FEather and connect.
4. Confirm the W610 link indicator turns active.
5. Disconnect and confirm no automatic reconnect occurs.

Pass evidence: screenshot or copied stock-page source and developer-tools WebSocket handshake.

Recorded result on 20 October 2026:

- Edge 155 loaded FEather from `file://`.
- Clicking Connect reached `W610 link active`.
- The verified endpoint was `ws://192.168.8.187:8000/`.
- No serial payload was sent during this connection-only test.

### Stage 2 — W610 to PC serial loopback

1. Connect the W610 RS232 port to a PC serial loopback with the intended 7E1 configuration.
2. Send a small known sequence through FEather.
3. Capture the serial bytes with an independent terminal or analyzer.
4. Echo data back and compare browser RX to the transmitted bytes.

Pass evidence: browser trace plus independent serial trace.

### Stage 3 — Control and binary integrity

Send and receive:

```text
00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 11 13 15 17 1A 1B 7F
00 01 02 ... 7E 7F
```

Confirm there is no replacement, escaping, UTF-8 expansion, line-ending conversion, or dropped byte. Repeat at 9600, 19200, 38400, and the intended production baud rate.

Failure to preserve bytes immediately blocks FE1 implementation until the stock WebSocket framing is understood.

Recorded result on 20 October 2026 with DB9 pins 2–3 connected:

- `00 01 02 03 04 06 11 13 15 17 1B 7F 41 42 43 0D 0A` returned exactly.
- Every byte from `00` through `7F` returned exactly.
- The full 128-byte range arrived in one WebSocket message.
- Twenty one-byte round trips measured 6 ms minimum, 12 ms median, and 28 ms maximum.

Stage 3 is complete for this W610 at `38400 7E1`.

### Stage 4 — FE1 directory request

Recorded result on 20 October 2026:

- TNC request: `13 1B 11 4F 20 44 0D 0A`.
- One-record test: FE401 header plus `H100` record and `<ETX>`.
- TNC displayed `100.H`.
- TNC replied `<EOT>`.
- Full eight-file response was accepted and all eight names were visible.
- After selection, the TNC requested `H100` with a BCC-protected header.

Directory listing is complete for this machine.

### Stage 5 — Receive a small program

Use a non-production program. Verify the browser does not acknowledge an invalid block and that a failed receive leaves no stored result. This stage becomes executable only after IndexedDB atomic storage is implemented.

Recorded result on 20 October 2026:

- TNC sent `CRANFINS.H` with an `A` header; 16 blocks were validated and ACKed.
- TNC sent `CRKFIN.H`; 34 blocks were validated and ACKed.
- Both ended with ETX/EOT and were saved in IndexedDB.
- Received files appeared in the browser's stored-file list.
- The next external directory response included both new programs.

### Stage 6 — Return the same program

Compare size and BCC at both ends, then byte-compare the stored source and file accepted by the TNC.

Recorded result on 20 October 2026 for `CASEBOTT.H`:

- Directory selection generated `HCASEBOTT` with valid BCC.
- Browser sent ACK followed by 38 BCC-protected line blocks.
- TNC acknowledged every block.
- Browser sent ETX and TNC returned EOT.
- No NAK or timeout occurred.

The same complete ACK/ETX/EOT sequence also succeeded for `CASEBTAP.H` (26 lines).

### Stage 6.1 — Delete an external file

Recorded result on 20 October 2026:

- TNC sent `<DC3><ESC><DC1>D HCASEBOTT<CR><LF>`.
- Browser removed the IndexedDB record and sent the updated FE401 directory with ETX.
- TNC returned EOT and no longer displayed the file.
- The same operation succeeded for `HCBERNG37`.

### Stage 7 — Larger files and interruption

Repeat with progressively larger files. During a transfer, test DC3 pause/resume, disconnect, timeout, browser sleep, and invalid BCC. Record whether the TNC can recover without manual reset. A reconnect must start a new transfer.

## Latency checks

The current W610 manual states an approximately 40–50 ms Wi-Fi→UART→Wi-Fi loopback delay in its free-framing test (p. 27, §4.3.2). Measure the installed device instead of relying on that figure. Capture at least:

- min, median, and maximum round-trip delay for 1–8 byte requests;
- delay distribution for 1 KiB and 4 KiB chunks;
- whether serial free-frame splitting changes message boundaries;
- behavior with the W610 serial auto-frame settings.

The app uses a 5-second connection timeout by default. FE1 response timeouts remain unspecified until hardware traces establish safe values.
