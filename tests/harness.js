(function (global) {
  "use strict";

  const tests = [];
  const state = {
    passed: 0,
    failed: 0,
    results: []
  };

  function test(name, fn) {
    tests.push({ name, fn });
  }

  function equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message || "Values differ"}: expected ${String(expected)}, received ${String(actual)}`);
    }
  }

  function bytesEqual(actual, expected, message) {
    const left = global.TNCWeb.copyBytes(actual);
    const right = global.TNCWeb.copyBytes(expected);
    if (left.byteLength !== right.byteLength || left.some((byte, index) => byte !== right[index])) {
      throw new Error(
        `${message || "Byte values differ"}\nexpected: ${global.TNCWeb.toHex(right)}\nreceived: ${global.TNCWeb.toHex(left)}`
      );
    }
  }

  function includes(text, expected, message) {
    if (!String(text).includes(expected)) {
      throw new Error(`${message || "Text is missing expected content"}: ${expected}`);
    }
  }

  async function rejects(promise, expectedCode, message) {
    try {
      await promise;
    } catch (error) {
      if (expectedCode && error.code !== expectedCode) {
        throw new Error(`${message || "Wrong rejection"}: expected code ${expectedCode}, received ${error.code}`);
      }
      return error;
    }
    throw new Error(message || "Expected operation to reject.");
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitUntil(predicate, timeoutMs, description) {
    const deadline = performance.now() + (timeoutMs || 1000);
    while (performance.now() < deadline) {
      if (predicate()) {
        return;
      }
      await wait(5);
    }
    throw new Error(`Timed out waiting for ${description || "condition"}.`);
  }

  function fixture(html) {
    const element = document.createElement("div");
    element.innerHTML = html || "";
    document.body.appendChild(element);
    return element;
  }

  async function run() {
    const started = performance.now();
    const output = document.getElementById("results");
    const lines = [];

    for (const entry of tests) {
      try {
        await entry.fn();
        state.passed += 1;
        state.results.push({ name: entry.name, status: "passed" });
        lines.push(`PASS ${entry.name}`);
      } catch (error) {
        state.failed += 1;
        state.results.push({
          name: entry.name,
          status: "failed",
          error: error.stack || error.message
        });
        lines.push(`FAIL ${entry.name}\n${error.stack || error.message}`);
      }
      if (output) {
        output.textContent = lines.join("\n");
      }
    }

    const summary = `${state.passed} passed, ${state.failed} failed (${Math.round(performance.now() - started)} ms)`;
    lines.push("", summary);
    if (output) {
      output.textContent = lines.join("\n");
    }
    document.body.dataset.testStatus = state.failed === 0 ? "passed" : "failed";
    global.__TNCWEB_TEST_RESULT__ = {
      summary,
      passed: state.passed,
      failed: state.failed,
      results: state.results
    };

    if (state.failed !== 0) {
      console.error(summary);
    } else {
      console.log(summary);
    }
    return global.__TNCWEB_TEST_RESULT__;
  }

  global.TNCWebTest = {
    bytesEqual,
    equal,
    fixture,
    includes,
    rejects,
    run,
    test,
    wait,
    waitUntil
  };
})(window);
