(function (global) {
  "use strict";

  const DEFAULT_HTTP_TIMEOUT_MS = 700;
  const DEFAULT_WEBSOCKET_TIMEOUT_MS = 900;
  const DEFAULT_CONCURRENCY = 20;

  function parseIpv4SubnetPrefix(value) {
    const text = String(value || "").trim().replace(/\.$/, "");
    const match = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) {
      throw new Error("Enter the first three IPv4 octets, for example 192.168.8.");
    }
    const octets = match.slice(1).map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) {
      throw new Error("Each IPv4 subnet octet must be from 0 to 255.");
    }
    return octets.join(".");
  }

  function ipv4PrefixFromHost(hostname) {
    const match = String(hostname || "").trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (!match) {
      return "";
    }
    try {
      return parseIpv4SubnetPrefix(match.slice(1).join("."));
    } catch (error) {
      return "";
    }
  }

  function buildProbeHosts(prefix, options) {
    const subnet = parseIpv4SubnetPrefix(prefix);
    const settings = options || {};
    const first = Number.isInteger(settings.first) ? settings.first : 1;
    const last = Number.isInteger(settings.last) ? settings.last : 254;
    if (first < 1 || last > 254 || first > last) {
      throw new RangeError("Discovery host range must be within 1 through 254.");
    }

    const hosts = [];
    const seen = new Set();
    const preferred = String(settings.preferredHost || "").trim();
    if (preferred.startsWith(`${subnet}.`)) {
      hosts.push(preferred);
      seen.add(preferred);
    }
    if (first <= 1 && last >= 1 && !seen.has(`${subnet}.1`)) {
      hosts.push(`${subnet}.1`);
      seen.add(`${subnet}.1`);
    }
    for (let index = first; index <= last; index += 1) {
      const host = `${subnet}.${index}`;
      if (!seen.has(host)) {
        hosts.push(host);
        seen.add(host);
      }
    }
    return hosts;
  }

  async function mapWithConcurrency(items, limit, mapper, onProgress) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;
    const workers = Array.from(
      { length: Math.min(Math.max(1, limit), items.length) },
      async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= items.length) {
            return;
          }
          try {
            results[index] = await mapper(items[index], index);
          } catch (error) {
            results[index] = { error };
          }
          completed += 1;
          if (typeof onProgress === "function") {
            onProgress(completed, items.length);
          }
        }
      }
    );
    await Promise.all(workers);
    return results;
  }

  async function probeHttp(host, options) {
    const settings = options || {};
    const fetchImpl = settings.fetchImpl || global.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("This browser does not support HTTP discovery.");
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      settings.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS
    );
    try {
      await fetchImpl(`http://${host}/`, {
        method: "GET",
        mode: "no-cors",
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        targetAddressSpace: "local",
        signal: controller.signal
      });
      return { host, reachable: true };
    } catch (error) {
      return {
        host,
        reachable: false,
        error: error && error.name === "AbortError" ? "timeout" : error.message
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function probeWebSocket(host, options) {
    const settings = options || {};
    const port = Number(settings.port || 8000);
    const path = String(settings.path || "/").trim() || "/";
    const url = `ws://${host}:${port}${path.startsWith("/") ? path : `/${path}`}`;
    const factory = settings.webSocketFactory || ((target) => new WebSocket(target));
    return new Promise((resolve) => {
      let socket;
      let settled = false;
      let timer = null;
      const finish = (open) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (socket) {
          try {
            socket.close(1000, "W610 discovery probe");
          } catch (error) {
            // A failed probe has no usable socket to close.
          }
        }
        resolve({ host, url, open });
      };
      timer = setTimeout(() => finish(false), settings.timeoutMs || DEFAULT_WEBSOCKET_TIMEOUT_MS);
      try {
        socket = factory(url);
      } catch (error) {
        finish(false);
        return;
      }
      socket.addEventListener("open", () => finish(true));
      socket.addEventListener("error", () => finish(false));
      socket.addEventListener("close", () => finish(false));
    });
  }

  async function discoverW610(options) {
    const settings = options || {};
    const prefix = parseIpv4SubnetPrefix(settings.subnet);
    const hosts = buildProbeHosts(prefix, settings);
    const fetchImpl = settings.fetchImpl || global.fetch;
    const timeoutMs = settings.httpTimeoutMs || DEFAULT_HTTP_TIMEOUT_MS;
    const concurrency = settings.concurrency || DEFAULT_CONCURRENCY;

    if (settings.warmPermission !== false && hosts.length > 0) {
      await probeHttp(hosts[0], {
        fetchImpl,
        timeoutMs: settings.permissionTimeoutMs || 10000
      });
    }

    const httpResults = await mapWithConcurrency(
      hosts,
      concurrency,
      (host) => probeHttp(host, { fetchImpl, timeoutMs }),
      settings.onHttpProgress
    );
    const httpHosts = httpResults.filter((result) => result && result.reachable).map((result) => result.host);

    const socketResults = await mapWithConcurrency(
      httpHosts,
      Math.min(4, concurrency),
      (host) => probeWebSocket(host, settings),
      settings.onWebSocketProgress
    );
    const devices = socketResults.filter((result) => result && result.open);
    return {
      subnet: prefix,
      testedHosts: hosts.length,
      httpHosts,
      devices,
      socketsChecked: httpHosts.length
    };
  }

  global.TNCWeb = global.TNCWeb || {};
  Object.assign(global.TNCWeb, {
    buildProbeHosts,
    discoverW610,
    ipv4PrefixFromHost,
    parseIpv4SubnetPrefix,
    probeHttp,
    probeWebSocket
  });
})(window);
