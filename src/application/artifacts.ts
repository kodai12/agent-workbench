import { relative } from "node:path";
import type {
  ArtifactStore,
  ArtifactRef,
  Digest,
} from "../../contracts/ports.js";
import type { Store } from "../adapters/sqlite/store.js";
import {
  createArtifactStore,
  artifactPath,
} from "../adapters/filesystem/artifacts.js";
export function registeredArtifacts(store: Store): ArtifactStore {
  const underlying = createArtifactStore(store.home);
  return {
    async put(bytes, mediaType, maximumBytes) {
      const result = await underlying.put(bytes, mediaType, maximumBytes);
      if (result.ok) {
        const ref = result.value;
        store.db
          .prepare(
            "INSERT INTO artifacts(digest,relative_path,media_type,size_bytes,classification,created_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(digest) DO NOTHING",
          )
          .run(
            ref.digest,
            relative(store.home, artifactPath(store.home, ref.digest)),
            ref.mediaType,
            ref.sizeBytes,
            "internal",
            Date.now(),
          );
      }
      return result;
    },
    readVerified: (digest: Digest) => underlying.readVerified(digest),
  };
}
