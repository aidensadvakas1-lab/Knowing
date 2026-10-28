import type { MetadataRoute } from "next";

/** Web app manifest so Knowing can be added to a phone's home screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Knowing",
    short_name: "Knowing",
    description: "A personal goal coach you teach with videos, TikToks and notes.",
    start_url: "/",
    display: "standalone",
    background_color: "#EEF1F6",
    theme_color: "#2443B8",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
