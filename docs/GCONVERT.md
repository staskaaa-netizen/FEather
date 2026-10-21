# G-code to Heidenhain L conversion

FEather includes a deliberately small, browser-only G-code converter. It is a
source-to-source convenience tool for short, already-postprocessed three-axis
mill programs. It is not a full CAM postprocessor and does not query the TNC,
tool table, machine parameters, or current work offsets.

The generated program always uses millimeters, `BEGIN PGM` / `END PGM`, and
automatic line numbering. Review every converted program and verify it in the
TNC simulation or another safe dry run before machine execution.

## Converted

| Source | FEather output | Notes |
| --- | --- | --- |
| `G0`, `G1` with `X`, `Y`, or `Z` | `L` block with absolute coordinates and `R0` | Feed and M words on the same line are retained. Rapid and feed motion both become an L block. |
| `G2`, `G3` with `I` / `J` center offsets | `CC` center block followed by `C ... DR-` or `DR+` | XY-plane arcs only. FEather calculates the absolute center and endpoint. |
| `G90`, `G91` | Absolute or incremental coordinate output | Incremental axes are written with an `I` prefix, for example `IX+1`. |
| `G21`, `G17`, `G40`, `G94` | No direct output block | Metric units, XY plane, no cutter compensation, and feed per minute are treated as supported setup modes. |
| `G80` | No direct output block | Treated as cancellation of a canned-cycle mode only. |
| `F` on a converted linear or arc move | `F` in the corresponding L block | Decimal points are changed to decimal commas. |
| `T` and `S` followed by `M6` | `TOOL CALL <T> Z S<S>` | Uses the most recent T and S seen before M6. It does not create a tool definition or validate tool data. |
| Other M codes | `M` in an L block | M codes are passed through syntactically. FEather does not validate whether each code is supported by the target TNC. |
| Parenthesized or semicolon comments | `; comment` | Comments are emitted as separate L comment blocks after the source line. |
| `%` and `O<number>` lines | Omitted | Program delimiters and controller-specific program headers are not translated. |

## Not converted

- Inches (`G20`). A warning is generated and the source line is retained as a comment.
- Modal-only motion or bare coordinate blocks such as `X10 Y20` after an earlier `G1`. A G0/G1/G2/G3 word must appear on the converted line.
- Arc center formats using `R`, full-circle syntax without an endpoint, helical `Z` movement, and non-XY planes.
- Cutter compensation (`G41`, `G42`), tool-length compensation, work offsets such as `G54`, and machine-coordinate commands.
- Drilling and canned cycles such as `G73` and `G81` through `G89`.
- Dwell, probing, rigid tapping, threading, turning, and lathe-specific cycles.
- Rotary or additional axes (`A`, `B`, `C`, `U`, `V`, `W`).
- Subprograms, labels, macros, parameters, loops, conditional code, and controller extensions.
- Tool table data, tool radius/length definitions, spindle direction validation, coolant semantics, and machine-specific M-code behavior.
- Postprocessor setup such as program-zero selection, safe Z, stock-aware ordering, cutter engagement, collision checks, and feed optimization.

Words that FEather does not consume, including `R`, `K`, `P`, and `Q`, are not
used in the generated L program. Not every ignored word is guaranteed to
produce a warning. Unsupported G-codes are retained as comments, but the
result should still be checked line by line.

## FreeCAD experiment

FreeCAD 1.1.3 was found locally with:

```text
C:\Program Files\FreeCAD 1.1\Mod\CAM\Path\Post\scripts\heidenhain_post.py
```

FreeCAD also includes G-code preprocessors, and its internal `Path.Command`
representation is essentially parsed G-code. Therefore, importing ordinary
G-code before postprocessing is technically possible. A local headless probe
on 21 October 2026 tested this route with ordinary G0/G1/G2 input.

The probe converted the commands and produced recognizable Heidenhain blocks,
including:

```text
L X0.000 Y0.000 Z5.000 R0 F8000 M3
L X20.000 Y10.000 R0 F250 M
CC X25.000 Y10.000
C X30.000 Y10.000 DR- R0 F250 M
```

It also exposed blockers in the bundled FreeCAD 1.1.3 post:

- The script still references removed FreeCAD module names, so compatibility aliases were required before it would run.
- A legacy compensation guard skipped all motion unless another workaround was applied.
- The generated header omitted the program name.
- Some motion lines ended with an incomplete `M`.
- Feed and spindle commands were synthesized by the post instead of faithfully preserving the source program.
- Source comments and ordinary M commands were not reliably carried through.

The current upstream FreeCAD Heidenhain post has been substantially rewritten
and supports a much broader command set, including arcs, fixtures, cutter
compensation, dwell, drilling and tapping cycles, coolant, tool calls, and
legacy TNC cycle formats. That newer implementation depends on FreeCAD machine
post APIs not shipped with FreeCAD 1.1.3, so it cannot be copied unchanged into
the installed version or run in a static web page.

FreeCAD's postprocessor is therefore a useful reference for a future portable
L-code converter, but FEather does not embed or call it. The bundled 1.1.3
version is not considered output-safe for arbitrary G-code without a dedicated
compatibility layer and extensive validation.

For production programs requiring those CAM features, generate the Heidenhain
program with a controller-specific postprocessor rather than relying on
FEather's basic converter.
