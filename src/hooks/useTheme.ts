import { useEffect } from "react";
import { useSettings } from "./useSettings";

export function useTheme() {
  const { theme, setTheme, colorPalette, setColorPalette } = useSettings();

  // Palette is an orthogonal accent-colour choice layered on top of the
  // light/dark scheme above — see the [data-palette] blocks in index.css,
  // each restating every token for both schemes so nothing falls through to
  // the default palette's colours. Set on body as well as html: the dark
  // class below also lands on body, and plain `.dark` (no data-palette) sets
  // the same --color-* custom properties directly on that element — since a
  // property set on a nearer element always shadows one inherited from an
  // ancestor, an unpaletted body.dark would silently override html's
  // paletted dark colours for everything the app renders.
  useEffect(() => {
    const htmlElement = document.documentElement;
    if (colorPalette && colorPalette !== "default") {
      htmlElement.setAttribute("data-palette", colorPalette);
      document.body.setAttribute("data-palette", colorPalette);
    } else {
      htmlElement.removeAttribute("data-palette");
      document.body.removeAttribute("data-palette");
    }
  }, [colorPalette]);

  useEffect(() => {
    const htmlElement = document.documentElement;

    // Determine effective theme
    const effectiveTheme: "light" | "dark" =
      theme === "auto"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;

    // Apply dark class
    if (effectiveTheme === "dark") {
      htmlElement.classList.add("dark");
      document.body.classList.add("dark");
    } else {
      htmlElement.classList.remove("dark");
      document.body.classList.remove("dark");
    }

    // Listen for system preference changes (only when auto)
    if (theme === "auto") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => {
        if (e.matches) {
          htmlElement.classList.add("dark");
          document.body.classList.add("dark");
        } else {
          htmlElement.classList.remove("dark");
          document.body.classList.remove("dark");
        }
      };

      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    }
  }, [theme]);

  return { theme, setTheme, colorPalette, setColorPalette };
}
