"use client";

import { useState } from "react";

// The first of a speaker's faces (src/lib/speaker-faces.ts) that loads: each
// picture that fails gives way to the next, as a token's does on the board
// (TokenFace). Without it a portrait whose upload was deleted shows as a
// broken image, and in the story log that can be 7rem across. Returns the
// picture to show, undefined once none is left, and the img's onError.
//
// The failures are counted against the list they happened in, so a row
// handed another speaker's faces starts again from the first.
export function useFaceChain(faces: readonly string[] | undefined) {
  const key = faces?.join("|") ?? "";
  const [failed, setFailed] = useState({ key, count: 0 });
  const count = failed.key === key ? failed.count : 0;
  const onError = () => setFailed((current) => ({ key, count: (current.key === key ? current.count : 0) + 1 }));
  return [faces?.[count], onError] as const;
}
