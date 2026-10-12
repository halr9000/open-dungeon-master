import { lazy, type ComponentType } from "react";

// A component in its own download that can be fetched ahead of need.
//
// React.lazy suspends the first time its component renders even when the
// chunk is already in the browser (the import's promise settles a tick
// later), and a Suspense fallback, once shown, stays up for about 300 ms. A
// side panel the table had preloaded still flashed its skeleton the first
// time its tab opened. This renders the component directly once its module
// has arrived, so only a piece that is genuinely still on the way shows the
// fallback of the Suspense around it.
export type Preloadable<P extends object> = ComponentType<P> & { preload(): Promise<ComponentType<P>> };

export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>): Preloadable<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const fetch = (): Promise<ComponentType<P>> =>
    (pending ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        // A failed download is tried again by the next render or preload.
        pending = null;
        throw error;
      },
    ));
  const Lazy = lazy(() => fetch().then((component) => ({ default: component })));
  function PreloadableComponent(props: P) {
    const Loaded = loaded;
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  }
  return Object.assign(PreloadableComponent, { preload: fetch });
}
