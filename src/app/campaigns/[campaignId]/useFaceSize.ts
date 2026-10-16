"use client";

import { useLayoutEffect, useState, type CSSProperties } from "react";

// A column out of sight (display: none: the story column on a phone or a
// narrow window while the side panel shows) measures 0, and that is never
// taken as its height. Shrinking every face while the log was hidden and
// growing them back once it was shown left the reader far above the newest
// line, and the scroll that clamp caused stopped the log following.
function usableHeight(measured: number): number | null {
  const rounded = Math.round(measured);
  return rounded > 0 ? rounded : null;
}

// A speaker's portrait in the story log, sized to the words beside it: a
// one-line remark gets a face as tall as its name and bubble, a long speech
// a larger one, up to the cap the stylesheet sets (--face-max in
// session.css). The art players make for their characters was drawn at the
// 40px a token needs on the board; the log has room to show it.
//
// CSS alone cannot size a circle to the height of the text next to it (a
// flex item's width is settled before its stretched height), so the text
// column is measured and its height handed to the stylesheet as --face-size,
// where clamp() keeps it between the old size and the cap. Returns the
// style for the face and the callback ref for the text column.
export function useFaceSize<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  // Later changes (a resize, a pane dragged, a line edited) come from the
  // observer, which hands over the column's own box: reading a fresh layout
  // for each line instead is what made a drag across a long log force a
  // layout per line in the apps.
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const next = usableHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      if (next) {
        setHeight(next);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  // The first measurement, and again after each size is applied, before the
  // paint: a larger face narrows the column, which may then wrap once more,
  // and settling that here leaves the log at its final height by the time
  // MessageList follows it to the bottom. The rounds end: a larger face can
  // only make the column taller and a smaller one shorter, so each round
  // moves the face the same way as the last, until it rests or meets the
  // cap or the floor.
  useLayoutEffect(() => {
    const settle = (next: number | null) => {
      if (next && next !== height) {
        setHeight(next);
      }
    };
    if (element) {
      settle(usableHeight(element.getBoundingClientRect().height));
    }
  }, [element, height]);

  const style = (height ? { "--face-size": `${height}px` } : {}) as CSSProperties;
  return [style, setElement] as const;
}
