import assert from "node:assert/strict";
import { OPERATIONS, checkAssertions, runConfig, selfTest } from "./run_local_mapi.mjs";

assert.equal(selfTest().status, "ok");
assert.equal(OPERATIONS["project.create"].path, "/open_api/v3.0/local/project/create/");
assert.equal(OPERATIONS["report.material"].method, "GET");

checkAssertions({ data: { ids: [3, 2, 1] } }, [
  { type: "setEquals", path: "data.ids", expected: [1, 2, 3] }
]);

await assert.rejects(
  runConfig({ steps: [{ name: "write", operation: "project.create", body: {} }] }, { execute: false, env: {} }),
  /requires --execute/
);

await assert.rejects(
  runConfig({ steps: [{ name: "read", operation: "project.detail", query: {} }] }, { execute: false, env: {} }),
  /missing access token environment variable/
);

process.stdout.write('{"status":"ok"}\n');
