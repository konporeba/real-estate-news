// WORKER-SIDE. Durable re-hosting for the images Slides exports.
//
// WHY THIS EXISTS. `pages.getThumbnail` answers with a URL that lives 30 minutes. Persisting that
// URL would produce an archive (FR-024) that reads fine on Tuesday and is a wall of broken images
// by Wednesday, so the bytes are pulled down inside the transport and re-hosted here, in a private
// bucket the operator's dashboard signs URLs against.
//
// Takes its Supabase client as a parameter rather than building one, the same rule every shared
// module in src/lib/digest/ follows — that is what lets one implementation serve the worker and,
// later, the app.
import type { ServiceClient } from "@/lib/supabase-service";

/** A storage failure is never a state-machine failure, so it gets its own minimal result shape. */
export interface StoreFailure {
  ok: false;
  message: string;
}

export type StoreResult<T> = { ok: true; data: T } | StoreFailure;

/** The narrow slice of Supabase Storage the render stage needs, injectable for tests. */
export interface AssetStore {
  /** Bucket name, carried so callers can put it in a diagnostic without reaching for env. */
  readonly bucket: string;
  upload(path: string, bytes: Uint8Array): Promise<StoreResult<void>>;
}

/**
 * Where one slide's PNG lives.
 *
 * Deterministic rather than random: a re-run overwrites the previous run's image at the same key,
 * so a retried digest cannot leave a half-set of orphaned objects behind that nothing references
 * and nobody will ever notice paying for.
 */
export function assetPath(digestId: string, slideIndex: number): string {
  return `${digestId}/${String(slideIndex)}.png`;
}

/**
 * Upload one PNG.
 *
 * `upsert` is on for the reason above — a retry must overwrite rather than collide with its own
 * previous attempt. `contentType` is set explicitly because the bytes arrive as a raw array with
 * no filename for Storage to sniff, and a wrong type would make the dashboard offer the card as a
 * download instead of rendering it.
 */
export async function uploadAsset(
  client: ServiceClient,
  bucket: string,
  path: string,
  bytes: Uint8Array,
): Promise<StoreResult<void>> {
  const { error } = await client.storage.from(bucket).upload(path, bytes, {
    contentType: "image/png",
    upsert: true,
  });
  if (error) return { ok: false, message: `storage upload to ${bucket}/${path} failed: ${error.message}` };
  return { ok: true, data: undefined };
}

export function createAssetStore(client: ServiceClient, bucket: string): AssetStore {
  return {
    bucket,
    upload: (path, bytes) => uploadAsset(client, bucket, path, bytes),
  };
}

/** PNG magic number. Present on every PNG and on nothing else. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Read a PNG's pixel dimensions out of its IHDR chunk, which is always the first chunk and always
 * at a fixed offset.
 *
 * Twelve lines instead of an image library, because this is all `generated_asset.width/height`
 * needs and S-06 explicitly adds no image dependency. Returns null rather than throwing on
 * anything that is not a PNG — which doubles as a cheap check that the transport handed back an
 * image at all, rather than, say, an error page with a 200 on it.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // 8 signature bytes + 8 chunk header + 8 dimension bytes.
  if (bytes.length < 24) return null;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
