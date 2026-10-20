# FE1 protocol status

Document status: 20 October 2026. Directory response verified on the target TNC 415.

## Primary documentation

1. Heidenhain, *Technical Manual TNC 407/TNC 415/TNC 425*:
   - Local copy: `C:\acc\cnc docs\Technical.pdf`
   - Printed section 8-41, "Request external directory."
   - Printed section 8-36, "Data Transfer with Block Check Character (BCC)."
2. Heidenhain, *Service Manual TNC 407/415*, issued 1 September 1995:
   - Local copy: `C:\acc\cnc docs\service manual.pdf`, pages 63-64.
3. FE401B operating-manual directory layout supplied by the operator and verified against the live TNC:
   - Four heading lines followed by records containing a type-prefixed identifier, occupied-sector count, and starting-sector count.
   - `FREE:` record for available sectors.

## Implemented FE1 directory exchange

The live TNC request is:

```text
13 1B 11 4F 20 44 0D 0A
```

This is `DC3 ESC DC1 "O" SP "D" CR LF`. The implementation also accepts the documented `0x30` zero variant. The observed byte from this TNC is `0x4F`, so that is the canonical constant for the tested machine.

The response is plain ASCII, not BCC-protected file blocks:

```text
FE 401 V.01
Filename       # Sector Start
-----------------------------
Directory
H100                   3       5
<ETX>
```

The live TNC displayed `100.H` for `H100`, then replied `<EOT>` (`0x04`). This confirmed the filename mapping and handshake:

- `.H` PC filename `100.H` maps to FE401 identifier `H100`.
- `CASEBOTT.H` maps to `HCASEBOTT`.
- The response ends with `<ETX>` (`0x03`).
- The TNC acknowledges the complete directory with `<EOT>` (`0x04`).
- Four CRLF-terminated heading lines precede file records.
- Each file record contains identifier, occupied sectors, and starting sector.

The full eight-file response was then accepted and displayed by the TNC.

## Selected-file request captured

After selecting the test program, the TNC sent:

```text
01 48 31 30 30 45 17 2A 03 04
```

Decoded:

```text
<SOH> H100 E <ETB> "*" <ETX> <EOT>
```

This is a BCC-protected request for program `H100`, transfer mode `E` (input). The BCC byte is `0x2A`, ASCII `*`. File retrieval is not yet implemented.

After selecting `CASEBOTT.H` from the full eight-file list, the TNC sent:

```text
01 48 43 41 53 45 42 4F 54 54 45 17 02
```

Decoded:

```text
<SOH> HCASEBOTT E <ETB> <STX>
```

The final `0x02` occupies the BCC position in this capture. This confirms the PC filename to FE401 identifier mapping beyond the synthetic `H100` test.

## Remaining FE1 work

- Calculate and validate block BCC for file headers and data blocks.
- Verify ACK/NAK, DC1/DC3, retry, and timeout transitions using live traces.
- Serve the selected program body and finish with ETX/EOT.
- Receive and atomically store files sent by the TNC.
- Implement IndexedDB-backed file management.
- Verify the sector-count unit and larger-transfer fragmentation.

## Transport boundary

`src/transport.js` delivers byte chunks and does not interpret FE1. `src/fe1.js` recognizes directory requests across fragmented WebSocket messages and returns the FE401-compatible directory response.
