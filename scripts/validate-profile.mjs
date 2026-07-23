/** Validate the profile README and its local SVG assets without network requests. */

import assert from "node:assert/strict";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");

const markdownEscapable = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u;
const safeSvgElements = new Set(["circle", "desc", "g", "path", "rect", "svg", "text", "title", "tspan"]);
const safeSvgAttributes = new Set([
  "aria-labelledby",
  "cx",
  "cy",
  "d",
  "fill",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "id",
  "letter-spacing",
  "opacity",
  "r",
  "role",
  "rx",
  "stroke",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-width",
  "text-anchor",
  "transform",
  "viewBox",
  "width",
  "x",
  "xmlns",
  "y",
]);

export function validateLicense(source) {
  assert.match(source, /^MIT License\r?\n/u, "LICENSE must use the MIT license.");
  assert.match(
    source,
    /Copyright \(c\) \d{4} Ejupi Labs and project contributors/u,
    "LICENSE must retain the collective copyright notice.",
  );
  assert.match(
    source,
    /Permission is hereby granted, free of charge, to any person obtaining a copy/u,
    "LICENSE is missing the MIT permission grant.",
  );
  assert.match(
    source,
    /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/u,
    "LICENSE is missing the MIT warranty disclaimer.",
  );
}

function blankExceptNewlines(value) {
  return value.replace(/[^\r\n]/gu, " ");
}

function maskInlineCode(line) {
  const characters = line.split("");

  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== "`") continue;

    let runLength = 1;
    while (characters[index + runLength] === "`") runLength += 1;
    const marker = "`".repeat(runLength);
    const closingIndex = line.indexOf(marker, index + runLength);
    if (closingIndex === -1) continue;

    for (let maskedIndex = index; maskedIndex < closingIndex + runLength; maskedIndex += 1) {
      if (characters[maskedIndex] !== "\r" && characters[maskedIndex] !== "\n") {
        characters[maskedIndex] = " ";
      }
    }
    index = closingIndex + runLength - 1;
  }

  return characters.join("");
}

