# TNCweb

TNCweb is a browser-only transport and file-server project for a Heidenhain TNC 415 connected through a stock USR-W610 Wi-Fi-to-RS232 bridge. This repository currently implements **Milestone 1 only**.

## Current milestone

Milestone 1 provides:

- A byte-oriented `SerialTransport` abstraction.
- A browser WebSocket transport verified against the connected W610 stock page at `ws://192.168.8.187:8000`.
- Exact binary transmission through `WebSocket.send(Uint8Array)`.
- ArrayBuffer, Blob, and text receive conversion.
- Fragmentation-safe receive buffering.
- Explicit disconnect and connection-loss handling with no automatic reconnect.
- Timestamped hex/ASCII diagnostics, manual hex sending, trace export, and clear.
- A browser lock that prevents two TNCweb tabs from controlling the serial link at the same time.
- Browser tests with a simulated transport and scripted mock TNC.

FE1 directory, upload, download, IndexedDB storage, and a TNC server-active state are deliberately not claimed. The console displays `TNC server inactive — FE1 pending`.

The inspected W610 stores `38400 7E1`, transparent mode, and no flow control. Configure the TNC to match the W610 baud rate; TNCweb does not change converter settings.

A DB9 pins 2–3 loopback test on 20 October 2026 returned every transmitted byte exactly, including all values from `0x00` through `0x7F`. Twenty one-byte round trips measured 6 ms minimum, 12 ms median, and 28 ms maximum.

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

The expected result is `17 passed, 0 failed`.

## Documentation

- [W610 transport evidence](docs/W610.md)
- [FE1 protocol status](docs/PROTOCOL.md)
- [Browser and hardware testing](docs/TESTING.md)
- [Unverified assumptions](docs/ASSUMPTIONS.md)
- [20 October 2026 hardware record](docs/HARDWARE-2026-10-20.md)

## Safety boundary

This build can send arbitrary hexadecimal bytes only after an explicit operator action. It does not emit FE1 commands, acknowledge incoming file data, or persist NC files. Do not use it as a production file server until Milestones 2–5 are complete and hardware traces are recorded.
