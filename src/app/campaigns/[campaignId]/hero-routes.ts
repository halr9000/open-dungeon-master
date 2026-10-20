// Which of the three ways to a hero to recommend (HeroRoutes.tsx). Pure, for
// scripts/test-hero-routes.mjs.

export type HeroRoute = "ready" | "library" | "build";

export type HeroRouteAdvice = {
  // The route marked on the screen.
  suggested: HeroRoute;
  // Whether ready-made heroes exist on this server at all.
  ready: boolean;
  // Whether the library holds a hero this seat may bring.
  library: boolean;
  // The ready-made list opens by itself (an empty library).
  openReady: boolean;
  // The library card's line, naming what it holds.
  libraryLine: string;
};

export function heroRouteAdvice({ library, pregens }: { library: string[]; pregens: number }): HeroRouteAdvice {
  const ready = pregens > 0;
  const has = library.length > 0;
  const named =
    library.length <= 2 ? library.join(" and ") : `${library.slice(0, 2).join(", ")} and ${library.length - 2} more`;
  return {
    // A player with heroes of their own most likely wants one of them; one
    // with none is quickest at the table with a ready-made one.
    suggested: has ? "library" : ready ? "ready" : "build",
    ready,
    library: has,
    openReady: !has && ready,
    libraryLine: has
      ? `${named}, adapted to this table's level. Joining leaves your library copy as it is.`
      : "Nothing saved yet. Heroes you make or take here are kept for your next table.",
  };
}