function maskMarkdownCode(markdown) {
  const lines = markdown.match(/[^\n]*(?:\n|$)/gu) ?? [];
  let fence;

  return lines
    .map((line) => {
      const withoutNewline = line.replace(/\r?\n$/u, "");
      if (fence) {
        const closingFence = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`, "u");
        if (closingFence.test(withoutNewline)) fence = undefined;
        return blankExceptNewlines(line);
      }

      const openingFence = withoutNewline.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
      if (openingFence) {
        fence = { character: openingFence[0], length: openingFence.length };
        return blankExceptNewlines(line);
      }

      return maskInlineCode(line);
    })
    .join("");
}

function unescapeMarkdown(value) {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] && markdownEscapable.test(value[index + 1])) {
      result += value[index + 1];
      index += 1;
    } else {
      result += value[index];
    }
  }

  return result;
}

function normalizeReferenceLabel(label) {
  return unescapeMarkdown(label).trim().replace(/\s+/gu, " ").toLowerCase();
}

function readAngleDestination(source, start, context) {
  let destination = "";

  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\" && source[index + 1]) {
      destination += source[index] + source[index + 1];
      index += 1;
      continue;
    }
    if (source[index] === ">") {
      return { destination: unescapeMarkdown(destination), nextIndex: index + 1 };
    }
    if (source[index] === "\n" || source[index] === "\r" || source[index] === "<") {
      throw new Error(`Malformed angle-bracket destination in ${context}.`);
    }
    destination += source[index];
  }

  throw new Error(`Unclosed angle-bracket destination in ${context}.`);
}

function readBareDefinitionDestination(source, context) {
  let destination = "";
  let depth = 0;
  let index = 0;

  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1]) {
      destination += character + source[index + 1];
      index += 1;
      continue;
    }
    if (/\s/u.test(character) && depth === 0) break;
    if (character === "(") depth += 1;
    if (character === ")") {
      if (depth === 0) throw new Error(`Unbalanced destination in ${context}.`);
      depth -= 1;
    }
    destination += character;
  }

  if (depth !== 0) throw new Error(`Unbalanced destination in ${context}.`);
  if (!destination) throw new Error(`Missing destination in ${context}.`);
  return { destination: unescapeMarkdown(destination), nextIndex: index };
}

function readReferenceDefinitionDestination(source, context) {
  const trimmed = source.trimStart();
  if (!trimmed) throw new Error(`Missing destination in ${context}.`);
  if (trimmed[0] === "<") return readAngleDestination(trimmed, 0, context);
  return readBareDefinitionDestination(trimmed, context);
}

function readOptionalInlineTitle(source, start, context) {
  let index = start;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  if (source[index] === ")") return index + 1;

  const opening = source[index];
  const closing = opening === "(" ? ")" : opening;
  if (opening !== "\"" && opening !== "'" && opening !== "(") {
    throw new Error(`Malformed title in ${context}.`);
  }

  index += 1;
  for (; index < source.length; index += 1) {
    if (source[index] === "\\" && source[index + 1]) {
      index += 1;
      continue;
    }
    if (source[index] === closing) {
      index += 1;
      while (/\s/u.test(source[index] ?? "")) index += 1;
      if (source[index] !== ")") throw new Error(`Unclosed link in ${context}.`);
      return index + 1;
    }
  }

  throw new Error(`Unclosed title in ${context}.`);
}

function readInlineDestination(source, openingParenthesis) {
  const context = `Markdown link at offset ${openingParenthesis}`;
  let index = openingParenthesis + 1;
  while (/\s/u.test(source[index] ?? "")) index += 1;

  if (source[index] === "<") {
    const parsed = readAngleDestination(source, index, context);
    return {
      destination: parsed.destination,
      nextIndex: readOptionalInlineTitle(source, parsed.nextIndex, context),
    };
  }

  let destination = "";
  let depth = 0;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1]) {
      destination += character + source[index + 1];
      index += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
      destination += character;
      continue;
    }
    if (character === ")") {
      if (depth === 0) {
        return { destination: unescapeMarkdown(destination), nextIndex: index + 1 };
      }
      depth -= 1;
      destination += character;
      continue;
    }
    if (/\s/u.test(character) && depth === 0) {
      return {
        destination: unescapeMarkdown(destination),
        nextIndex: readOptionalInlineTitle(source, index, context),
      };
    }
    destination += character;
  }

  throw new Error(`Unclosed destination in ${context}.`);
}

function findClosingBracket(source, openingBracket) {
  let depth = 0;

  for (let index = openingBracket; index < source.length; index += 1) {
    if (source[index] === "\\" && source[index + 1]) {
      index += 1;
      continue;
    }
    if (source[index] === "[") depth += 1;
    if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function collectReferenceDefinitions(source) {
  const definitions = new Map();
  const occurrences = [];
  let offset = 0;

  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    const definition = line.match(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(.*)$/u);
    if (definition) {
      const label = normalizeReferenceLabel(definition[1]);
      const parsed = readReferenceDefinitionDestination(definition[2], `reference definition ${definition[1]}`);
      if (!definitions.has(label)) definitions.set(label, parsed.destination);
      occurrences.push({ destination: parsed.destination, index: offset });
    }
    offset += rawLine.length + 1;
  }

  return { definitions, occurrences };
}

export function extractDestinations(markdown) {
  const source = maskMarkdownCode(markdown);
  const { definitions, occurrences } = collectReferenceDefinitions(source);

  for (const match of source.matchAll(/\b(?:href|src)\s*=\s*(?:(["'])(.*?)\1|([^\s"'=<>`]+))/giu)) {
    occurrences.push({ destination: match[2] ?? match[3], index: match.index });
  }

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "[" || source[index - 1] === "\\") continue;
    const closingBracket = findClosingBracket(source, index);
    if (closingBracket === -1) continue;

    const labelText = source.slice(index + 1, closingBracket);
    const following = source[closingBracket + 1];
    if (following === "(") {
      const parsed = readInlineDestination(source, closingBracket + 1);
      occurrences.push({ destination: parsed.destination, index });
      index = parsed.nextIndex - 1;
      continue;
    }

    if (following === "[") {
      const referenceEnd = findClosingBracket(source, closingBracket + 1);
      if (referenceEnd !== -1) {
        const explicitLabel = source.slice(closingBracket + 2, referenceEnd);
        const referenceLabel = normalizeReferenceLabel(explicitLabel || labelText);
        const destination = definitions.get(referenceLabel);
        if (destination) occurrences.push({ destination, index });
        index = referenceEnd;
        continue;
      }
    }

    const shortcutDestination = definitions.get(normalizeReferenceLabel(labelText));
    if (shortcutDestination) occurrences.push({ destination: shortcutDestination, index });
    index = closingBracket;
  }

  occurrences.sort((left, right) => left.index - right.index);
  const destinations = [];
  const seen = new Set();
  for (const { destination } of occurrences) {
    if (!seen.has(destination)) {
      seen.add(destination);
      destinations.push(destination);
    }
  }
  return destinations;
}

