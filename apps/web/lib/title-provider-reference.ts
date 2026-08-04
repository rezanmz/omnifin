import type { TitleProviderReference } from "@omnifin/contracts/discovery";

const PROVIDER_LABELS: Record<TitleProviderReference["provider"], string> = {
  imdb: "IMDb",
  rotten_tomatoes: "Rotten Tomatoes",
  tmdb: "TMDB",
};

export function titleProviderLabel(reference: TitleProviderReference) {
  return PROVIDER_LABELS[reference.provider];
}

export function titleProviderHref(reference: TitleProviderReference) {
  switch (reference.provider) {
    case "imdb":
      return `https://www.imdb.com/title/${reference.identifier}/`;
    case "tmdb":
      return `https://www.themoviedb.org/${reference.mediaKind === "movie" ? "movie" : "tv"}/${reference.identifier}`;
    case "rotten_tomatoes":
      return `https://www.rottentomatoes.com/${reference.mediaKind === "movie" ? "m" : "tv"}/${reference.identifier}`;
  }
}
