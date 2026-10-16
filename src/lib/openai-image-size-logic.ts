// Which size to ask an OpenAI-compatible images API for. Neither /v1/models
// nor the model catalog says which sizes a model takes, but a refused size
// does: OpenAI answers "Invalid size '640x480'. Supported sizes are
// 1024x1024, 1024x1536, 1536x1024, and auto." (recorded 2026-10-13). The
// list is read from that answer and a size picked from it for the shape the
// table wants. Pure, so scripts/test-openai-images.mjs pins every rule.

export type ImageShape = "square" | "portrait" | "landscape";
export type ImageSize = { size: string; width: number; height: number };

// What every model is asked for first.
export const FIRST_SIZES: Record<ImageShape, ImageSize> = {
  square: { size: "1024x1024", width: 1024, height: 1024 },
  portrait: { size: "1024x1536", width: 1024, height: 1536 },
  landscape: { size: "1536x1024", width: 1536, height: 1024 },
};

// The sizes a refusal lists, or null when it lists none ("auto" is not a
// size a picture can be laid out with, so it is left out).
export function readSupportedSizes(message: string): ImageSize[] | null {
  const listed = /supported sizes?\s*(?:are|:)?\s*([^]*)/i.exec(message)?.[1] ?? "";
  const sizes = [...listed.matchAll(/(\d{2,5})\s*x\s*(\d{2,5})/gi)].map(([, w, h]) => ({ size: `${w}x${h}`, width: Number(w), height: Number(h) }));
  return sizes.length ? sizes : null;
}

function shapeOf(size: ImageSize): ImageShape {
  return size.width === size.height ? "square" : size.width < size.height ? "portrait" : "landscape";
}

// The listed size for a shape: the same orientation first, then the nearest
// width-to-height ratio to the one asked for first (on a log scale, so 2:3
// and 3:2 are equally far from square), then the larger area. A shape the
// list has none of takes a square; null when there is no square either.
export function pickImageSize(shape: ImageShape, sizes: readonly ImageSize[]): ImageSize | null {
  const target = FIRST_SIZES[shape].width / FIRST_SIZES[shape].height;
  const distance = (size: ImageSize) => Math.abs(Math.log(size.width / size.height / target));
  const best = (candidates: readonly ImageSize[]) =>
    [...candidates].sort((a, b) => distance(a) - distance(b) || b.width * b.height - a.width * a.height)[0] ?? null;
  return best(sizes.filter((size) => shapeOf(size) === shape)) ?? (shape === "square" ? null : best(sizes.filter((size) => shapeOf(size) === "square")));
}
