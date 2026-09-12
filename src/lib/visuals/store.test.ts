// `pngDimensions` is the only place the stage looks at the bytes it is about to store, so it is
// also the only thing standing between "Slides handed back an image" and "Slides handed back an
// error page with a 200 on it". S-05's lesson applies directly: a heuristic feeding a gate is a
// correctness surface in its own right, and it needs testing in the direction of what it should
// REJECT, not only what it should accept.
import { describe, expect, it } from "vitest";

import { assetPath, pngDimensions } from "@/lib/visuals/store";

/** A PNG header: 8 signature bytes, then the IHDR chunk carrying width and height. */
function pngHeader(width: number, height: number, trailing = 0): Uint8Array {
  const bytes = new Uint8Array(24 + trailing);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe("pngDimensions", () => {
  it("reads the dimensions Slides exports at LARGE", () => {
    expect(pngDimensions(pngHeader(1600, 1600))).toEqual({ width: 1600, height: 1600 });
  });

  it("reads a non-square image too, rather than assuming the template is square", () => {
    expect(pngDimensions(pngHeader(1600, 900))).toEqual({ width: 1600, height: 900 });
  });

  it("ignores everything after the header", () => {
    expect(pngDimensions(pngHeader(1080, 1080, 4096))).toEqual({ width: 1080, height: 1080 });
  });

  it("reads correctly when the bytes are a view into a larger buffer", () => {
    // Uint8Array from an arrayBuffer slice can carry a non-zero byteOffset; a DataView built
    // without honouring it would read someone else's bytes as the width.
    const backing = new Uint8Array(64);
    backing.set(pngHeader(800, 800), 40);
    expect(pngDimensions(backing.subarray(40))).toEqual({ width: 800, height: 800 });
  });

  it("rejects an HTML error page served with a 200", () => {
    expect(pngDimensions(new TextEncoder().encode("<!doctype html><title>Error</title>"))).toBeNull();
  });

  it("rejects a JPEG, which has its own magic number", () => {
    const jpeg = new Uint8Array(32);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
    expect(pngDimensions(jpeg)).toBeNull();
  });

  it("rejects a truncated download", () => {
    expect(pngDimensions(pngHeader(1600, 1600).subarray(0, 20))).toBeNull();
  });

  it("rejects empty bytes", () => {
    expect(pngDimensions(new Uint8Array(0))).toBeNull();
  });

  it("rejects a zero dimension, which is a corrupt header rather than an image", () => {
    expect(pngDimensions(pngHeader(0, 1600))).toBeNull();
    expect(pngDimensions(pngHeader(1600, 0))).toBeNull();
  });
});

describe("assetPath", () => {
  it("addresses a slide by digest and index, so a re-run overwrites rather than orphans", () => {
    expect(assetPath("d4c1a2b3", 0)).toBe("d4c1a2b3/0.png");
    expect(assetPath("d4c1a2b3", 12)).toBe("d4c1a2b3/12.png");
  });
});
