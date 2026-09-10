"use strict";

// WCAG 2.1 sRGB contrast, plus just enough CSS colour resolution to evaluate the
// tokens this repo actually ships: hex literals, var() references into a :root
// token map, and color-mix(in srgb, A p%, B).
//
// The suite has no jsdom, no CSSOM, and no computed style, so contrast cannot be
// measured from a rendered page. It is computed here from the declared token
// text instead: change a token in css/*.css and the ratio assertions recompute
// against the new value rather than silently passing on stale prose.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHex(value) {
    const raw = String(value).trim();
    if (!HEX.test(raw)) throw new Error(`not a hex colour: ${value}`);
    const digits = raw.slice(1);
    const full = digits.length === 3 ? digits.split("").map((c) => c + c).join("") : digits;
    return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16));
}

function toHex(rgb) {
    return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

// color-mix(in srgb, ...) interpolates in gamma-encoded sRGB, so this is a plain
// per-channel weighted average — no linearisation.
function mixSrgb(first, weight, second) {
    const a = parseHex(first);
    const b = parseHex(second);
    return toHex(a.map((channel, index) => channel * weight + b[index] * (1 - weight)));
}

// An element rendered at `alpha` over an opaque backdrop. Used for the dimmed
// aria-disabled rows, where the row's own opacity is what the eye sees.
function compositeOver(foreground, alpha, backdrop) {
    const f = parseHex(foreground);
    const b = parseHex(backdrop);
    return toHex(f.map((channel, index) => channel * alpha + b[index] * (1 - alpha)));
}

function relativeLuminance(colour) {
    const [r, g, b] = parseHex(colour).map((channel) => {
        const scaled = channel / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
    const a = relativeLuminance(foreground);
    const b = relativeLuminance(background);
    const light = Math.max(a, b);
    const dark = Math.min(a, b);
    return (light + 0.05) / (dark + 0.05);
}

// Rounded down, so an assertion of ">= 3" is never satisfied by 2.996 printing
// as "3.00".
function ratio(foreground, background) {
    return Math.floor(contrastRatio(foreground, background) * 100) / 100;
}

// Reads the first `:root { ... }` block and returns { "--name": "raw value" }.
function readRootTokens(css) {
    const start = css.indexOf(":root");
    if (start === -1) throw new Error("no :root block");
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    const body = css.slice(open + 1, close);
    const tokens = {};
    // Split on top-level semicolons so color-mix(...) commas stay intact, and
    // drop /* comments */ first so commented ratios are not parsed as tokens.
    body.replace(/\/\*[\s\S]*?\*\//g, "").split(";").forEach((declaration) => {
        const match = declaration.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+)$/);
        if (match) tokens[match[1]] = match[2].trim();
    });
    return tokens;
}

const MIX = /^color-mix\(\s*in\s+srgb\s*,\s*([\s\S]+)\)$/i;

// Splits a color-mix() argument list on commas that are not inside parentheses.
function splitTopLevel(text) {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const character of text) {
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        if (character === "," && depth === 0) {
            parts.push(current);
            current = "";
            continue;
        }
        current += character;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
}

// Resolves a declared value to a hex string. `transparent` is rejected on
// purpose: a translucent colour has no single contrast value, and every pair
// this repo audits resolves to an opaque surface.
function resolveColour(value, tokens, seen = new Set()) {
    const raw = String(value).trim();
    if (HEX.test(raw)) return toHex(parseHex(raw));

    const variable = raw.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
    if (variable) {
        const [, name, fallback] = variable;
        if (seen.has(name)) throw new Error(`circular token: ${name}`);
        const declared = tokens[name];
        if (declared !== undefined) return resolveColour(declared, tokens, new Set([...seen, name]));
        if (fallback !== undefined) return resolveColour(fallback, tokens, new Set([...seen, name]));
        throw new Error(`undefined token with no fallback: ${name}`);
    }

    const mix = raw.match(MIX);
    if (mix) {
        const parts = splitTopLevel(mix[1]);
        if (parts.length !== 2) throw new Error(`unsupported color-mix arity: ${raw}`);
        const first = parts[0].match(/^([\s\S]+?)\s+([\d.]+)%$/);
        if (!first) throw new Error(`color-mix needs an explicit first percentage: ${raw}`);
        const weight = Number(first[2]) / 100;
        const second = parts[1].replace(/\s+[\d.]+%$/, "");
        return mixSrgb(resolveColour(first[1], tokens, seen), weight, resolveColour(second, tokens, seen));
    }

    throw new Error(`unsupported colour value: ${raw}`);
}

// Convenience: resolve a token name straight out of a stylesheet's :root.
function tokenColour(tokens, name) {
    return resolveColour(`var(${name})`, tokens);
}

module.exports = {
    parseHex,
    toHex,
    mixSrgb,
    compositeOver,
    relativeLuminance,
    contrastRatio,
    ratio,
    readRootTokens,
    resolveColour,
    tokenColour
};
