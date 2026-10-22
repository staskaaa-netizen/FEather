# FEather

FEather is a browser-based FE401 file server for older Heidenhain CNC controls, connected through a stock USR-W610 Wi-Fi-to-RS232 adapter.

## Why FEather?

FEather was born out of respect for the engineering behind the older Heidenhain CNC controls.

By modern standards, these controllers may seem obscure and outdated. Yet they still work remarkably well, remain convenient to operate, and continue producing plenty of useful parts decades after they were built.

The original motivation was simple: replace the dedicated network-connected PC sitting beside my VMC with something smaller and simpler, without modifying the CNC controller itself.

FEather does exactly that. A small Wi-Fi serial adapter and a browser-based file server replace the PC, while the machine continues communicating through its familiar FE401 interface.

**FEather has been tested on a Heidenhain TNC 415B**, but should also work with other controllers supporting the FE401 protocol. Compatibility with those machines has not yet been verified.

Built using official manufacturer documentation.

## Run from GitHub, no installation required

Open FEather directly from [GitHub Pages](https://staskaaa-netizen.github.io/FEather/) in Microsoft Edge. The hosted application is completely static and runs in the browser without installing FEather or a backend service.

The hosted version's direct connection to a local W610 is currently verified in Edge only. Firefox users should continue using the local/offline build until hosted Firefox compatibility has been verified.

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
- A Settings dialog for W610 endpoint, timeout, local-network discovery, log view, and diagnostic visibility.
- Persistent non-file settings in `localStorage`.
- A top connection bar with an auto-connect option that makes one attempt and does not poll.
- A left browser-file list, selected-file preview, and compact floating transfer monitor.
- Direct text editing with automatic block numbering on open, new blocks, paste, moves, blur, and Save.
- A basic, warning-driven G-code to Heidenhain L-code converter.
- Browser tests with a simulated transport and scripted mock TNC.

Export-all/restore, rename/replace, full quota handling, and interrupted-transfer recovery are not yet claimed.

Diagnostics and manual byte transmission are hidden from the main screen. Enable **Show diagnostic terminal** in Settings when raw traffic is required. File contents remain in IndexedDB; connection and display preferences use `localStorage`.

### G-code converter scope

The built-in converter is intentionally limited to short, already-postprocessed three-axis mill programs. It can convert:

- `G0` / `G1` moves using `X`, `Y`, and `Z`.
- XY-plane `G2` / `G3` arcs using `I` / `J`.
- `G90` absolute and `G91` incremental coordinates.
- Supported setup modes `G21`, `G17`, `G40`, and `G94`.
- Feed rates, comments, basic `M6` tool calls using preceding `T` / `S`, and other M codes passed through syntactically.

It does not convert inches, modal-only coordinate lines, `R`-format arcs, helical or non-XY arcs, cutter compensation, work offsets, drilling/canned cycles, additional axes, lathes, subprograms, macros, or parametric code. It does not create or validate tool tables, and M codes are not checked against a specific TNC configuration.

Converted output should always be reviewed and simulated before machine execution. See [G-code conversion scope](docs/GCONVERT.md) for the complete matrix, limitations, and the resulting FreeCAD compatibility experiment.

The inspected W610 stores `38400 7E1`, transparent mode, and no flow control. Configure the TNC to match the W610 baud rate; FEather does not change converter settings.

A DB9 pins 2–3 loopback test on 20 October 2026 returned every transmitted byte exactly, including all values from `0x00` through `0x7F`. Twenty one-byte round trips measured 6 ms minimum, 12 ms median, and 28 ms maximum.

The live TNC directory test uses FE401 identifiers such as `H100`, which the TNC displays as `100.H`. Imported `.H` files are mapped to an `H` prefix plus the filename without the extension.

The TNC successfully retrieved `CASEBOTT.H` and `CASEBTAP.H` from the browser. Every line block was acknowledged, the browser ended with ETX, and the TNC returned EOT.

The reverse direction was also verified: the TNC sent `CRANFINS.H` and `CRKFIN.H` to the browser, which validated and acknowledged every block, saved them to IndexedDB, and exposed them for download.

Known display issue: immediately after a TNC-to-browser upload, the TNC may initially show a partial external directory. Reopening the directory displays the complete list; the received files are already committed correctly.

## Usage

### Online

Open [https://staskaaa-netizen.github.io/FEather/](https://staskaaa-netizen.github.io/FEather/) in a supported browser.

The GitHub Pages deployment is completely static. Files stay in that origin's IndexedDB and are never uploaded to GitHub. Files stored under `file://` or `localhost` do not automatically migrate to the GitHub Pages origin.

### Offline or local

Open [index.html](index.html) directly in Firefox or a Chromium-based browser. The application uses classic scripts, has no build step, and keeps its existing local workflow. The browser must remain open and the computer must remain awake.

If a browser blocks a needed feature on `file://`, run the built-in static host:

```powershell
.\serve.ps1
```

Then open `http://localhost:8080/`. This server only serves static files; it is not a runtime TNC endpoint.

## Browser access to the W610

The GitHub Pages application connects directly to the configured private-IP `ws://...` endpoint. It never substitutes `wss://`.

Chromium versions implementing Local Network Access prompt for permission when the WebSocket first contacts a private address. FEather checks `local-network` (or `loopback-network` for loopback targets) and lets the actual WebSocket request trigger the permission prompt. It does not probe an unrelated HTTP port, and the WebSocket constructor does not receive `targetAddressSpace`.

If local-network permission is still pending on page open, auto-connect waits and asks you to press **Connect**. This gives the browser a direct user action for the permission prompt. Once access is granted, normal auto-connect behavior resumes on later visits.

The Settings dialog includes **Find W610**. Enter the first three IPv4 octets, such as `192.168.8`, and FEather scans `.1` through `.254` for HTTP responders, then checks those hosts on the configured WebSocket port. Browsers cannot read the PC's subnet directly, so the prefix must be entered or derived from the last configured IPv4 address. The scan does not send serial data. Browser local-network restrictions may still prevent discovery in unsupported browsers.

Firefox may block an HTTPS GitHub Pages document from opening an unencrypted WebSocket to a local address. If that happens, use the offline/local FEather application. Browser restrictions must not be bypassed.

No sample NC programs are included in the public repository. Use **Browse files** or drag and drop to add programs to the selected browser origin.

## Test

Open [tests/test-runner.html](tests/test-runner.html), or run it headlessly with Edge:

```powershell
& 'C:\Program Files (x86)\Microsoft\EdgeCore\155.0.4283.62\msedge.exe' `
  --headless=new --disable-gpu --allow-file-access-from-files `
  --virtual-time-budget=5000 --dump-dom `
  'file:///C:/acc/FEather/tests/test-runner.html'
```

The expected result is `45 passed, 0 failed`.

## Documentation

- [W610 transport evidence](docs/W610.md)
- [FE1 protocol status](docs/PROTOCOL.md)
- [Browser and hardware testing](docs/TESTING.md)
- [Unverified assumptions](docs/ASSUMPTIONS.md)
- [20 October 2026 hardware record](docs/HARDWARE-2026-10-20.md)

## Safety boundary

This build automatically answers FE1 directory, retrieval, receive, storage, and delete requests. Rename/replace, complete import/export, quota-edge handling, and interrupted-transfer recovery remain incomplete.

## Hashtags

`#FEather` `#TNCremo` `#Heidenhain` `#TNC415` `#TNC415B` `#FE401` `#CNC` `#FileServer` `#WebSocket` `#IndexedDB` `#JavaScript`
