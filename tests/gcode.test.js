(function (global) {
  "use strict";

  const { test, equal, includes } = global.TNCWebTest;
  const {
    convertGcodeToL,
    numberProgramLines,
    validateLProgram
  } = global.TNCWeb;

  test("Basic G-code converts to structured numbered L blocks", () => {
    const result = convertGcodeToL(`
      %
      O1000
      G21 G90
      G0 X0 Y0 Z5
      M3
      G1 X10 Y-5 Z2 F250
      G91
      G1 X1
      M5
      M30
    `, { programName: "TEST" });
    includes(result.text, "0  BEGIN PGM TEST MM");
    includes(result.text, "L X+0 Y+0 Z+5 R0");
    includes(result.text, "L X+10 Y-5 Z+2 R0 F250");
    includes(result.text, "L IX+1 R0");
    includes(result.text, "END PGM TEST MM");
    equal(result.warnings.length, 0);
    equal(validateLProgram(result.text).valid, true);
  });

  test("G-code arc conversion uses CC and C blocks", () => {
    const result = convertGcodeToL(`
      G21 G90
      G0 X0 Y0 Z0
      G2 X10 Y0 I5 J0 F100
      M30
    `, { programName: "ARC" });
    includes(result.text, "CC X+5 Y+0");
    includes(result.text, "C X+10 Y+0 DR- F100");
    equal(result.warnings.length, 0);
  });

  test("Unsupported G-code is warned and retained as a comment", () => {
    const result = convertGcodeToL("G20\nG1 X1 F10\nM30", { programName: "WARN" });
    equal(result.warnings.length, 1);
    includes(result.text, "; UNSUPPORTED SOURCE LINE 1");
    equal(validateLProgram(result.text).valid, true);
  });

  test("Auto-numbering replaces existing block numbers", () => {
    equal(
      numberProgramLines("12  BEGIN PGM A MM\n99  L X+1\n105  END PGM A MM", 0),
      "0  BEGIN PGM A MM\r\n1  L X+1\r\n2  END PGM A MM"
    );
  });
})(window);

