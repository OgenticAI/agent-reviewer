import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanDependencyManifests,
  declaredPackages,
  describeUnscanned,
} from "../../src/engine/audit/dependencies.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "deps-test-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const full = join(scratch, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Ardalis.Specification" Version="8.0.0" />
    <PackageReference Include="Asp.Versioning.Mvc" Version="8.1.0" />
  </ItemGroup>
</Project>`;

describe("reading what a tree declares it depends on", () => {
  it("finds NuGet packages a .NET tree declares across many project files", () => {
    write("src/Api/Api.csproj", CSPROJ);
    write(
      "src/Domain/Domain.csproj",
      CSPROJ.replace("Ardalis.Specification", "Serilog"),
    );
    const [nuget] = scanDependencyManifests(scratch);
    expect(nuget?.ecosystem).toBe("nuget");
    expect(nuget?.manifests).toHaveLength(2);
    // Union, not sum: the same package declared twice is one dependency.
    expect(nuget?.packages).toBe(3);
    expect(nuget?.lockfile).toBe(false);
  });

  it("marks the graph as pinned only when a lockfile is present", () => {
    write("src/Api/Api.csproj", CSPROJ);
    expect(scanDependencyManifests(scratch)[0]?.lockfile).toBe(false);
    write("src/Api/packages.lock.json", JSON.stringify({ dependencies: { "Serilog": {} } }));
    expect(scanDependencyManifests(scratch)[0]?.lockfile).toBe(true);
  });

  it("does not count the same tree twice through vendored directories", () => {
    write("package.json", JSON.stringify({ dependencies: { react: "^18" } }));
    write("node_modules/react/package.json", JSON.stringify({ dependencies: { loose: "1" } }));
    const [npm] = scanDependencyManifests(scratch);
    expect(npm?.manifests).toEqual(["package.json"]);
    expect(npm?.packages).toBe(1);
  });

  it("sorts ecosystems by size, so the biggest unscanned one is named first", () => {
    write("api/Api.csproj", CSPROJ);
    write("web/package.json", JSON.stringify({ dependencies: { react: "^18" } }));
    expect(scanDependencyManifests(scratch)[0]?.ecosystem).toBe("nuget");
  });

  it.each([
    ["packages.config", '<packages><package id="Newtonsoft.Json" version="13.0.1" /></packages>', "Newtonsoft.Json"],
    ["requirements.txt", "requests==2.31.0\n# a comment\nflask>=2\n", "requests"],
    ["pom.xml", "<dependency><artifactId>guava</artifactId></dependency>", "guava"],
  ])("reads %s", (name, text, expected) => {
    expect(declaredPackages(name, text)).toContain(expected);
  });

  // A manifest we cannot parse is still a manifest. Crashing the walk would
  // lose every other ecosystem in the tree.
  it("counts an unparseable manifest as present with nothing declared", () => {
    write("web/package.json", "{ this is not json");
    const [npm] = scanDependencyManifests(scratch);
    expect(npm?.manifests).toEqual(["web/package.json"]);
    expect(npm?.packages).toBe(0);
  });
});

describe("the sentence a skipped scan prints", () => {
  // "No npm lockfile at the repository root" is true over a .NET tree and reads
  // as "there is nothing here". A reader has to be told what went unexamined.
  it("names the count, the ecosystem, and that nothing was checked", () => {
    write("src/Api/Api.csproj", CSPROJ);
    const message = describeUnscanned(scanDependencyManifests(scratch), []);
    expect(message).toMatch(/2 nuget package\(s\)/);
    expect(message).toMatch(/NOT checked/);
  });

  // Without a lockfile the count is a floor. Presenting it as a total would be
  // the same error the report exists to avoid.
  it("says a count is declared-only when no lockfile pins the graph", () => {
    write("src/Api/Api.csproj", CSPROJ);
    expect(describeUnscanned(scanDependencyManifests(scratch), [])).toMatch(/not lock-pinned/);
  });

  it("says nothing when every ecosystem found was scanned", () => {
    write("web/package.json", JSON.stringify({ dependencies: { react: "^18" } }));
    expect(describeUnscanned(scanDependencyManifests(scratch), ["npm"])).toBeNull();
  });

  it("says nothing for a tree that declares no dependencies at all", () => {
    write("src/main.go", "package main");
    expect(describeUnscanned(scanDependencyManifests(scratch), [])).toBeNull();
  });
});
