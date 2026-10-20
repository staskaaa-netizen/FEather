(function (global) {
  "use strict";

  const { test, equal, bytesEqual, includes, rejects, wait, waitUntil } = global.TNCWebTest;
  const {
    ByteStreamBuffer,
    WebSocketSerialTransport,
    buildWebSocketEndpoint,
    copyBytes
  } = global.TNCWeb;
  const { FakeWebSocket } = global.TNCWebTest;

  function makeTransport(options) {
    const settings = options || {};
    const sockets = [];
    const factory = (url, protocols) => {
      const socket = new FakeWebSocket(url);
      socket.protocols = protocols;
      sockets.push(socket);
      return socket;
    };
    const transport = new WebSocketSerialTransport(Object.assign({
      url: "ws://10.10.100.254:8000/",
      connectTimeoutMs: 100,
      webSocketFactory: factory
    }, settings));
    return { transport, sockets };
  }

  test("Endpoint builder produces a configurable W610 URL", () => {
    equal(
      buildWebSocketEndpoint("10.10.100.254", 8000, "/websocket"),
      "ws://10.10.100.254:8000/websocket"
    );
    equal(
      buildWebSocketEndpoint("2001:db8::1", 8000, "/"),
      "ws://[2001:db8::1]:8000/"
    );
  });

  test("WebSocket sends exact binary bytes for 0x00 through 0x7F", async () => {
    const { transport, sockets } = makeTransport();
    const opening = transport.connect();
    sockets[0].open();
    await opening;
    const bytes = Uint8Array.from({ length: 0x80 }, (_, index) => index);
    transport.write(bytes);
    equal(sockets[0].sent.length, 1);
    bytesEqual(sockets[0].sent[0], bytes);
    equal(transport.txBytes, 128);
  });

  test("ArrayBuffer receive fragments preserve every 7-bit byte", async () => {
    const { transport, sockets } = makeTransport();
    const opening = transport.connect();
    sockets[0].open();
    await opening;
    const fragments = [];
    transport.addEventListener("data", (event) => fragments.push(copyBytes(event.detail.bytes)));
    const bytes = Uint8Array.from({ length: 0x80 }, (_, index) => index);
    sockets[0].message(bytes.slice(0, 5).buffer);
    sockets[0].message(bytes.slice(5, 63).buffer);
    sockets[0].message(bytes.slice(63).buffer);
    equal(fragments.length, 3);
    bytesEqual([...fragments[0], ...fragments[1], ...fragments[2]], bytes);
  });

  test("Text frames preserve 0x00 through 0x7F when mapped as code points", async () => {
    const { transport, sockets } = makeTransport();
    const opening = transport.connect();
    sockets[0].open();
    await opening;
    let received;
    transport.addEventListener("data", (event) => {
      received = copyBytes(event.detail.bytes);
    });
    const text = String.fromCharCode(...Array.from({ length: 0x80 }, (_, index) => index));
    sockets[0].message(text);
    await waitUntil(() => Boolean(received), 1000, "text frame conversion");
    bytesEqual(received, Uint8Array.from({ length: 0x80 }, (_, index) => index));
  });

  test("Blob frames are consumed as byte-exact ArrayBuffers", async () => {
    const { transport, sockets } = makeTransport();
    const opening = transport.connect();
    sockets[0].open();
    await opening;
    let received;
    transport.addEventListener("data", (event) => {
      received = copyBytes(event.detail.bytes);
    });
    const expected = Uint8Array.from([0x00, 0x01, 0x02, 0x11, 0x13, 0x15, 0x17, 0x7f]);
    sockets[0].message(new Blob([expected]));
    await waitUntil(() => Boolean(received), 1000, "Blob conversion");
    bytesEqual(received, expected);
  });

  test("ByteStreamBuffer tolerates arbitrary fragmentation and coalesced messages", () => {
    const buffer = new ByteStreamBuffer({ maxBytes: 256 });
    const stream = Uint8Array.from([
      0x01, 0x41, 0x42, 0x17, 0x06, 0x11,
      0x01, 0x43, 0x44, 0x17, 0x06, 0x13, 0x11
    ]);
    buffer.append(stream.slice(0, 1));
    buffer.append(stream.slice(1, 7));
    buffer.append(stream.slice(7, 8));
    buffer.append(stream.slice(8));
    equal(buffer.length, stream.length);
    bytesEqual(buffer.peek(6), stream.slice(0, 6));
    bytesEqual(buffer.read(6), stream.slice(0, 6));
    bytesEqual(buffer.drain(), stream.slice(6));
  });

  test("Connection loss does not auto-reconnect or silently resume", async () => {
    const { transport, sockets } = makeTransport();
    const opening = transport.connect();
    sockets[0].open();
    await opening;
    transport.write([0x01, 0x41]);
    let closeDetail;
    transport.addEventListener("status", (event) => {
      if (event.detail.state === "closed") {
        closeDetail = event.detail;
      }
    });
    sockets[0].lose(1006, "network gone");
    equal(transport.state, "closed");
    equal(closeDetail.unexpected, true);
    await wait(30);
    equal(sockets.length, 1, "Transport must not create a replacement socket automatically");
    const secondOpening = transport.connect();
    equal(sockets.length, 2, "Explicit reconnect creates a new socket");
    equal(transport.txBytes, 0, "Per-connection counters reset");
    sockets[1].open();
    await secondOpening;
  });

  test("Manual disconnect is expected and does not reconnect", async () => {
    const { transport, sockets } = makeTransport();
    const opening = transport.connect();
    sockets[0].open();
    await opening;
    let closeDetail;
    transport.addEventListener("status", (event) => {
      if (event.detail.state === "closed") {
        closeDetail = event.detail;
      }
    });
    await transport.disconnect("operator test");
    equal(transport.state, "closed");
    equal(closeDetail.unexpected, false);
    equal(sockets[0].closeCalls[0].code, 1000);
    await wait(20);
    equal(sockets.length, 1);
  });

  test("Connection timeout is bounded and surfaced", async () => {
    const { transport } = makeTransport({ connectTimeoutMs: 20 });
    const error = await rejects(transport.connect(), "CONNECT_TIMEOUT");
    includes(error.message, "20 ms");
    equal(transport.state, "closed");
  });

  test("Invalid and non-WebSocket URLs are rejected before opening", async () => {
    await rejects(new WebSocketSerialTransport({ url: "not-a-url" }).connect(), "INVALID_URL");
    await rejects(new WebSocketSerialTransport({ url: "https://localhost/" }).connect(), "INVALID_URL");
  });

  test("Writes and manual sends fail when disconnected", () => {
    const { transport } = makeTransport();
    let rejected = false;
    try {
      transport.write([0x00]);
    } catch (error) {
      rejected = error.code === "NOT_CONNECTED";
    }
    equal(rejected, true);
  });
})(window);
