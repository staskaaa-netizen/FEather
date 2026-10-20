# FE1 protocol status

Document status: 20 October 2026.

## Scope

Milestone 1 implements no FE1 commands. It does not generate a header, calculate an FE BCC, acknowledge a data block, request a directory, upload a program, or download a program. No FE1 packet semantics are claimed by this build.

This boundary is intentional. The requested project says to establish packet semantics from primary documentation before implementing a complete FE1 state machine.

## Research status

The cited sources are:

1. Heidenhain TNC 407/415/425 Technical Manual, chapter 8, §3.2, “Data Transfer with Block Check Character”:
   - https://heidenhain.manymanuals.com/equipment/tnc-407-243-020-technical-manual/user-manual-39018/683
2. Heidenhain TNC 415B/425 Service Manual, chapter 16, Data Interfaces:
   - https://product.heidenhain.de/JPBC/image/HWP.DE/hlr-system/606499_00_a_02.pdf
3. pyLSV2:
   - https://github.com/drunsinn/pyLSV2

During the Milestone 1 build, the TNC service-manual host timed out and the technical-manual page was blocked by Cloudflare. Those failures are recorded rather than replaced with guessed packet formats. pyLSV2 remains only a secondary software-design reference; it must not be used as evidence for FE1 framing.

## What remains for Milestone 3

Before coding the FE1 foundation, obtain local copies or stable captures of the cited primary pages and record:

- exact header field ordering and machine-specific values;
- directory request/response syntax;
- file direction and transfer-mode values;
- data-block start/end semantics;
- BCC input range, representation, and accumulation rule;
- expected ACK, NAK, DC1, and DC3 transitions;
- EOT sequencing and retry boundaries;
- documented timing or examples;
- whether the TNC 415 configuration changes any field.

Every implemented command must then cite an exact manual page or section. Tests based on a scripted response must be labeled as assumed rather than documented.

## Transport boundary

`src/transport.js` delivers byte chunks and never interprets FE control characters. A future `src/fe1.js` state machine can consume `ByteStreamBuffer` without depending on WebSocket message boundaries.
