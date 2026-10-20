# Unverified assumptions and constraints

Current as of 20 October 2026.

1. The W610 endpoint is verified as `ws://192.168.8.187:8000` with an empty path for the currently connected device.
2. Binary WebSocket frames are used for outbound bytes and match the stock W610 page’s binary sender. DB9 pins 2–3 loopback preserved all values from `0x00` through `0x7F` exactly.
3. Incoming text frames are mapped with UTF-8. This covers ASCII/7-bit bytes but may not preserve arbitrary file bytes if the W610 uses text frames.
4. WebSocket message boundaries are not treated as serial or FE message boundaries.
5. A lost connection requires an explicit new connection. Partial receive data is discarded and is never resumed silently.
6. Cross-tab exclusion uses the Web Locks API with a short localStorage lease fallback. It cannot stop unrelated WebSocket clients outside TNCweb.
7. The browser and computer must remain awake and connected. Milestone 1 has no service worker, background server, or sleep recovery.
8. FE1 commands and timings are not implemented or assumed.
9. The connected W610 stores `38400 7E1`, transparent mode, and no flow control. The TNC must be configured to the same baud rate.
10. Edge 155 opened the app from `file://`, connected to the W610, and completed the byte-identical loopback tests. Firefox and final TNC 415 compatibility still require the staged tests in `docs/TESTING.md`.
