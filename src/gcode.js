(function (global) {
  "use strict";

  const MOTION = new Set([0, 1, 2, 3]);

  function formatNumber(value) {
    return String(value).replace(".", ",");
  }

  function coordinate(axis, value, incremental) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Invalid ${axis} coordinate: ${value}`);
    }
    return `${incremental ? "I" : ""}${axis}${number >= 0 ? "+" : "-"}${formatNumber(Math.abs(number))}`;
  }

  function parseWords(line) {
    const words = [];
    const pattern = /([A-Z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      words.push({ letter: match[1], value: Number(match[2]), text: match[2] });
    }
    return words;
  }

  function numberProgramLines(text, startNumber) {
    const start = Number.isInteger(startNumber) ? startNumber : 0;
    return String(text)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1))
      .map((line, index) => {
        const content = line.replace(/^\s*(?:\/\s*)?\d+\s*/, "").replace(/^\s*N\d+\s*/i, "").trimEnd();
        return `${start + index}  ${content}`;
      })
      .join("\r\n");
  }

  function convertGcodeToL(source, options) {
    const settings = options || {};
    const programName = String(settings.programName || "GCONV").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 15) || "GCONV";
    const warnings = [];
    const body = [];
    let absolute = true;
    let currentX = 0;
    let currentY = 0;
    let currentZ = 0;
    let pendingTool = null;
    let pendingSpeed = null;

    const inputLines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    for (let lineIndex = 0; lineIndex < inputLines.length; lineIndex += 1) {
      const original = inputLines[lineIndex].trim();
      if (!original || original.startsWith("%")) {
        continue;
      }
      const comments = [];
      const commentPattern = /\(([^)]*)\)/g;
      let commentMatch;
      while ((commentMatch = commentPattern.exec(original)) !== null) {
        comments.push(commentMatch[1].trim());
      }
      let clean = original.replace(commentPattern, "");
      const semicolon = clean.indexOf(";");
      if (semicolon >= 0) {
        comments.push(clean.slice(semicolon + 1).trim());
        clean = clean.slice(0, semicolon);
      }
      clean = clean.trim().toUpperCase();
      if (!clean || /^O\d+/.test(clean)) {
        continue;
      }

      const words = parseWords(clean);
      const gCodes = words.filter((word) => word.letter === "G").map((word) => Math.trunc(word.value));
      const mCodes = words.filter((word) => word.letter === "M").map((word) => Math.trunc(word.value));
      const values = Object.fromEntries(words.filter((word) => ["X", "Y", "Z", "I", "J", "F", "S", "T"].includes(word.letter)).map((word) => [word.letter, word.value]));
      let motion = null;
      let unsupported = false;

      for (const gCode of gCodes) {
        if (gCode === 20) {
          warnings.push(`Line ${lineIndex + 1}: inch mode (G20) is not converted. Use millimeters.`);
          unsupported = true;
        } else if (gCode === 21 || gCode === 17 || gCode === 40 || gCode === 94) {
          // Explicitly supported setup modes with no direct L block.
        } else if (gCode === 90) {
          absolute = true;
        } else if (gCode === 91) {
          absolute = false;
        } else if (MOTION.has(gCode)) {
          motion = gCode;
        } else if (gCode === 80) {
          // Cancel canned cycle: no equivalent block is emitted.
        } else {
          warnings.push(`Line ${lineIndex + 1}: G${gCode} is not supported and was skipped.`);
          unsupported = true;
        }
      }

      if (values.T !== undefined) {
        pendingTool = values.T;
      }
      if (values.S !== undefined) {
        pendingSpeed = values.S;
      }
      if (unsupported) {
        body.push(`; UNSUPPORTED SOURCE LINE ${lineIndex + 1}: ${original}`);
        continue;
      }

      if (motion === 0 || motion === 1) {
        const parts = ["L"];
        if (values.X !== undefined) {
          parts.push(coordinate("X", values.X, !absolute));
          currentX = absolute ? values.X : currentX + values.X;
        }
        if (values.Y !== undefined) {
          parts.push(coordinate("Y", values.Y, !absolute));
          currentY = absolute ? values.Y : currentY + values.Y;
        }
        if (values.Z !== undefined) {
          parts.push(coordinate("Z", values.Z, !absolute));
          currentZ = absolute ? values.Z : currentZ + values.Z;
        }
        if (parts.length > 1) {
          parts.push("R0");
          if (values.F !== undefined) {
            parts.push(`F${formatNumber(values.F)}`);
          }
          if (mCodes.length > 0) {
            parts.push(...mCodes.map((code) => `M${code}`));
          }
          body.push(parts.join(" "));
        }
      } else if (motion === 2 || motion === 3) {
        if (values.I === undefined && values.J === undefined) {
          warnings.push(`Line ${lineIndex + 1}: arc without I/J center was skipped.`);
          body.push(`; UNSUPPORTED ARC SOURCE LINE ${lineIndex + 1}: ${original}`);
          continue;
        }
        const centerX = currentX + (values.I || 0);
        const centerY = currentY + (values.J || 0);
        const endX = values.X === undefined ? currentX : absolute ? values.X : currentX + values.X;
        const endY = values.Y === undefined ? currentY : absolute ? values.Y : currentY + values.Y;
        body.push(`CC ${coordinate("X", centerX, false)} ${coordinate("Y", centerY, false)}`);
        const arc = ["C", coordinate("X", endX, false), coordinate("Y", endY, false), `DR${motion === 2 ? "-" : "+"}`];
        if (values.F !== undefined) {
          arc.push(`F${formatNumber(values.F)}`);
        }
        body.push(arc.join(" "));
        currentX = endX;
        currentY = endY;
        if (values.Z !== undefined) {
          warnings.push(`Line ${lineIndex + 1}: helical Z movement is not converted.`);
        }
        if (mCodes.length > 0) {
          body.push(`L ${mCodes.map((code) => `M${code}`).join(" ")}`);
        }
      } else if (mCodes.length > 0) {
        if (mCodes.includes(6)) {
          const tool = pendingTool === null ? 0 : pendingTool;
          const speed = pendingSpeed === null ? "" : ` S${formatNumber(pendingSpeed)}`;
          body.push(`TOOL CALL ${tool} Z${speed}`);
        } else {
          body.push(`L ${mCodes.map((code) => `M${code}`).join(" ")}`);
        }
      } else if (values.F !== undefined || values.S !== undefined || values.T !== undefined) {
        warnings.push(`Line ${lineIndex + 1}: modal word was not emitted without a motion or M command.`);
      }

      if (comments.length > 0) {
        body.push(`; ${comments.join(" ")}`);
      }
    }

    const unnumbered = [`BEGIN PGM ${programName} MM`, ...body, `END PGM ${programName} MM`].join("\n");
    return {
      programName,
      text: `${numberProgramLines(unnumbered, 0)}\r\n`,
      warnings,
      validStructure: true
    };
  }

  function validateLProgram(text) {
    const normalized = String(text).replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n").map((line) => line.replace(/^\s*(?:\/\s*)?\d+\s+/, "").trim()).filter(Boolean);
    if (lines.length < 2) {
      return { valid: false, error: "The program has no complete BEGIN/END structure." };
    }
    if (!/^BEGIN PGM [A-Z0-9_]+ (?:MM|INCH)$/i.test(lines[0])) {
      return { valid: false, error: "The first block must be BEGIN PGM <name> MM or INCH." };
    }
    if (!/^END PGM [A-Z0-9_]+ (?:MM|INCH)$/i.test(lines[lines.length - 1])) {
      return { valid: false, error: "The last block must be END PGM <name> MM or INCH." };
    }
    return { valid: true };
  }

  global.TNCWeb = global.TNCWeb || {};
  Object.assign(global.TNCWeb, {
    convertGcodeToL,
    numberProgramLines,
    validateLProgram
  });
})(window);
