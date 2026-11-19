import { DshHostAdapter } from "file:///D:/Purge+/src/adapters/dsh.ts";

const adapter = new DshHostAdapter();
const candidates = await adapter.discover();
console.log("candidates:", candidates.length);
for (const c of candidates) {
  const facts = await adapter.inspect(c);
  console.log(JSON.stringify({
    id: c.id,
    root: c.root,
    identity: { product: facts.identity.product, version: facts.identity.version, confidence: facts.identity.confidence },
    shape: facts.shape,
    loadedShape: facts.loadedShape,
    archive: { exists: facts.archive.exists, size: facts.archive.size, readable: facts.archive.readable },
    unpacked: { exists: facts.unpacked.exists, entries: facts.unpacked.entries.length },
    runtime: facts.runtime,
    profiles: facts.profiles.map((p) => ({ name: p.name, deps: Object.keys(p.dependencies), bundles: p.bundles })),
    process: facts.process,
    modification: { looksModified: facts.modification.looksModified, packs: facts.modification.packs, markerHits: facts.modification.markerHits.length, sample: facts.modification.markerHits.slice(0, 3) },
  }, null, 2));
}
