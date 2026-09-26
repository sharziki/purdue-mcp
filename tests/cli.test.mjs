import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const run = (...args) => spawnSync(process.execPath, ["dist/cli.js", ...args], {
  encoding: "utf8",
  timeout: 5000,
});

test("CLI lists tools and exposes one schema", () => {
  const listed = run("list");
  assert.equal(listed.status, 0, listed.stderr);
  const tools = JSON.parse(listed.stdout);
  assert.ok(tools.length >= 30);
  assert.ok(tools.some((tool) => tool.name === "dining_menu"));

  const schema = run("schema", "dining_menu");
  assert.equal(schema.status, 0, schema.stderr);
  assert.equal(JSON.parse(schema.stdout).name, "dining_menu");
});

test("CLI rejects unknown tools and malformed arguments", () => {
  assert.notEqual(run("call", "not_a_tool", "{}").status, 0);
  assert.notEqual(run("call", "dining_menu", "[]").status, 0);
});
