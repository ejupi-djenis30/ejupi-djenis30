import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  extractDestinations,
  repositoryRoot,
  resolveLocalDestination,
  validateProfile,
  validateSvg,
} from "../scripts/validate-profile.mjs";

test("extracts Markdown and HTML destinations without duplicates", () => {
  const source = '[Project](docs/project.md)\n<a href="https://example.com"><img src="assets/card.svg" alt="Card" /></a>\n![Card](assets/card.svg)';

  assert.deepEqual(extractDestinations(source), [
    "docs/project.md",
    "assets/card.svg",
    "https://example.com",
  ]);
});

test("confines local destinations to the repository", () => {
  assert.equal(
    resolveLocalDestination(repositoryRoot, "assets/profile-header.svg"),
    resolve(repositoryRoot, "assets/profile-header.svg"),
  );
  assert.throws(
    () => resolveLocalDestination(repositoryRoot, "../private.txt"),
    /escapes the repository/u,
  );
});

test("rejects active content in SVG assets", () => {
  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="title"><title id="title">Safe</title></svg>';
  validateSvg(safeSvg, "safe.svg");

  assert.throws(
    () => validateSvg(safeSvg.replace("</svg>", "<script>alert(1)</script></svg>"), "unsafe.svg"),
    /active content/u,
  );
});

test("validates the checked-in profile without network access", async () => {
  const result = await validateProfile();

  assert.ok(result.destinationCount >= 10);
  assert.ok(result.localDestinationCount >= 6);
  assert.ok(result.svgCount >= 6);
});
