(function (global) {
  "use strict";

  const { test, equal, bytesEqual, includes } = global.TNCWebTest;
  const {
    DIRECTORY_REQUEST,
    Fe1DirectoryResponder,
    buildDirectoryResponse
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

