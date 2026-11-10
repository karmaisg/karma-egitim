// Cloudflare R2 arayüzünü bellekte taklit eder (yalnızca yerel testler için).
export function createR2() {
  const objects = new Map();   // key -> { bytes: Uint8Array, contentType }
  const uploads = new Map();   // uploadId -> { key, contentType, parts: Map<n, Uint8Array> }
  let counter = 0;

  const handle = (key, uploadId) => ({
    uploadId, key,
    async uploadPart(n, data) {
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw new Error('NoSuchUpload');
      const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : await new Response(data).arrayBuffer());
      u.parts.set(n, bytes);
      return { partNumber: n, etag: `etag-${n}-${bytes.length}` };
    },
    async complete(parts) {
      const u = uploads.get(uploadId);
      if (!u) throw new Error('NoSuchUpload');
      const chunks = parts.map((p) => {
        const b = u.parts.get(p.partNumber);
        if (!b || p.etag !== `etag-${p.partNumber}-${b.length}`) throw new Error('InvalidPart');
        return b;
      });
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.length; }
      objects.set(key, { bytes, contentType: u.contentType });
      uploads.delete(uploadId);
      return { key, size: total };
    },
    async abort() { uploads.delete(uploadId); },
  });

  return {
    _objects: objects,
    async createMultipartUpload(key, opts = {}) {
      const uploadId = 'up-' + (++counter);
      uploads.set(uploadId, { key, contentType: opts.httpMetadata?.contentType, parts: new Map() });
      return handle(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) { return handle(key, uploadId); },
    async get(key, opts = {}) {
      const o = objects.get(key);
      if (!o) return null;
      let bytes = o.bytes;
      if (opts.range) bytes = bytes.slice(opts.range.offset, opts.range.offset + opts.range.length);
      return { key, size: o.bytes.length, body: new Blob([bytes]).stream() };
    },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
  };
}
