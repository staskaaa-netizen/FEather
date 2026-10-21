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

## FreeCAD reference

FreeCAD 1.1.3 was found locally with:

```text
C:\Program Files\FreeCAD 1.1\Mod\CAM\Path\Post\scripts\heidenhain_post.py
```

That file is a three-axis Heidenhain postprocessor for FreeCAD CAM Path
objects. It can emit linear moves, arcs, drilling cycles, tool calls, labels,
and optional cutter compensation from FreeCAD toolpaths. It does not provide a
standalone generic G-code import-to-L conversion workflow, and FEather does not
embed or copy it.

For production programs requiring those CAM features, generate the Heidenhain
program with a controller-specific postprocessor rather than relying on
FEather's basic converter.
