import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildPiLaunch,
  isProfileName,
  loadProfileCatalog,
  MAX_PROFILE_DESCRIPTION_LENGTH,
  type Profile,
} from "../src/profiles.ts";

const bundledProfiles = fileURLToPath(new URL("../agents", import.meta.url));

async function directories(prefix = "profiles-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const bundledDir = join(root, "bundled");
  const userDir = join(root, "user");
  await mkdir(bundledDir);
  return { root, bundledDir, userDir };
}

function markdown(frontmatter: string, body = "System prompt") {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

async function writeProfile(directory: string, filename: string, frontmatter: string, body?: string) {
  const path = join(directory, filename);
  await writeFile(path, markdown(frontmatter, body));
  return path;
}

const minimal = (name: string) => `name: ${name}\ndescription: ${name} description\nuse-worktree: false`;

test("bundled Markdown profiles expose the approved launch controls and role guidance", async () => {
  const { root, userDir } = await directories();
  try {
    const catalog = loadProfileCatalog({ bundledDir: bundledProfiles, userDir });
    assert.deepEqual(Object.keys(catalog), ["researcher", "scout", "worker"]);

    const scout = catalog.scout!;
    assert.equal(scout.description, "Repository inspection and codebase questions");
    assert.equal(scout.useWorktree, false);
    assert.deepEqual(scout.tools, ["read", "grep", "find", "ls"]);
    assert.equal(scout.thinking, "medium");
    assert.equal(scout.model, undefined);
    assert.equal(scout.filePath, join(bundledProfiles, "scout.md"));
    assert.match(scout.systemPrompt, /Follow the assigned task and any additional instructions precisely/);
    assert.match(scout.systemPrompt, /When useful and available, consider search and discovery tools/);
    assert.match(scout.systemPrompt, /no particular tool or sequence is required/);

    const researcher = catalog.researcher!;
    assert.deepEqual(researcher.tools, ["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content"]);
    assert.equal(researcher.thinking, "high");
    assert.equal(researcher.useWorktree, false);
    assert.equal(researcher.model, undefined);
    assert.match(researcher.systemPrompt, /Perform in-depth research/);
    assert.match(researcher.systemPrompt, /perform focused follow-up research/);
    assert.match(researcher.systemPrompt, /Keep the depth proportional to the assigned task/);

    const worker = catalog.worker!;
    assert.deepEqual(worker.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
    assert.equal(worker.thinking, "high");
    assert.equal(worker.useWorktree, true);
    assert.equal(worker.model, undefined);
    assert.match(worker.systemPrompt, /Use your judgment and the repository's established patterns/);
    assert.match(worker.systemPrompt, /No particular tool sequence is required/);
    assert.match(worker.systemPrompt, /Prefer the simplest coherent implementation/);
    assert.match(worker.systemPrompt, /Validation should be proportionate to the task/);

    assert.equal(Object.isFrozen(catalog), true);
    assert.equal(Object.isFrozen(scout), true);
    assert.equal(Object.isFrozen(scout.tools), true);
    assert.throws(() => (scout.tools as string[]).push("bash"), TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog ordering, additions, and whole-profile user overrides are deterministic", async () => {
  const { root, bundledDir, userDir } = await directories();
  try {
    await mkdir(userDir);
    await writeProfile(bundledDir, "z.md", minimal("zeta"));
    await writeProfile(bundledDir, "a.md", `${minimal("shared")}\ntools: [read]\nthinking: low`, "Bundled prompt");
    await writeProfile(userDir, "custom.md", `${minimal("alpha")}\nmodel: provider/model`, "Alpha prompt");
    const overridePath = await writeProfile(userDir, "override.md", "name: shared\ndescription: user replacement\nuse-worktree: true", "User prompt");

    const catalog = loadProfileCatalog({ bundledDir, userDir });
    assert.deepEqual(Object.keys(catalog), ["alpha", "shared", "zeta"]);
    assert.deepEqual(catalog.shared, {
      name: "shared",
      description: "user replacement",
      useWorktree: true,
      systemPrompt: "User prompt",
      filePath: overridePath,
    });
    assert.equal(catalog.shared?.tools, undefined);
    assert.equal(catalog.shared?.thinking, undefined);
    assert.equal(catalog.alpha?.model, "provider/model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery ignores README, non-Markdown entries, directories, and symlinks", async () => {
  const { root, bundledDir, userDir } = await directories();
  try {
    await writeProfile(bundledDir, "valid.md", minimal("valid"));
    await writeFile(join(bundledDir, "README.md"), markdown("not: a profile", "ignored"));
    await writeFile(join(bundledDir, "profile.txt"), markdown(minimal("text")));
    await mkdir(join(bundledDir, "directory.md"));
    await symlink(join(bundledDir, "valid.md"), join(bundledDir, "linked.md"));
    assert.deepEqual(Object.keys(loadProfileCatalog({ bundledDir, userDir })), ["valid"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-layer duplicates fail with both paths while cross-layer replacement succeeds", async () => {
  const { root, bundledDir, userDir } = await directories();
  try {
    const first = await writeProfile(bundledDir, "one.md", minimal("duplicate"));
    const second = await writeProfile(bundledDir, "two.md", minimal("duplicate"));
    assert.throws(
      () => loadProfileCatalog({ bundledDir, userDir }),
      (error: Error) => error.message.includes(first) && error.message.includes(second),
    );
    await rm(second);
    await mkdir(userDir);
    await writeProfile(userDir, "replacement.md", minimal("duplicate"), "replacement");
    assert.equal(loadProfileCatalog({ bundledDir, userDir }).duplicate?.systemPrompt, "replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile-name validation accepts only safe bounded lowercase kebab-case", () => {
  for (const value of ["a", "a1", "a-b", "a".repeat(64), "scout"]) assert.equal(isProfileName(value), true, value);
  for (const value of ["", "A", "-a", "a-", "a--b", "a_b", "a/b", "a.b", "a b", "a\nheader", "a".repeat(65), null, 1]) {
    assert.equal(isProfileName(value), false, String(value));
  }
});

test("malformed YAML and every malformed contract report the exact profile path", async (context) => {
  const cases: Array<{ name: string; content: string; message: RegExp }> = [
    { name: "yaml", content: "---\nname: [\n---\nprompt", message: /unexpected end|flow sequence/i },
    { name: "no frontmatter", content: "prompt only", message: /name must be/ },
    { name: "unterminated frontmatter", content: "---\nname: test\nprompt", message: /name must be/ },
    { name: "scalar frontmatter", content: "---\nvalue\n---\nprompt", message: /frontmatter must be a mapping/ },
    { name: "array frontmatter", content: "---\n- value\n---\nprompt", message: /frontmatter must be a mapping/ },
    { name: "unknown key", content: markdown(`${minimal("test")}\nextra: true`), message: /unknown frontmatter key/ },
    { name: "bad name", content: markdown("name: Bad\ndescription: test\nuse-worktree: false"), message: /lowercase kebab-case/ },
    { name: "empty description", content: markdown("name: test\ndescription: '  '\nuse-worktree: false"), message: /description must be/ },
    { name: "long description", content: markdown(`name: test\ndescription: ${"x".repeat(MAX_PROFILE_DESCRIPTION_LENGTH + 1)}\nuse-worktree: false`), message: /at most/ },
    { name: "non-boolean worktree", content: markdown("name: test\ndescription: test\nuse-worktree: 'false'"), message: /use-worktree must be a boolean/ },
    { name: "empty body", content: markdown(minimal("test"), "   "), message: /body must be/ },
    { name: "non-array tools", content: markdown(`${minimal("test")}\ntools: read`), message: /tools must be/ },
    { name: "empty tools", content: markdown(`${minimal("test")}\ntools: []`), message: /tools must be/ },
    { name: "duplicate tools", content: markdown(`${minimal("test")}\ntools: [read, read]`), message: /tools must be/ },
    { name: "invalid tool", content: markdown(`${minimal("test")}\ntools: ['bad tool']`), message: /tools must be/ },
    { name: "empty model", content: markdown(`${minimal("test")}\nmodel: '  '`), message: /model must be/ },
    { name: "bad thinking", content: markdown(`${minimal("test")}\nthinking: extreme`), message: /thinking must be one of/ },
  ];

  for (const entry of cases) await context.test(entry.name, async () => {
    const { root, bundledDir, userDir } = await directories();
    const path = join(bundledDir, "invalid.md");
    try {
      await writeFile(path, entry.content);
      assert.throws(
        () => loadProfileCatalog({ bundledDir, userDir }),
        (error: Error) => error.message.includes(path) && entry.message.test(error.message),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("all supported thinking values, optional controls, and CRLF parse without coercion", async () => {
  const { root, bundledDir, userDir } = await directories();
  try {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const [index, thinking] of levels.entries()) {
      const name = `level-${index}`;
      const content = markdown(`${minimal(name)}\ntools: [read, custom_tool]\nmodel: provider/model\nthinking: ${thinking}`, " Prompt ")
        .replaceAll("\n", "\r\n");
      await writeFile(join(bundledDir, `${name}.md`), content);
    }
    const catalog = loadProfileCatalog({ bundledDir, userDir });
    assert.deepEqual(Object.values(catalog).map((profile) => profile.thinking), levels);
    assert.ok(Object.values(catalog).every((profile) => profile.systemPrompt === "Prompt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch controls prefer profile values, inherit parent values, and omit absent tool/model flags", () => {
  const profile: Profile = Object.freeze({
    name: "custom",
    description: "custom",
    useWorktree: false,
    systemPrompt: "Prompt",
    filePath: "/profiles/custom.md",
  });
  const inherited = buildPiLaunch(profile, { model: "parent/model", thinking: "medium" }, "run-12345678", "/sessions", "child", "/artifact.md");
  assert.deepEqual(inherited.argv, [
    "pi", "--session-dir", "/sessions", "--session-id", "child", "--name", "custom-12345678",
    "--model", "parent/model", "--thinking", "medium",
    "--append-system-prompt", "Prompt\n\nArchive: /artifact.md. The extension writes this file automatically. Never edit it. After compaction or uncertainty, read it before relying on earlier parent instructions or your prior results.",
  ]);
  assert.deepEqual(inherited.env, { PI_HERDR_SUBAGENT: "1" });

  const explicit: Profile = Object.freeze({
    ...profile,
    tools: Object.freeze(["read", "grep"]),
    model: "profile/model",
    thinking: "high",
  });
  const overridden = buildPiLaunch(explicit, { model: "parent/model", thinking: "low" }, "run-x", "/sessions", "child", "/artifact.md");
  assert.deepEqual(overridden.argv.slice(7, -2), ["--model", "profile/model", "--thinking", "high", "--tools", "read,grep"]);

  const unavailable = buildPiLaunch(profile, { thinking: "off" }, "run-x", "/sessions", "child", "/artifact.md");
  assert.equal(unavailable.argv.includes("--model"), false);
  assert.equal(unavailable.argv.includes("--tools"), false);
});
