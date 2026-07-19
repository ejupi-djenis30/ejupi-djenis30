/** Validate the profile README and its local SVG assets without network requests. */

import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");

export function extractDestinations(markdown) {
  const destinations = [];

  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/gu)) {
    destinations.push(match[1]);
  }

  for (const match of markdown.matchAll(/(?:href|src)\s*=\s*(["'])(.*?)\1/giu)) {
    destinations.push(match[2]);
  }

  return [...new Set(destinations)];
}

export function resolveLocalDestination(root, destination) {
  const withoutFragment = destination.split(/[?#]/u, 1)[0];
  const decoded = decodeURIComponent(withoutFragment);

  if (!decoded || isAbsolute(decoded) || decoded.startsWith("/") || /^[a-z]:[\\/]/iu.test(decoded)) {
    throw new Error(`Invalid local destination: ${destination}`);
  }

  const resolved = resolve(root, decoded);
  const pathFromRoot = relative(root, resolved);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`Local destination escapes the repository: ${destination}`);
  }

  return resolved;
}

export function validateSvg(source, label) {
  assert.ok(source.length <= 250_000, `${label} must remain below 250 KB.`);
  assert.match(source, /^\s*<svg\b/u, `${label} must start with an SVG root element.`);
  assert.match(source, /\bxmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/u, `${label} needs the SVG namespace.`);
  assert.match(source, /\bviewBox=["'][^"']+["']/u, `${label} needs a viewBox.`);
  assert.match(source, /\brole=["']img["']/u, `${label} must expose an image role.`);
  assert.match(source, /<title\b[^>]*>[^<]+<\/title>/u, `${label} needs a non-empty title.`);
  assert.doesNotMatch(source, /<(?:script|foreignObject|iframe|object|embed)\b/iu, `${label} contains active content.`);
  assert.doesNotMatch(source, /\son[a-z]+\s*=/iu, `${label} contains an inline event handler.`);
  assert.doesNotMatch(source, /(?:href|xlink:href)\s*=\s*["'](?:https?:|data:|javascript:)/iu, `${label} contains an external or executable reference.`);

  const labelledBy = source.match(/\baria-labelledby=["']([^"']+)["']/u)?.[1];
  assert.ok(labelledBy, `${label} needs aria-labelledby.`);
  for (const id of labelledBy.trim().split(/\s+/u)) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(source, new RegExp(`\\bid=["']${escapedId}["']`, "u"), `${label} references missing label id ${id}.`);
  }
}

function validateRemoteDestination(destination) {
  if (destination.startsWith("mailto:")) {
    const address = destination.slice("mailto:".length).split("?", 1)[0];
    assert.match(address, /^[^@\s]+@ejupilabs\.com$/iu, `Unexpected email destination: ${destination}`);
    return;
  }

  const url = new URL(destination);
  assert.equal(url.protocol, "https:", `External links must use HTTPS: ${destination}`);
  assert.ok(url.hostname, `External link is missing a hostname: ${destination}`);
}

export async function validateProfile(root = repositoryRoot) {
  const readmePath = resolve(root, "README.md");
  const readme = await readFile(readmePath, "utf8");

  for (const section of ["### Selected work", "### The toolkit", "### Working notes"]) {
    assert.ok(readme.includes(section), `README.md is missing ${section}.`);
  }

  const imageTags = [...readme.matchAll(/<img\b[^>]*>/giu)].map((match) => match[0]);
  assert.ok(imageTags.length >= 6, "README.md must retain the profile header and project cards.");
  for (const tag of imageTags) {
    assert.match(tag, /\balt=["'][^"']+["']/iu, `README image is missing useful alt text: ${tag}`);
  }

  const destinations = extractDestinations(readme);
  assert.ok(destinations.length > 0, "README.md contains no links or images.");
  let localDestinationCount = 0;
  for (const destination of destinations) {
    if (destination.startsWith("#")) continue;
    if (/^(?:https:|http:|mailto:)/iu.test(destination)) {
      validateRemoteDestination(destination);
      continue;
    }

    const localPath = resolveLocalDestination(root, destination);
    const localStat = await stat(localPath);
    assert.ok(localStat.isFile(), `Local destination is not a file: ${destination}`);
    localDestinationCount += 1;
  }

  const assetDirectory = resolve(root, "assets");
  const svgFiles = (await readdir(assetDirectory)).filter((name) => name.endsWith(".svg")).sort();
  assert.ok(svgFiles.length > 0, "The assets directory contains no SVG files.");
  for (const name of svgFiles) {
    validateSvg(await readFile(resolve(assetDirectory, name), "utf8"), `assets/${name}`);
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
