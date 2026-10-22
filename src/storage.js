(function (global) {
  "use strict";

  const TNCWeb = global.TNCWeb = global.TNCWeb || {};
  const DEFAULT_LIBRARY_ID = "default";
  const LIBRARIES_META_KEY = "libraries-v1";
  const ACTIVE_LIBRARY_META_KEY = "active-library-v1";

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

  function validateLibraryName(name) {
    const normalized = String(name || "").trim().replace(/\s+/g, " ");
    if (normalized.length < 1 || normalized.length > 32 || !/^[A-Za-z0-9 _.-]+$/.test(normalized)) {
      throw new TypeError("Library names must be 1-32 letters, numbers, spaces, dots, dashes, or underscores.");
    }
    return normalized;
  }

  function makeLibraryId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return `library-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      this.version = settings.version || 2;
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
          if (!db.objectStoreNames.contains("meta")) {
            db.createObjectStore("meta", { keyPath: "key" });
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

    async getMeta(key) {
      const db = await this.open();
      const transaction = db.transaction("meta", "readonly");
      const done = transactionDone(transaction);
      const record = await requestResult(transaction.objectStore("meta").get(key));
      await done;
      return record ? record.value : null;
    }

    async setMeta(key, value) {
      const db = await this.open();
      const transaction = db.transaction("meta", "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore("meta").put({ key, value });
      await done;
    }

    async list(libraryId) {
      const db = await this.open();
      const transaction = db.transaction(this.storeName, "readonly");
      const done = transactionDone(transaction);
      const records = await requestResult(transaction.objectStore(this.storeName).getAll());
      await done;
      const filtered = libraryId
        ? records.filter((record) => record.libraryId === libraryId)
        : records;
      return filtered.sort((left, right) => left.name.localeCompare(right.name, "en"));
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

    async saveUnique(name, value, reservedNames, source, libraryId) {
      const records = await this.list();
      const used = new Set(records.map((record) => record.name.toLowerCase()));
      for (const reserved of reservedNames || []) {
        used.add(String(reserved).toLowerCase());
      }
      return this.save(duplicateName(validateFilename(name), used), value, {
        source: source || "import",
        libraryId: libraryId || DEFAULT_LIBRARY_ID
      });
    }

    async saveReceived(name, value, reservedNames, libraryId) {
      return this.saveUnique(name, value, reservedNames, "tnc", libraryId);
    }

    async saveImported(name, value, reservedNames, libraryId) {
      return this.saveUnique(name, value, reservedNames, "import", libraryId);
    }

    async moveToLibrary(name, targetLibraryId) {
      const state = await this.initializeLibraries();
      if (!state.libraries.some((library) => library.id === targetLibraryId)) {
        throw new Error("Destination library not found.");
      }
      const record = await this.get(name);
      if (!record) {
        throw new Error(`File not found: ${name}`);
      }
      if (record.libraryId === targetLibraryId) {
        return record;
      }
      const targetRecords = await this.list(targetLibraryId);
      if (targetRecords.some((item) => item.name.toLowerCase() === record.name.toLowerCase())) {
        throw new Error(`The destination library already contains ${record.name}.`);
      }
      const updated = Object.assign({}, record, {
        libraryId: targetLibraryId,
        updatedAt: new Date().toISOString()
      });
      const db = await this.open();
      const transaction = db.transaction(this.storeName, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(this.storeName).put(updated);
      await done;
      this.dispatchEvent(new CustomEvent("change", { detail: updated }));
      return updated;
    }

    async initialize(seedFiles, seedKey) {
      const db = await this.open();
      const marker = seedKey || "seed-v1";
      const markerTransaction = db.transaction("meta", "readonly");
      const markerDone = transactionDone(markerTransaction);
      const existingMarker = await requestResult(markerTransaction.objectStore("meta").get(marker));
      await markerDone;
      if (existingMarker) {
        return false;
      }
      for (const file of seedFiles || []) {
        const bytes = TNCWeb.copyBytes(file.bytes);
        const existing = await this.get(file.name);
        if (!existing) {
          await this.save(file.name, bytes, {
            source: "bundled",
            libraryId: file.libraryId || DEFAULT_LIBRARY_ID
          });
        }
      }
      const markerWrite = db.transaction("meta", "readwrite");
      const markerWriteDone = transactionDone(markerWrite);
      markerWrite.objectStore("meta").put({ key: marker, initializedAt: new Date().toISOString() });
      await markerWriteDone;
      this.dispatchEvent(new CustomEvent("change", {}));
      return true;
    }

    async initializeLibraries() {
      const db = await this.open();
      let libraries = await this.getMeta(LIBRARIES_META_KEY);
      if (!Array.isArray(libraries) || libraries.length === 0) {
        libraries = [{
          id: DEFAULT_LIBRARY_ID,
          name: "Library 1",
          createdAt: new Date().toISOString()
        }];
      }
      libraries = libraries.filter((library) => library && library.id && library.name);
      if (!libraries.some((library) => library.id === DEFAULT_LIBRARY_ID)) {
        libraries.unshift({
          id: DEFAULT_LIBRARY_ID,
          name: "Library 1",
          createdAt: new Date().toISOString()
        });
      }

      let activeLibraryId = await this.getMeta(ACTIVE_LIBRARY_META_KEY);
      if (!libraries.some((library) => library.id === activeLibraryId)) {
        activeLibraryId = libraries[0].id;
      }

      const transaction = db.transaction([this.storeName, "meta"], "readwrite");
      const done = transactionDone(transaction);
      const fileStore = transaction.objectStore(this.storeName);
      const metaStore = transaction.objectStore("meta");
      const allRequest = fileStore.getAll();
      allRequest.addEventListener("success", () => {
        let migrated = 0;
        for (const record of allRequest.result) {
          if (!record.libraryId) {
            fileStore.put(Object.assign({}, record, { libraryId: DEFAULT_LIBRARY_ID }));
            migrated += 1;
          }
        }
        metaStore.put({ key: LIBRARIES_META_KEY, value: libraries });
        metaStore.put({ key: ACTIVE_LIBRARY_META_KEY, value: activeLibraryId });
        this.lastLibraryMigrationCount = migrated;
      });
      await done;
      return { libraries, activeLibraryId };
    }

    async createLibrary(name) {
      const state = await this.initializeLibraries();
      const libraryName = validateLibraryName(name);
      if (state.libraries.some((library) => library.name.toLowerCase() === libraryName.toLowerCase())) {
        throw new Error(`A library named "${libraryName}" already exists.`);
      }
      const library = {
        id: makeLibraryId(),
        name: libraryName,
        createdAt: new Date().toISOString()
      };
      const libraries = state.libraries.concat(library);
      await this.setMeta(LIBRARIES_META_KEY, libraries);
      this.dispatchEvent(new CustomEvent("librarieschange", { detail: { libraries } }));
      return { library, libraries };
    }

    async renameLibrary(id, name) {
      const state = await this.initializeLibraries();
      const libraryName = validateLibraryName(name);
      const current = state.libraries.find((library) => library.id === id);
      if (!current) {
        throw new Error("Library not found.");
      }
      if (state.libraries.some(
        (library) => library.id !== id && library.name.toLowerCase() === libraryName.toLowerCase()
      )) {
        throw new Error(`A library named "${libraryName}" already exists.`);
      }
      const libraries = state.libraries.map((library) => (
        library.id === id ? Object.assign({}, library, { name: libraryName }) : library
      ));
      await this.setMeta(LIBRARIES_META_KEY, libraries);
      this.dispatchEvent(new CustomEvent("librarieschange", { detail: { libraries } }));
      return libraries;
    }

    async deleteLibrary(id) {
      const state = await this.initializeLibraries();
      if (id === DEFAULT_LIBRARY_ID) {
        throw new Error("The default library cannot be deleted.");
      }
      if (!state.libraries.some((library) => library.id === id)) {
        throw new Error("Library not found.");
      }
      const libraries = state.libraries.filter((library) => library.id !== id);
      const activeLibraryId = state.activeLibraryId === id ? DEFAULT_LIBRARY_ID : state.activeLibraryId;
      const db = await this.open();
      const transaction = db.transaction([this.storeName, "meta"], "readwrite");
      const done = transactionDone(transaction);
      const fileStore = transaction.objectStore(this.storeName);
      const metaStore = transaction.objectStore("meta");
      const allRequest = fileStore.getAll();
      allRequest.addEventListener("success", () => {
        for (const record of allRequest.result) {
          if (record.libraryId === id) {
            fileStore.put(Object.assign({}, record, { libraryId: DEFAULT_LIBRARY_ID }));
          }
        }
        metaStore.put({ key: LIBRARIES_META_KEY, value: libraries });
        metaStore.put({ key: ACTIVE_LIBRARY_META_KEY, value: activeLibraryId });
      });
      await done;
      this.dispatchEvent(new CustomEvent("librarieschange", { detail: { libraries } }));
      return { libraries, activeLibraryId };
    }

    async setActiveLibrary(id) {
      const state = await this.initializeLibraries();
      if (!state.libraries.some((library) => library.id === id)) {
        throw new Error("Library not found.");
      }
      await this.setMeta(ACTIVE_LIBRARY_META_KEY, id);
      this.dispatchEvent(new CustomEvent("librarychange", { detail: { id } }));
      return id;
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
    DEFAULT_LIBRARY_ID,
    NcStorage,
    duplicateName,
    validateLibraryName
  });
})(window);
