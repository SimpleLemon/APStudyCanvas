(function () {
    "use strict";

    const STYLE_ID = "apstudycanvas-font-faces";

    function urlFor(file) {
        try { return chrome?.runtime?.getURL?.(`font/${file}`) || ""; } catch (error) { return ""; }
    }

    function fontFaceCss() {
        const newsreader = urlFor("newsreader-latin.woff2");
        const sans = urlFor("public-sans-latin.woff2");
        const mono = urlFor("ibm-plex-mono-latin-400.woff2");
        const monoMedium = urlFor("ibm-plex-mono-latin-500.woff2");
        if (!newsreader && !sans && !mono) return "";
        const faces = [];
        if (newsreader) faces.push(`@font-face { font-family: "Newsreader"; src: url("${newsreader}") format("woff2"); font-weight: 200 800; font-style: normal; font-display: swap; }`);
        if (sans) faces.push(`@font-face { font-family: "Public Sans"; src: url("${sans}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }`);
        if (mono) faces.push(`@font-face { font-family: "IBM Plex Mono"; src: url("${mono}") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }`);
        if (monoMedium) faces.push(`@font-face { font-family: "IBM Plex Mono"; src: url("${monoMedium}") format("woff2"); font-weight: 500; font-style: normal; font-display: swap; }`);
        return faces.join("\n");
    }

    function inject() {
        if (document.getElementById(STYLE_ID)) return true;
        const css = fontFaceCss();
        if (!css) return false;
        const parent = document.head || document.documentElement;
        if (!parent) return false;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = css;
        parent.appendChild(style);
        return true;
    }

    if (!inject()) {
        document.addEventListener("DOMContentLoaded", inject, { once: true });
    }
}());
