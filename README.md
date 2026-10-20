# TNCweb

TNCweb is a browser-only transport and file-server project for a Heidenhain TNC 415 connected through a stock USR-W610 Wi-Fi-to-RS232 bridge. The transport milestone and the FE1 directory portion of the protocol milestone are implemented and hardware-verified.

## Current milestone

Implemented behavior includes:

- A byte-oriented `SerialTransport` abstraction.
- A browser WebSocket transport verified against the connected W610 stock page at `ws://192.168.8.187:8000`.
- Exact binary transmission through `WebSocket.send(Uint8Array)`.
- ArrayBuffer, Blob, and text receive conversion.
- Fragmentation-safe receive buffering.
- Explicit disconnect and connection-loss handling with no automatic reconnect.
- Timestamped hex/ASCII diagnostics, manual hex sending, trace export, and clear.
- A browser lock that prevents two TNCweb tabs from controlling the serial link at the same time.
- An FE1 plain-text directory responder using the FE401 record format from the TNC technical manual.
- Live TNC 415 verification of the request, filename mapping, ETX terminator, and EOT acknowledgement.
- Selected-program retrieval with XOR block-check characters, ACK/NAK handling, bounded retries, and ETX/EOT completion.
- Browser tests with a simulated transport and scripted mock TNC.

Program upload, IndexedDB storage, and interrupted-transfer recovery are not yet claimed.

The inspected W610 stores `38400 7E1`, transparent mode, and no flow control. Configure the TNC to match the W610 baud rate; TNCweb does not change converter settings.

A DB9 pins 2–3 loopback test on 20 October 2026 returned every transmitted byte exactly, including all values from `0x00` through `0x7F`. Twenty one-byte round trips measured 6 ms minimum, 12 ms median, and 28 ms maximum.

The live TNC directory test uses FE401 identifiers such as `H100`, which the TNC displays as `100.H`. The eight sample files are mapped as `H` plus the filename without `.H`.

The TNC successfully retrieved `CASEBOTT.H` and `CASEBTAP.H` from the browser. Every line block was acknowledged, the browser ended with ETX, and the TNC returned EOT.

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

The expected result is `28 passed, 0 failed`.

## Documentation

- [W610 transport evidence](docs/W610.md)
- [FE1 protocol status](docs/PROTOCOL.md)
- [Browser and hardware testing](docs/TESTING.md)
- [Unverified assumptions](docs/ASSUMPTIONS.md)
- [20 October 2026 hardware record](docs/HARDWARE-2026-10-20.md)

## Safety boundary

This build automatically answers FE1 directory and selected-program retrieval requests. It does not yet accept uploaded programs or persist imported files. Do not use it as a production file server until upload, storage, and interruption recovery are implemented and verified.
