(function (global) {
  "use strict";

  const TNCWeb = global.TNCWeb = global.TNCWeb || {};

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction aborted.")));
      transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB transaction failed.")));
    });
  }

  function validateFilename(name) {
    if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      throw new TypeError("Filename contains unsupported characters.");
    }
    return name;
  }

  function duplicateName(name, usedNames) {
    if (!usedNames.has(name.toLowerCase())) {
      return name;
    }
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let index = 1;
    let candidate;
    do {
      candidate = `${base}_${index}${extension}`;
      index += 1;
    } while (usedNames.has(candidate.toLowerCase()));
    return candidate;
  }

  class NcStorage extends EventTarget {
    constructor(options) {
      super();
      const settings = options || {};
      this.dbName = settings.dbName || "tncweb";
      this.storeName = settings.storeName || "ncFiles";
      this.version = settings.version || 1;
      this.db = null;
      this.openPromise = null;
    }

    open() {
      if (this.db) {
        return Promise.resolve(this.db);
      }
      if (this.openPromise) {
        return this.openPromise;
      }
      this.openPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.version);
        request.addEventListener("upgradeneeded", () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: "name" });
          }
        });
        request.addEventListener("success", () => {
          this.db = request.result;
          resolve(this.db);
        });
        request.addEventListener("error", () => reject(request.error));
      });
      return this.openPromise;
    }

    async list() {
      const db = await this.open();
      const transaction = db.transaction(this.storeName, "readonly");
      const done = transactionDone(transaction);
      const records = await requestResult(transaction.objectStore(this.storeName).getAll());
      await done;
      return records.sort((left, right) => left.name.localeCompare(right.name, "en"));
    }

    async get(name) {
      const db = await this.open();
      const transaction = db.transaction(this.storeName, "readonly");
      const done = transactionDone(transaction);
      const record = await requestResult(transaction.objectStore(this.storeName).get(validateFilename(name)));
      await done;
      return record || null;
    }

    async save(name, value, metadata) {
      const db = await this.open();
      const bytes = TNCWeb.copyBytes(value);
      const record = Object.assign({}, metadata || {}, {
        name: validateFilename(name),
        size: bytes.byteLength,
        updatedAt: new Date().toISOString(),
        bytes: bytes.slice().buffer
      });
      const transaction = db.transaction(this.storeName, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(this.storeName).put(record);
      await done;
      this.dispatchEvent(new CustomEvent("change", { detail: record }));
      return record;
    }

    async saveReceived(name, value, reservedNames) {
      const records = await this.list();
      const used = new Set(records.map((record) => record.name.toLowerCase()));
      for (const reserved of reservedNames || []) {
        used.add(String(reserved).toLowerCase());
      }
      return this.save(duplicateName(validateFilename(name), used), value, {
        source: "tnc"
      });
    }

    async remove(name) {
      const db = await this.open();
      const transaction = db.transaction(this.storeName, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(this.storeName).delete(validateFilename(name));
      await done;
      this.dispatchEvent(new CustomEvent("change", { detail: { name } }));
    }

    async clear() {
      const db = await this.open();
      const transaction = db.transaction(this.storeName, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(this.storeName).clear();
      await done;
      this.dispatchEvent(new CustomEvent("change", {}));
    }

    close() {
      if (this.db) {
        this.db.close();
        this.db = null;
        this.openPromise = null;
      }
    }
  }

  Object.assign(TNCWeb, {
    NcStorage,
    duplicateName
  });
})(window);
