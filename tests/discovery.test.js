(function (global) {
  "use strict";

  const { test, equal, includes, rejects } = global.TNCWebTest;
  const {
    buildProbeHosts,
    discoverW610,
    ipv4PrefixFromHost,
    parseIpv4SubnetPrefix
  } = global.TNCWeb;

  test("W610 discovery parses and derives IPv4 subnet prefixes", () => {
    equal(parseIpv4SubnetPrefix("192.168.8."), "192.168.8");
    equal(ipv4PrefixFromHost("192.168.8.187"), "192.168.8");
    equal(ipv4PrefixFromHost("w610.local"), "");
  });

  test("W610 discovery prioritizes the current host and gateway", () => {
    const hosts = buildProbeHosts("192.168.8", {
      preferredHost: "192.168.8.187",
      first: 1,
      last: 4
    });
    equal(hosts[0], "192.168.8.187");
    equal(hosts[1], "192.168.8.1");
    equal(hosts.includes("192.168.8.3"), true);
  });

  test("W610 discovery rejects invalid subnet syntax", async () => {
    await rejects(Promise.resolve().then(() => parseIpv4SubnetPrefix("192.168.999")));
  });

  test("W610 discovery checks HTTP responders for the configured WebSocket", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("192.168.8.2/") || url.includes("192.168.8.4/")) {
        return { type: "opaque" };
      }
      throw new TypeError("Failed to fetch");
    };
    const webSocketFactory = (url) => {
      const socket = new EventTarget();
      socket.close = () => {};
      setTimeout(() => {
        if (url.includes("192.168.8.4:8000")) {
          socket.dispatchEvent(new Event("open"));
        } else {
          socket.dispatchEvent(new Event("error"));
        }
      }, 0);
      return socket;
    };

    const result = await discoverW610({
      subnet: "192.168.8",
      first: 1,
      last: 4,
      warmPermission: false,
      fetchImpl,
      webSocketFactory,
      httpTimeoutMs: 30,
      timeoutMs: 30,
      concurrency: 2
    });

    equal(result.testedHosts, 4);
    equal(result.httpHosts.length, 2);
    equal(result.devices.length, 1);
    equal(result.devices[0].host, "192.168.8.4");
    includes(result.devices[0].url, "ws://192.168.8.4:8000/");
  });
})(window);
