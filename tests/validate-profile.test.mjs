import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  extractDestinations,
  repositoryRoot,
  resolveExistingLocalDestination,
  resolveLocalDestination,
  validateLicense,
  validateProfile,
  validateSvg,
} from "../scripts/validate-profile.mjs";

test("requires the canonical MIT license with collective attribution", () => {
  const license = [
    "MIT License",
    "",
    "Copyright (c) 2026 Ejupi Labs and project contributors",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
  ].join("\n");

  validateLicense(license);
  assert.throws(() => validateLicense("MIT License\n"), /copyright notice/u);
});

test("extracts Markdown and HTML destinations without duplicates", () => {
  const source = '[Project](docs/project.md)\n<a href="https://example.com"><img src="assets/card.svg" alt="Card" /></a>\n![Card](assets/card.svg)';

  assert.deepEqual(extractDestinations(source), [
    "docs/project.md",
    "https://example.com",
    "assets/card.svg",
  ]);
});

test("extracts angle-bracket, balanced and reference-style Markdown destinations", () => {
  const source = [
    "[Angle destination](<docs/file name.md>)",
    "[Nested destination](assets/card_(old).svg)",
    "[Full reference][project]",
    "[Collapsed reference][]",
    "[shortcut]",
    "",
    "[project]: <assets/project card.svg>",
    "[collapsed reference]: assets/collapsed_(old).svg \"Project card\"",
    "[shortcut]: assets/shortcut.svg",
  ].join("\n");

  assert.deepEqual(new Set(extractDestinations(source)), new Set([
    "docs/file name.md",
    "assets/card_(old).svg",
    "assets/project card.svg",
    "assets/collapsed_(old).svg",
    "assets/shortcut.svg",
  ]));
});

test("ignores destinations shown inside Markdown code", () => {
  const source = [
    "🧪 `[inline](missing-inline.svg)`",
    "```md",
    "[fenced](missing-fenced.svg)",
    "```",
    "[Real](assets/profile-header.svg)",
  ].join("\n");

  assert.deepEqual(extractDestinations(source), ["assets/profile-header.svg"]);
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
  assert.throws(
    () => resolveLocalDestination(repositoryRoot, "assets/%ZZ.svg"),
    /percent-encoding/u,
  );
});

test("requires local destinations to exist and rejects symbolic-link escapes", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "profile-validator-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const repository = join(temporaryRoot, "repository");
  const outside = join(temporaryRoot, "outside");
  await mkdir(join(repository, "assets"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(repository, "assets", "inside.svg"), "safe");
  await writeFile(join(outside, "private.svg"), "private");

  assert.equal(
    await resolveExistingLocalDestination(repository, "assets/inside.svg"),
    await realpath(join(repository, "assets", "inside.svg")),
  );
  await assert.rejects(
    resolveExistingLocalDestination(repository, "assets/missing.svg"),
    /does not exist/u,
  );

  try {
    await symlink(outside, join(repository, "assets", "escape"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      context.skip("Creating symbolic links is not permitted on this runner.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    resolveExistingLocalDestination(repository, "assets/escape/private.svg"),
    /symbolic link/u,
  );
});

test("rejects active content and every external-reference surface in SVG assets", () => {
  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="title"><title id="title">Safe</title><rect width="10" height="10" fill="#fff"/></svg>';
  validateSvg(safeSvg, "safe.svg");

  const unsafePayloads = [
    "<script>alert(1)</script>",
    '<foreignObject><p>HTML</p></foreignObject>',
    '<image href="//example.com/tracker.png"/>',
    '<text x="0" y="1" href="https://example.com/">remote</text>',
    '<rect width="1" height="1" src="data:image/svg+xml,bad"/>',
    '<use xlink:href="javascript:alert(1)"/>',
    "<style>@import url(https://example.com/style.css);</style>",
    '<rect width="1" height="1" style="fill:url(https://example.com/image.svg)"/>',
    '<rect width="1" height="1" fill="url(//example.com/paint.svg)"/>',
    '<rect width="1" height="1" onclick="alert(1)"/>',
    '<animate attributeName="x" dur="1s"/>',
  ];

  for (const payload of unsafePayloads) {
    assert.throws(
      () => validateSvg(safeSvg.replace("</svg>", `${payload}</svg>`), "unsafe.svg"),
      /active|external|CSS|event|unsupported|unsafe/iu,
      payload,
    );
  }
});

test("requires accessible metadata on the SVG root", () => {
  const nestedRole = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g role="img" aria-labelledby="title"><title id="title">Nested only</title></g></svg>';
  const wrongLabel = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="description"><title id="title">Title</title><desc id="description">Description</desc></svg>';

  assert.throws(() => validateSvg(nestedRole, "nested.svg"), /root element/u);
  assert.throws(() => validateSvg(wrongLabel, "wrong-label.svg"), /reference its title/u);
});

test("validates the checked-in profile without network access", async () => {
  const result = await validateProfile();

  assert.ok(result.destinationCount >= 10);
  assert.ok(result.localDestinationCount >= 7);
  assert.equal(result.svgCount, 7);
});

test("rejects an SVG asset that the profile does not use", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "profile-orphan-"));
  context.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  await cp(join(repositoryRoot, "README.md"), join(temporaryRoot, "README.md"));
  await cp(join(repositoryRoot, "LICENSE"), join(temporaryRoot, "LICENSE"));
  await cp(join(repositoryRoot, "assets"), join(temporaryRoot, "assets"), { recursive: true });
  await writeFile(
    join(temporaryRoot, "assets", "orphan.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img" aria-labelledby="title"><title id="title">Orphan</title><rect width="10" height="10" fill="#fff"/></svg>',
  );

  await assert.rejects(validateProfile(temporaryRoot), /not referenced by README\.md/u);
});
