/** Bounded ZIP processing for browser downloads and portable case packages. */
(function () {
  const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
  function createWriter() {
    let parts = [];
    let failure = null;
    let finished = false;
    const zip = new globalThis.fflate.Zip((error, bytes, final) => {
      if (error) { failure = error; return; }
      // Blob parts release the large JS byte buffers between entries.
      if (bytes.length) parts.push(new Blob([bytes]));
      if (final) finished = true;
    });
    async function add(name, data, compress = false) {
      if (failure) throw failure;
      const entry = compress ? new globalThis.fflate.ZipDeflate(name, { level: 6 })
        : new globalThis.fflate.ZipPassThrough(name);
      zip.add(entry);
      const blob = data instanceof Blob ? data : new Blob([data]);
      const size = blob.size;
      for (let offset = 0; offset < size; offset += 65536) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + 65536).arrayBuffer());
        entry.push(bytes, offset + bytes.length === size);
        if (failure) throw failure;
        await yieldUI();
      }
      if (!size) entry.push(new Uint8Array(0), true);
    }
    function finish() {
      zip.end();
      if (failure) throw failure;
      if (!finished) throw new Error("ZIP did not finish");
      const blob = new Blob(parts, { type: "application/zip" });
      parts = [];
      return blob;
    }
    function abort() { zip.terminate(); parts = []; }
    return { add, finish, abort };
  }

  async function readEntries(source, { keep, onEntry, maxEntries, maxBytes, maxEntryBytes }) {
    // Files/Blobs support slice, so production never reads the whole archive.
    const file = source.slice ? source : new Blob([await source.arrayBuffer()]);
    let count = 0, total = 0, declared = 0, active = 0;
    let writes = [];
    const names = new Set();
    const streams = new Set();
    const unzip = new globalThis.fflate.Unzip(entry => {
      if (++count > maxEntries || names.has(entry.name)) throw new Error("Invalid or oversized ZIP entries");
      names.add(entry.name);
      declared += entry.originalSize || 0;
      const retained = keep(entry.name);
      if (declared > maxBytes || (retained && entry.originalSize > maxEntryBytes)) throw new Error("ZIP entry too large");
      let chunks = [], length = 0;
      active++;
      streams.add(entry);
      entry.ondata = (error, bytes, final) => {
        if (error) throw error;
        length += bytes.length;
        total += bytes.length;
        if (total > maxBytes || (retained && length > maxEntryBytes)) throw new Error("ZIP entry too large");
        if (retained && bytes.length) chunks.push(bytes);
        if (final) {
          active--;
          streams.delete(entry);
          if (retained) {
            const blob = new Blob(chunks);
            writes.push(Promise.resolve(onEntry(entry.name, blob)));
          }
          chunks = [];
        }
      };
      // Even skipped entries are drained, so fflate cannot buffer them forever.
      entry.start();
    });
    unzip.register(globalThis.fflate.UnzipInflate);
    try {
      // Small input chunks also bound expansion work before each size check.
      for (let offset = 0; offset < file.size; offset += 16384) {
        const bytes = new Uint8Array(await file.slice(offset, offset + 16384).arrayBuffer());
        unzip.push(bytes, offset + bytes.length === file.size);
        const batch = writes;
        writes = [];
        // Publication completes before feeding more compressed input.
        const results = await Promise.allSettled(batch);
        const failed = results.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
        await yieldUI();
      }
      if (active || !count) throw new Error("Incomplete ZIP archive");
    } finally {
      for (const stream of streams) stream.terminate();
      await Promise.allSettled(writes);
    }
  }
  globalThis.RecorderArchiveStream = { createWriter, readEntries };
})();
