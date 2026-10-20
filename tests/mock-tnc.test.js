(function (global) {
  "use strict";

  const { test, bytesEqual, equal, waitUntil } = global.TNCWebTest;
  const { MockSerialTransport, copyBytes } = global.TNCWeb;
  const { ScriptedMockW610 } = global.TNCWebTest;

  test("Scripted mock W610 returns fragmented responses byte-exactly", async () => {
    const transport = new MockSerialTransport();
    const mock = new ScriptedMockW610(transport);
    await transport.connect();

    const request = Uint8Array.from([0x01, 0x52, 0x45, 0x51, 0x17, 0x11]);
    mock.expect(request, [
      Uint8Array.from([0x00, 0x06]),
      Uint8Array.from([0x11, 0x13, 0x15, 0x17, 0x06])
    ]);

    const received = [];
    transport.addEventListener("data", (event) => {
      received.push(copyBytes(event.detail.bytes));
    });
    transport.write(request);
    await waitUntil(() => received.length === 2, 1000, "two mock response fragments");

    bytesEqual(received[0], [0x00, 0x06]);
    bytesEqual(received[1], [0x11, 0x13, 0x15, 0x17, 0x06]);
    bytesEqual(transport.transmitted[0], request);
    equal(mock.unmatched.length, 0);
  });

  test("Mock serial transport reports unexpected disconnect as loss", async () => {
    const transport = new MockSerialTransport();
    await transport.connect();
    let stateDetails;
    transport.addEventListener("status", (event) => {
      if (event.detail.state === "closed") {
        stateDetails = event.detail;
      }
    });
    transport.lose("simulated cable removal");
    equal(transport.state, "closed");
    equal(stateDetails.unexpected, true);
    equal(stateDetails.reason, "simulated cable removal");
  });
})(window);
