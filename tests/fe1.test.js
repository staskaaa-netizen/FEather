(function (global) {
  "use strict";

  const { test, equal, bytesEqual, includes } = global.TNCWebTest;
  const {
    DIRECTORY_REQUEST,
    Fe1DirectoryResponder,
    Fe1FileResponder,
    Fe1Receiver,
    buildDirectoryResponse,
    calculateBcc,
    encodeDataBlock,
    fromFe1DirectoryName,
    splitFileLines
  } = global.TNCWeb;

  const sampleFiles = [
    { name: "CASEBOTT.H", size: 764 },
    { name: "CASEBTAP.H", size: 542 },
    { name: "CASEMAIN.H", size: 560 },
    { name: "CBERNG37.H", size: 417 }
  ];

  test("FE1 directory request is recognized across single-byte fragments", () => {
    const responses = [];
    const responder = new Fe1DirectoryResponder({
      getFiles: () => sampleFiles,
      onResponse: (bytes) => responses.push(bytes)
    });
    for (const byte of DIRECTORY_REQUEST) {
      responder.feed([byte]);
    }
    equal(responses.length, 1);
    equal(responses[0][responses[0].length - 1], 0x03);
  });

  test("FE1 directory response uses FE401 headers and mapped program identifiers", () => {
    const response = buildDirectoryResponse(sampleFiles, { freeSectors: 3000 });
    const text = new TextDecoder().decode(response.subarray(0, response.length - 1));
    const lines = text.split("\r\n").filter(Boolean);
    equal(lines.length, 4 + sampleFiles.length + 1);
    includes(lines[4], "HCASEBOTT");
    includes(lines[5], "HCASEBTAP");
    includes(lines[6], "HCASEMAIN");
    includes(lines[7], "HCBERNG37");
    includes(lines[8], "FREE:");
    includes(lines[8], "3000");
    equal(response[response.length - 1], 0x03);
  });

  test("Minimal FE1 directory response displays H100 as 100.H", () => {
    const response = buildDirectoryResponse(sampleFiles, { minimalDirectory: true });
    const text = new TextDecoder().decode(response.subarray(0, response.length - 1));
    includes(text, "FE 401 V.01\r\n");
    includes(text, "H100");
    equal(text.split("\r\n").filter(Boolean).length, 5);
    equal(response[response.length - 1], 0x03);
  });

  test("FE1 directory request accepts both observed O and documented zero variants", () => {
    const responses = [];
    const responder = new Fe1DirectoryResponder({
      getFiles: () => sampleFiles,
      onResponse: (bytes) => responses.push(bytes)
    });
    responder.feed(DIRECTORY_REQUEST);
    global.TNCWeb.DIRECTORY_REQUEST_ZERO.forEach((byte) => responder.feed([byte]));
    equal(responses.length, 2);
  });

  test("FE1 header BCC matches the captured HCASEBOTT request", () => {
    const block = new TextEncoder().encode(`\x01HCASEBOTTE\x17`);
    equal(calculateBcc(block), 0x02);
  });

  test("FE1 file line blocks preserve content and calculate BCC", () => {
    const lines = splitFileLines(new TextEncoder().encode("0 BEGIN\r\n1 NEXT\r\n"));
    equal(lines.length, 2);
    equal(new TextDecoder().decode(lines[0]), "0 BEGIN");
    equal(new TextDecoder().decode(lines[1]), "1 NEXT");
    const block = encodeDataBlock(lines[0]);
    equal(block[0], 0x02);
    equal(block[block.length - 3], 0x17);
    equal(block[block.length - 1], 0x11);
    equal(block[block.length - 2], calculateBcc(block.subarray(0, block.length - 2)));
  });

  test("FE1 selected-file responder serves lines through ACK, NAK, ETX and EOT", async () => {
    const file = new TextEncoder().encode("0 BEGIN PGM TEST MM\r\n1 END PGM TEST MM\r\n");
    const writes = [];
    const statuses = [];
    const responder = new Fe1FileResponder({
      getFile: (identifier) => identifier === "HTEST" ? file : null,
      onWrite: (bytes) => writes.push(bytes.slice()),
      onStatus: (status) => statuses.push(status),
      timeoutMs: 200
    });
    const headerBase = new TextEncoder().encode("\x01HTESTE\x17");
    const header = new Uint8Array(headerBase.length + 1);
    header.set(headerBase);
    header[header.length - 1] = calculateBcc(headerBase);
    responder.feed(header);
    await global.TNCWebTest.wait(20);

    equal(writes.length, 2);
    bytesEqual(writes[0], [0x06]);
    equal(writes[1][0], 0x02);
    includes(new TextDecoder().decode(writes[1]), "0 BEGIN PGM TEST MM");

    responder.feed([0x06]);
    equal(writes.length, 3);
    includes(new TextDecoder().decode(writes[2]), "1 END PGM TEST MM");

    responder.feed([0x15]);
    equal(writes.length, 4);
    bytesEqual(writes[3], writes[2]);

    responder.feed([0x06]);
    equal(writes.length, 5);
    bytesEqual(writes[4], [0x03]);
    responder.feed([0x04]);
    equal(statuses[statuses.length - 1].phase, "complete");
    equal(responder.phase, "idle");
  });

  test("FE1 selected-file responder bounds ACK retries", async () => {
    const errors = [];
    const responder = new Fe1FileResponder({
      getFile: () => new TextEncoder().encode("0 TEST\r\n"),
      onWrite: () => {},
      onError: (error) => errors.push(error),
      timeoutMs: 10,
      maxRetries: 1
    });
    const headerBase = new TextEncoder().encode("\x01HTESTE\x17");
    const header = new Uint8Array(headerBase.length + 1);
    header.set(headerBase);
    header[header.length - 1] = calculateBcc(headerBase);
    responder.feed(header);
    await global.TNCWebTest.wait(150);
    equal(errors.length, 1);
    equal(errors[0].code, "ACK_TIMEOUT");
    equal(responder.phase, "idle");
  });

  test("FE1 receiver validates blocks and commits only after ETX", () => {
    const writes = [];
    const completions = [];
    const receiver = new Fe1Receiver({
      onWrite: (bytes) => writes.push(bytes.slice()),
      onComplete: (result) => completions.push(result)
    });
    const headerBase = new TextEncoder().encode("\x01HTESTA\x17");
    const header = new Uint8Array(headerBase.length + 1);
    header.set(headerBase);
    header[header.length - 1] = calculateBcc(headerBase);
    receiver.feed(header);
    bytesEqual(writes[0], [0x06]);

    const first = encodeDataBlock(new TextEncoder().encode("0 BEGIN PGM TEST MM"));
    receiver.feed(first);
    bytesEqual(writes[1], [0x06]);
    equal(completions.length, 0);
    equal(receiver.lines.length, 1);

    const invalid = first.slice();
    invalid[invalid.length - 2] ^= 0x01;
    receiver.feed(invalid);
    bytesEqual(writes[2], [0x15]);
    equal(receiver.lines.length, 1);

    const second = encodeDataBlock(new TextEncoder().encode("1 END PGM TEST MM"));
    receiver.feed(second);
    receiver.feed([0x03, 0x04]);
    equal(completions.length, 1);
    equal(completions[0].filename, "TEST.H");
    equal(
      new TextDecoder().decode(completions[0].bytes),
      "0 BEGIN PGM TEST MM\r\n1 END PGM TEST MM\r\n"
    );
  });

  test("FE1 receiver maps incoming identifiers and preserves ACK-per-block flow", () => {
    equal(fromFe1DirectoryName("HCASEBOTT"), "CASEBOTT.H");
    equal(fromFe1DirectoryName("HCASETOPF"), "CASETOPF.H");
    const writes = [];
    const receiver = new Fe1Receiver({ onWrite: (bytes) => writes.push(bytes[0]) });
    const headerBase = new TextEncoder().encode("\x01HCASEBOTTA\x17");
    const header = new Uint8Array(headerBase.length + 1);
    header.set(headerBase);
    header[header.length - 1] = calculateBcc(headerBase);
    receiver.feed(header);
    receiver.feed(encodeDataBlock(new TextEncoder().encode("0 TEST")));
    bytesEqual([writes[0], writes[1]], [0x06, 0x06]);
  });

  test("Multiple coalesced FE1 directory requests receive one response each", () => {
    const responses = [];
    const responder = new Fe1DirectoryResponder({
      getFiles: () => sampleFiles,
      onResponse: (bytes) => responses.push(bytes)
    });
    const combined = new Uint8Array(DIRECTORY_REQUEST.length * 2);
    combined.set(DIRECTORY_REQUEST);
    combined.set(DIRECTORY_REQUEST, DIRECTORY_REQUEST.length);
    equal(responder.feed(combined), 2);
    equal(responses.length, 2);
  });

  test("Unrelated FE1 bytes do not trigger a directory response", () => {
    const responses = [];
    const responder = new Fe1DirectoryResponder({
      getFiles: () => sampleFiles,
      onResponse: (bytes) => responses.push(bytes)
    });
    equal(responder.feed(Uint8Array.from([0x01, 0x48, 0x11, 0x13, 0x06])), 0);
    equal(responses.length, 0);
    bytesEqual(responder.buffer, [0x01, 0x48, 0x11, 0x13, 0x06]);
  });
})(window);