function isPathWithin(root, target) {
  const pathFromRoot = relative(root, target);
  return Boolean(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export function resolveLocalDestination(root, destination) {
  const withoutFragment = destination.split(/[?#]/u, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch (error) {
    throw new Error(`Invalid percent-encoding in local destination: ${destination}`, { cause: error });
  }

  if (!decoded || decoded.includes("\0") || isAbsolute(decoded) || decoded.startsWith("/") || /^[a-z]:[\\/]/iu.test(decoded)) {
    throw new Error(`Invalid local destination: ${destination}`);
  }

  const resolved = resolve(root, decoded);
  if (!isPathWithin(root, resolved)) throw new Error(`Local destination escapes the repository: ${destination}`);
  return resolved;
}

export async function resolveExistingLocalDestination(root, destination) {
  const canonicalRoot = await realpath(root);
  const localPath = resolveLocalDestination(canonicalRoot, destination);
  let canonicalPath;
  try {
    canonicalPath = await realpath(localPath);
  } catch (error) {
    throw new Error(`Local destination does not exist: ${destination}`, { cause: error });
  }

  if (!isPathWithin(canonicalRoot, canonicalPath)) {
    throw new Error(`Local destination escapes the repository through a symbolic link: ${destination}`);
  }
  const localStat = await stat(canonicalPath);
  assert.ok(localStat.isFile(), `Local destination is not a file: ${destination}`);
  return canonicalPath;
}

function findSvgTagEnd(source, openingBracket, label) {
  let quote;
  for (let index = openingBracket + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    } else if (character === "<") {
      throw new Error(`${label} contains a malformed SVG tag.`);
    }
  }
  throw new Error(`${label} contains an unclosed SVG tag.`);
}

function parseSvgAttributes(source, label, element) {
  const attributes = new Map();
  let index = 0;

  while (index < source.length) {
    const whitespaceStart = index;
    while (/\s/u.test(source[index] ?? "")) index += 1;
    if (index === source.length) break;
    assert.ok(index > whitespaceStart, `${label} contains malformed attributes on <${element}>.`);

    const name = source.slice(index).match(/^[A-Za-z_:][A-Za-z0-9_.:-]*/u)?.[0];
    assert.ok(name, `${label} contains a malformed attribute on <${element}>.`);
    index += name.length;
    while (/\s/u.test(source[index] ?? "")) index += 1;
    assert.equal(source[index], "=", `${label} attribute ${name} must have a value.`);
    index += 1;
    while (/\s/u.test(source[index] ?? "")) index += 1;

    const quote = source[index];
    assert.ok(quote === "\"" || quote === "'", `${label} attribute ${name} must use quotes.`);
    const valueStart = index + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    assert.notEqual(valueEnd, -1, `${label} attribute ${name} has an unclosed value.`);
    const value = source.slice(valueStart, valueEnd);
    index = valueEnd + 1;

    assert.ok(!attributes.has(name), `${label} repeats attribute ${name} on <${element}>.`);
    assert.doesNotMatch(name, /^on/iu, `${label} contains an inline event handler.`);
    assert.ok(!["href", "xlink:href", "src"].includes(name.toLowerCase()), `${label} contains an external or executable reference.`);
    assert.notEqual(name.toLowerCase(), "style", `${label} contains inline CSS.`);
    assert.doesNotMatch(value, /@import\b|\burl\s*\(/iu, `${label} contains an external CSS reference.`);
    assert.ok(safeSvgAttributes.has(name), `${label} uses unsupported attribute ${name} on <${element}>.`);
    if (name === "fill" || name === "stroke") {
      assert.match(value, /^(?:none|currentColor|#[0-9a-f]{3,8})$/iu, `${label} contains an unsafe ${name} value.`);
    }
    attributes.set(name, value);
  }

  return attributes;
}

function parseSvg(source, label) {
  const stack = [];
  const ids = new Set();
  const titles = [];
  let rootAttributes;
  let rootSeen = false;
  let rootClosed = false;
  let cursor = 0;

  while (cursor < source.length) {
    const openingBracket = source.indexOf("<", cursor);
    if (openingBracket === -1) break;
    if (stack.length === 0) {
      assert.equal(source.slice(cursor, openingBracket).trim(), "", `${label} contains text outside the SVG root.`);
    }

    const tagEnd = findSvgTagEnd(source, openingBracket, label);
    const rawTag = source.slice(openingBracket + 1, tagEnd);
    const closing = rawTag.startsWith("/");

    if (closing) {
      const closingName = rawTag.slice(1).trim();
      assert.match(closingName, /^[A-Za-z][A-Za-z0-9.-]*$/u, `${label} contains a malformed closing tag.`);
      const opened = stack.pop();
      assert.ok(opened, `${label} closes <${closingName}> without opening it.`);
      assert.equal(closingName, opened.name, `${label} closes <${closingName}> while <${opened.name}> is open.`);
      if (closingName === "title") {
        const titleText = source.slice(opened.contentStart, openingBracket);
        assert.doesNotMatch(titleText, /</u, `${label} title must contain text only.`);
        titles.push({ id: opened.attributes.get("id"), text: titleText.trim() });
      }
      if (stack.length === 0) rootClosed = true;
      cursor = tagEnd + 1;
      continue;
    }

    const selfClosing = /\/\s*$/u.test(rawTag);
    const tagBody = selfClosing ? rawTag.replace(/\/\s*$/u, "") : rawTag;
    const element = tagBody.match(/^([A-Za-z][A-Za-z0-9.-]*)/u)?.[1];
    assert.ok(element, `${label} contains a malformed opening tag.`);
    const attributes = parseSvgAttributes(tagBody.slice(element.length), label, element);
    assert.ok(safeSvgElements.has(element), `${label} contains active or unsupported element <${element}>.`);

    if (stack.length === 0) {
      assert.ok(!rootSeen && !rootClosed, `${label} must contain exactly one SVG root.`);
      assert.equal(element, "svg", `${label} must start with an SVG root element.`);
      rootSeen = true;
      rootAttributes = attributes;
    }

    const id = attributes.get("id");
    if (id) {
      assert.match(id, /^[A-Za-z_][A-Za-z0-9_.:-]*$/u, `${label} contains invalid id ${id}.`);
      assert.ok(!ids.has(id), `${label} contains duplicate id ${id}.`);
      ids.add(id);
    }

    if (selfClosing) {
      if (element === "title") titles.push({ id, text: "" });
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push({ attributes, contentStart: tagEnd + 1, name: element });
    }
    cursor = tagEnd + 1;
  }

  assert.equal(source.slice(cursor).trim(), "", `${label} contains trailing content outside the SVG root.`);
  assert.ok(rootSeen && rootClosed && stack.length === 0, `${label} must contain one complete SVG root.`);
  return { ids, rootAttributes, titles };
}

export function validateSvg(source, label) {
  assert.ok(Buffer.byteLength(source, "utf8") <= 250_000, `${label} must remain below 250 KB.`);
  assert.doesNotMatch(source, /<!--|<!\[CDATA\[|<!DOCTYPE|<!ENTITY|<\?/iu, `${label} contains unsupported XML directives.`);
  assert.doesNotMatch(
    source,
    /<(?:script|style|foreignObject|iframe|object|embed|image|use|a|audio|video|animate|animateMotion|animateTransform|set)\b/iu,
    `${label} contains active content.`,
  );

  const { ids, rootAttributes, titles } = parseSvg(source, label);
  assert.equal(rootAttributes.get("xmlns"), "http://www.w3.org/2000/svg", `${label} needs the SVG namespace.`);
  assert.ok(rootAttributes.get("viewBox"), `${label} needs a viewBox.`);
  assert.equal(rootAttributes.get("role"), "img", `${label} must expose an image role on its root element.`);

  const meaningfulTitles = titles.filter(({ id, text }) => id && text);
  assert.ok(meaningfulTitles.length > 0, `${label} needs a non-empty title with an id.`);
  const labelledBy = rootAttributes.get("aria-labelledby");
  assert.ok(labelledBy, `${label} needs aria-labelledby on its root element.`);
  const labelledIds = labelledBy.trim().split(/\s+/u);
  for (const id of labelledIds) assert.ok(ids.has(id), `${label} references missing label id ${id}.`);
  assert.ok(
    meaningfulTitles.some(({ id }) => labelledIds.includes(id)),
    `${label} aria-labelledby must reference its title.`,
  );
}

function validateRemoteDestination(destination) {
  if (destination.toLowerCase().startsWith("mailto:")) {
    const address = destination.slice("mailto:".length).split("?", 1)[0];
    assert.match(address, /^[^@\s]+@ejupilabs\.com$/iu, `Unexpected email destination: ${destination}`);
    return;
  }

  const url = new URL(destination);
  assert.equal(url.protocol, "https:", `External links must use HTTPS: ${destination}`);
  assert.ok(url.hostname, `External link is missing a hostname: ${destination}`);
}

export async function validateProfile(root = repositoryRoot) {
  const canonicalRoot = await realpath(root);
  validateLicense(await readFile(resolve(canonicalRoot, "LICENSE"), "utf8"));
  const readmePath = resolve(canonicalRoot, "README.md");
  const readme = await readFile(readmePath, "utf8");

  for (const section of ["### Systems you can run", "### The toolkit", "### Working notes"]) {
    assert.ok(readme.includes(section), `README.md is missing ${section}.`);
  }

  const releaseEvidence = [
    "CareerOS Local `v1.5.0`",
    "on-device LLM is required for analysis and has no cloud fallback",
    "deterministic, user-scoped agenda",
    "evidence matching fails closed",
    "https://github.com/ejupi-djenis30/careeros-local/releases/tag/v1.5.0",
    "ELIZA Lab `v1.4.0`",
    "seven deterministic transformations across 70 frozen inputs, evaluating 490 variants",
    "synthetic and English-only",
    "consistency does not prove correctness",
    "https://github.com/ejupi-djenis30/PsychologistRustBot/releases/tag/v1.4.0",
  ];
  for (const evidence of releaseEvidence) {
    assert.ok(readme.includes(evidence), `README.md is missing verified release evidence: ${evidence}`);
  }

  assert.doesNotMatch(readme, /<table\b/iu, "README.md must keep project content in a mobile-friendly single column.");
  assert.doesNotMatch(readme, /<(?:video|source)\b/iu, "README.md must not embed demonstration videos.");

  const imageTags = [...readme.matchAll(/<img\b[^>]*>/giu)].map((match) => match[0]);
  assert.ok(imageTags.length >= 6, "README.md must retain the profile header and project cards.");
  for (const tag of imageTags) {
    assert.match(tag, /\balt=["'][^"']+["']/iu, `README image is missing useful alt text: ${tag}`);
  }

  const destinations = extractDestinations(readme);
  assert.ok(destinations.length > 0, "README.md contains no links or images.");
  let localDestinationCount = 0;
  const referencedLocalFiles = new Set();
  for (const destination of destinations) {
    if (destination.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(destination)) {
      validateRemoteDestination(destination);
      continue;
    }

    assert.match(destination, /\.svg(?:[?#].*)?$/iu, `Local profile visuals must be code-native SVG assets: ${destination}`);
    referencedLocalFiles.add(await resolveExistingLocalDestination(canonicalRoot, destination));
    localDestinationCount += 1;
  }

  const assetDirectory = resolve(canonicalRoot, "assets");
  const svgFiles = (await readdir(assetDirectory)).filter((name) => name.toLowerCase().endsWith(".svg")).sort();
  assert.ok(svgFiles.length > 0, "The assets directory contains no SVG files.");
  for (const name of svgFiles) {
    const assetPath = resolve(assetDirectory, name);
    assert.ok(
      referencedLocalFiles.has(await realpath(assetPath)),
      `assets/${name} is not referenced by README.md. Remove obsolete profile assets.`,
    );
    const assetSource = await readFile(assetPath, "utf8");
    validateSvg(assetSource, `assets/${name}`);
    if (name === "eliza-card.svg") {
      assert.ok(
        assetSource.includes("seven deterministic transformations across 70 frozen inputs, evaluating 490 variants"),
        "assets/eliza-card.svg must state the exact frozen-audit population.",
      );
      assert.ok(
        assetSource.includes(">VARIANTS</text>"),
        "assets/eliza-card.svg must label the 490 outputs as variants.",
      );
      assert.ok(
        assetSource.includes(">7 CONTROLLED TRANSFORMS</text>"),
        "assets/eliza-card.svg must retain the seven-transform visual key.",
      );
    }
  }

  return { destinationCount: destinations.length, localDestinationCount, svgCount: svgFiles.length };
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const result = await validateProfile();
  console.log(
    `Profile integrity passed: ${result.destinationCount} destinations, ${result.localDestinationCount} local files, ${result.svgCount} SVG assets.`,
  );
}
