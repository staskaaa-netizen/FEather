(function (global) {
  "use strict";

  window.addEventListener("error", (event) => {
    const output = document.getElementById("results");
    if (output) {
      output.textContent += `\nUNCAUGHT ${event.message}`;
    }
  });

  global.TNCWebTest.run();
})(window);
