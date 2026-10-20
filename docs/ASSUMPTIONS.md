# Unverified assumptions and constraints

Current as of 20 October 2026.

1. The W610 WebSocket endpoint is operator-configurable. `ws://10.10.100.254:8000/` is only a visibly marked candidate, not a verified endpoint.
2. Binary WebSocket frames are used for outbound bytes. The stock W610 page’s frame types and text encoding remain unverified.
3. Incoming text frames are mapped with UTF-8. This covers ASCII/7-bit bytes but may not preserve arbitrary file bytes if the W610 uses text frames.
4. WebSocket message boundaries are not treated as serial or FE message boundaries.
5. A lost connection requires an explicit new connection. Partial receive data is discarded and is never resumed silently.
6. Cross-tab exclusion uses the Web Locks API with a short localStorage lease fallback. It cannot stop unrelated WebSocket clients outside TNCweb.
7. The browser and computer must remain awake and connected. Milestone 1 has no service worker, background server, or sleep recovery.
8. FE1 commands and timings are not implemented or assumed.
9. The W610 at the documented default address was not reachable during this build, so no hardware evidence exists yet.
10. Final browser and TNC 415 compatibility requires the staged tests in `docs/TESTING.md`.
