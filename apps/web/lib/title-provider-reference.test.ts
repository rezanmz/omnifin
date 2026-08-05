import { describe, expect, it } from "vitest";

import { titleProviderHref, titleProviderLabel } from "./title-provider-reference";

describe("title provider references", () => {
  it("constructs only reviewed canonical title destinations", () => {
    expect(
      titleProviderHref({ identifier: "tt0133093", mediaKind: "movie", provider: "imdb" }),
    ).toBe("https://www.imdb.com/title/tt0133093/");
    expect(titleProviderHref({ identifier: 603, mediaKind: "movie", provider: "tmdb" })).toBe(
      "https://www.themoviedb.org/movie/603",
    );
    expect(titleProviderHref({ identifier: 1396, mediaKind: "series", provider: "tmdb" })).toBe(
      "https://www.themoviedb.org/tv/1396",
    );
    expect(
      titleProviderHref({
        identifier: "breaking_bad",
        mediaKind: "series",
        provider: "rotten_tomatoes",
      }),
    ).toBe("https://www.rottentomatoes.com/tv/breaking_bad");
  });

  it("provides concise visible provider labels", () => {
    expect(
      titleProviderLabel({ identifier: "tt0133093", mediaKind: "movie", provider: "imdb" }),
    ).toBe("IMDb");
  });
});
