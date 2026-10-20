# FEather

FEather is a browser-based FE401 file server for older Heidenhain CNC controls, connected through a stock USR-W610 Wi-Fi-to-RS232 adapter.

## Why FEather?

FEather was born out of respect for the engineering behind the older Heidenhain CNC controls.

By modern standards, these controllers may seem obscure and outdated. Yet they still work remarkably well, remain convenient to operate, and continue producing plenty of useful parts decades after they were built.

The original motivation was simple: replace the dedicated network-connected PC sitting beside my VMC with something smaller and simpler, without modifying the CNC controller itself.

FEather does exactly that. A small Wi-Fi serial adapter and a browser-based file server replace the PC, while the machine continues communicating through its familiar FE401 interface.

**FEather has been tested on a Heidenhain TNC 415B**, but should also work with other controllers supporting the FE401 protocol. Compatibility with those machines has not yet been verified.

Built using official manufacturer documentation.

## Current milestone

Implemented behavior includes:

- A byte-oriented `SerialTransport` abstraction.
- A browser WebSocket transport verified against the connected W610 stock page at `ws://192.168.8.187:8000`.
- Exact binary transmission through `WebSocket.send(Uint8Array)`.
- ArrayBuffer, Blob, and text receive conversion.
- Fragmentation-safe receive buffering.
- Explicit disconnect and connection-loss handling with no automatic reconnect.
- Timestamped hex/ASCII diagnostics, manual hex sending, trace export, and clear.
- A browser lock that prevents two FEather tabs from controlling the serial link at the same time.
- An FE1 plain-text directory responder using the FE401 record format from the TNC technical manual.
- Live TNC 415 verification of the request, filename mapping, ETX terminator, and EOT acknowledgement.
- Selected-program retrieval with XOR block-check characters, ACK/NAK handling, bounded retries, and ETX/EOT completion.
- TNC-to-browser block reception with BCC validation, ACK/NAK, and atomic IndexedDB commit after ETX.
- A persistent received-file list with Download and Delete controls.
- Multi-file Browse and drag-and-drop import with byte-exact IndexedDB storage.
- TNC-requested deletion with an updated external directory handshake.
- A compact primary workspace with diagnostics hidden by default.
- A Settings dialog for W610 endpoint, timeout, log view, and diagnostic visibility.
- Persistent non-file settings in `localStorage`.
- A top connection bar with an auto-connect option that makes one attempt and does not poll.
- A left browser-file list, selected-file preview, and compact floating transfer monitor.
- Browser tests with a simulated transport and scripted mock TNC.

Export-all/restore, rename/replace, full quota handling, and interrupted-transfer recovery are not yet claimed.

Diagnostics and manual byte transmission are hidden from the main screen. Enable **Show diagnostic terminal** in Settings when raw traffic is required. File contents remain in IndexedDB; connection and display preferences use `localStorage`.

The inspected W610 stores `38400 7E1`, transparent mode, and no flow control. Configure the TNC to match the W610 baud rate; FEather does not change converter settings.

A DB9 pins 2–3 loopback test on 20 October 2026 returned every transmitted byte exactly, including all values from `0x00` through `0x7F`. Twenty one-byte round trips measured 6 ms minimum, 12 ms median, and 28 ms maximum.

The live TNC directory test uses FE401 identifiers such as `H100`, which the TNC displays as `100.H`. The eight sample files are mapped as `H` plus the filename without `.H`.

The TNC successfully retrieved `CASEBOTT.H` and `CASEBTAP.H` from the browser. Every line block was acknowledged, the browser ended with ETX, and the TNC returned EOT.

The reverse direction was also verified: the TNC sent `CRANFINS.H` and `CRKFIN.H` to the browser, which validated and acknowledged every block, saved them to IndexedDB, and exposed them for download.

Known display issue: immediately after a TNC-to-browser upload, the TNC may initially show a partial external directory. Reopening the directory displays the complete list; the received files are already committed correctly.

## Run locally

Open [index.html](index.html) directly in Firefox or a Chromium-based browser. The current milestone uses classic scripts and has no build step. The browser must remain open and the computer must remain awake.

If a browser blocks a needed feature on `file://`, run the built-in static host:

```powershell
.\serve.ps1
```

Then open `http://localhost:8080/`. This server only serves static files; it is not a runtime TNC endpoint.

## Test

Open [tests/test-runner.html](tests/test-runner.html), or run it headlessly with Edge:

```powershell
& 'C:\Program Files (x86)\Microsoft\EdgeCore\155.0.4283.62\msedge.exe' `
  --headless=new --disable-gpu --allow-file-access-from-files `
  --virtual-time-budget=5000 --dump-dom `
  'file:///C:/acc/webremo/tests/test-runner.html'
```

The expected result is `33 passed, 0 failed`.

## Documentation

- [W610 transport evidence](docs/W610.md)
- [FE1 protocol status](docs/PROTOCOL.md)
- [Browser and hardware testing](docs/TESTING.md)
- [Unverified assumptions](docs/ASSUMPTIONS.md)
- [20 October 2026 hardware record](docs/HARDWARE-2026-10-20.md)

## Safety boundary

This build automatically answers FE1 directory, retrieval, receive, storage, and delete requests. Rename/replace, complete import/export, quota-edge handling, and interrupted-transfer recovery remain incomplete.
