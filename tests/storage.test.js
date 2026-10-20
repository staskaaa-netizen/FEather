(function (global) {
  "use strict";

  const { test, equal, bytesEqual } = global.TNCWebTest;
  const { NcStorage } = global.TNCWeb;

  test("IndexedDB persists byte-exact files and avoids silent overwrite", async () => {
    const dbName = `tncweb-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const storage = new NcStorage({ dbName });
    const bytes = Uint8Array.from([0x00, 0x01, 0x03, 0x04, 0x06, 0x11, 0x13, 0x15, 0x7f]);
    const saved = await storage.save("TEST.H", bytes, { source: "test" });
    equal(saved.name, "TEST.H");
    const loaded = await storage.get("TEST.H");
    bytesEqual(new Uint8Array(loaded.bytes), bytes);
    const duplicate = await storage.saveReceived("TEST.H", [0x41], ["TEST.H"]);
    equal(duplicate.name, "TEST_1.H");

    storage.close();
    const reopened = new NcStorage({ dbName });
    const records = await reopened.list();
    equal(records.length, 2);
    bytesEqual(new Uint8Array(records.find((record) => record.name === "TEST.H").bytes), bytes);
    await reopened.clear();
    reopened.close();
    indexedDB.deleteDatabase(dbName);
  });
})(window);

