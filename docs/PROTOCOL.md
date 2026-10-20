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

## Implemented selected-file retrieval

The TNC's BCC-protected selected-file request is followed by:

1. Browser sends `<ACK>`.
2. Browser sends one program line as `<STX> line text <ETB> BCC <DC1>`.
3. TNC replies `<ACK>` for each valid line.
4. Browser re-sends the same block after `<NAK>` or ACK timeout.
5. After the last line is acknowledged, browser sends `<ETX>`.
6. TNC replies `<EOT>`.

The BCC is the XOR of every byte from `<STX>` through `<ETB>` inclusive. The same rule applies to the TNC's `<SOH>` header. Example: the captured `HCASEBOTT` header has BCC `0x02`.

The TNC successfully retrieved `CASEBOTT.H` and `CASEBTAP.H` through the browser on 20 October 2026. All line blocks were acknowledged and the final ETX/EOT handshake completed for both programs.

## Implemented TNC-to-browser receive

For a TNC upload, the TNC sends an `A` header:

```text
<SOH> HCRANFINS A <ETB> BCC
```

The browser then:

1. Validates the header BCC and sends `<ACK>`.
2. Buffers each `<STX> line <ETB> BCC` block.
3. Sends `<ACK>` only after validating the block BCC.
4. Sends `<NAK>` for invalid blocks and waits for retransmission.
5. Waits for `<ETX><EOT>` before committing.
6. Saves the reconstructed file to IndexedDB atomically.

Live verification:

- `CRANFINS.H`: 16 data blocks, every block ACKed, ETX/EOT received.
- `CRKFIN.H`: 34 data blocks, every block ACKed, ETX/EOT received.
- Both files were stored and immediately appeared in the next external directory response.

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
- Receive and atomically store files sent by the TNC.
- Implement IndexedDB-backed file management.
- Verify the sector-count unit and larger-transfer fragmentation.

## Transport boundary

`src/transport.js` delivers byte chunks and does not interpret FE1. `src/fe1.js` recognizes directory requests across fragmented WebSocket messages and returns the FE401-compatible directory response.
