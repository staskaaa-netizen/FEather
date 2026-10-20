(function (global) {
  "use strict";

  const { test, equal, includes } = global.TNCWebTest;

  test("Bundled NC catalog preserves all eight sample sizes", () => {
    const files = global.TNCWeb.NC_FILES;
    equal(files.length, 8);
    for (const file of files) {
      const binary = atob(file.base64);
      equal(binary.length, file.size, `${file.name} size`);
      includes(binary, "\r\n", `${file.name} CRLF`);
    }
  });
})(window);

