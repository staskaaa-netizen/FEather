(function (global) {
  "use strict";

  const { test, equal, bytesEqual, includes } = global.TNCWebTest;
  const {
    DiagnosticLog,
    parseHex,
    toAnnotatedAscii,
    toAscii,
    toHex
  } = global.TNCWeb;

  test("Hex parser accepts complete byte pairs and all control codes", () => {
    bytesEqual(
      parseHex("0x00, 01 02\n03;04 05 06 11 13 15 17 1B 7F"),
      [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x11, 0x13, 0x15, 0x17, 0x1b, 0x7f]
    );
  });

  test("Hex parser rejects odd digits and non-hex characters", () => {
    let oddRejected = false;
    let characterRejected = false;
    try {
      parseHex("0 01");
    } catch (error) {
      oddRejected = true;
    }
    try {
      parseHex("01 ZZ");
    } catch (error) {
      characterRejected = true;
    }
    equal(oddRejected, true, "Odd number of nibbles should be rejected");
    equal(characterRejected, true, "Non-hex characters should be rejected");
  });

  test("Diagnostic formatting names control characters and has exact hex", () => {
    const bytes = [0x00, 0x01, 0x02, 0x03, 0x04, 0x06, 0x11, 0x13, 0x15, 0x17, 0x41];
    equal(toHex(bytes), "00 01 02 03 04 06 11 13 15 17 41");
    includes(toAnnotatedAscii(bytes), "<NUL><SOH><STX><ETX>");
    includes(toAnnotatedAscii(bytes), "<ACK><DC1><DC3><NAK><ETB>A");
    equal(toAscii([0x00, 0x41, 0x7f]), ".A.");
  });

  test("Diagnostic log counts bytes and exports timestamped trace", () => {
    const fixedDate = new Date("2026-10-20T12:34:56.789Z");
    const log = new DiagnosticLog({ now: () => fixedDate, limit: 10 });
    log.add("TX", [0x01, 0x00, 0x11], { label: "test packet" });
    log.add("RX", [0x06], { label: "ack" });
    equal(log.counters.TX, 3);
    equal(log.counters.RX, 1);
    includes(log.export("text"), "2026-10-20T12:34:56.789Z");
    includes(log.export("text"), "<SOH><NUL><DC1>");
    const parsed = JSON.parse(log.export("json"));
    equal(parsed.entries.length, 2);
    equal(parsed.entries[0].bytes[1], 0);
  });
})(window);
