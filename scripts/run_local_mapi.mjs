#!/usr/bin/env node

import fs from "node:fs";
import {parseLosslessJson, assertSafeNumbers, collectCursorPages} from "./mapi_pagination.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const OPERATIONS = Object.freeze({
  "project.create": { method: "POST", path: "/open_api/v3.0/local/project/create/" },
  "project.update": { method: "POST", path: "/open_api/v3.0/local/project/update/" },
  "project.detail": { method: "GET", path: "/open_api/v3.0/local/project/detail/" },
  "project.list": { method: "GET", path: "/open_api/v3.0/local/project/list/" },
  "promotion.create": { method: "POST", path: "/open_api/v3.0/local/promotion/create/" },
  "promotion.update": { method: "POST", path: "/open_api/v3.0/local/promotion/update/" },
  "promotion.detail": { method: "GET", path: "/open_api/v3.0/local/promotion/detail/" },
  "promotion.list": { method: "GET", path: "/open_api/v3.0/local/promotion/list/" },
  "report.project": { method: "GET", path: "/open_api/v3.0/local/report/project/get/" },
  "report.promotion": { method: "GET", path: "/open_api/v3.0/local/report/promotion/get/" },
  "report.material": { method: "GET", path: "/open_api/v3.0/local/report/material/get/" },
  "material.library.video": { method: "GET", path: "/open_api/v3.0/local/file/video/get/" },
  "material.aweme.video": { method: "GET", path: "/open_api/v3.0/local/file/video/aweme/get/" },
  "standard.project.detail": { method: "GET", path: "/open_api/v3.0/local/oc_project/get/" },
  "standard.project.materials": { method: "GET", path: "/open_api/v3.0/local/oc_material/get/" }
});

const UNSUPPORTED_CODES = new Set([40010, 40100, 40101, 403]);

function parseArgs(argv) {
  const out = { execute: false, selfTest: false, listOperations: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") out.execute = true;
    else if (arg === "--self-test") out.selfTest = true;
    else if (arg === "--list-operations") out.listOperations = true;
    else if (arg === "--config") out.config = argv[++i];
    else if (arg === "--output") out.output = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function valueAt(root, dotPath) {
  if (!dotPath) return root;
  return String(dotPath).split(".").reduce((value, key) => value == null ? undefined : value[key], root);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function checkAssertions(response, assertions = []) {
  for (const rule of assertions) {
    const actual = valueAt(response, rule.path);
    if (rule.type === "equals") {
      assert(stable(actual) === stable(rule.expected), `assert equals failed at ${rule.path}`);
    } else if (rule.type === "setEquals") {
      assert(Array.isArray(actual) && Array.isArray(rule.expected), `assert setEquals requires arrays at ${rule.path}`);
      const a = actual.map(v => stable(v)).sort();
      const b = rule.expected.map(v => stable(v)).sort();
      assert(stable(a) === stable(b), `assert setEquals failed at ${rule.path}`);
    } else if (rule.type === "empty") {
      assert(Array.isArray(actual) && actual.length === 0, `assert empty failed at ${rule.path}`);
    } else if (rule.type === "notEmpty") {
      const ok = actual != null && ((!Array.isArray(actual) && typeof actual !== "string") || actual.length > 0);
      assert(ok, `assert notEmpty failed at ${rule.path}`);
    } else {
      throw new Error(`unknown assertion type: ${rule.type}`);
    }
  }
}

function addQuery(url, query = {}) {
  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    url.searchParams.set(key, value);
  }
}

function compactData(data) {
  if (data == null || typeof data !== "object") return data;
  if (Array.isArray(data)) return { count: data.length };
  const out = {};
  for (const key of ["project_id", "promotion_id", "project_ids", "promotion_ids", "page_info", "paginationVerification"]) {
    if (key in data) out[key] = data[key];
  }
  if (Array.isArray(data.list)) out.listCount = data.list.length;
  return Object.keys(out).length ? out : { keys: Object.keys(data).sort() };
}

async function requestJson({ baseUrl, token, operation, query, body, retryReads = 2 }) {
  const spec = OPERATIONS[operation];
  assert(spec, `unknown operation: ${operation}`);
  const url = new URL(spec.path, baseUrl);
  addQuery(url, query);
  const options = {
    method: spec.method,
    headers: { "Access-Token": token, "Accept": "application/json" }
  };
  if (spec.method === "POST") {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body ?? {});
  }
  let lastError;
  for (let attempt = 0; attempt <= retryReads; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      let parsed;
      try { parsed = parseLosslessJson(text); } catch { throw new Error(`non-JSON response (HTTP ${response.status})`); }
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status}: ${parsed.message || "request failed"}`);
        err.status = response.status;
        err.apiCode = Number(parsed.code);
        throw err;
      }
      return parsed;
    } catch (error) {
      lastError = error;
      const transient = spec.method === "GET" && (error.status === 429 || error.status >= 500 || error.name === "TypeError");
      if (!transient || attempt === retryReads) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function runConfig(config, { execute = false, env = process.env } = {}) {
  assert(config && Array.isArray(config.steps) && config.steps.length > 0, "config.steps must be a non-empty array");
  assertSafeNumbers(config);
  const names = new Set();
  for (const step of config.steps) {
    assert(step.name && !names.has(step.name), `step name must be unique: ${step.name}`);
    names.add(step.name);
    assert(OPERATIONS[step.operation], `unknown operation: ${step.operation}`);
    if (OPERATIONS[step.operation].method === "POST") assert(execute, `write step ${step.name} requires --execute`);
  }
  const tokenEnv = config.accessTokenEnv || "OCEANENGINE_ACCESS_TOKEN";
  const token = env[tokenEnv];
  assert(typeof token === "string" && token.length >= 16, `missing access token environment variable: ${tokenEnv}`);
  const baseUrl = config.baseUrl || "https://api.oceanengine.com";
  const result = { status: "verified", baseUrl, steps: [] };
  for (const step of config.steps) {
    try {
      let response = await requestJson({ baseUrl, token, operation: step.operation, query: step.query, body: step.body });
      const code = Number(response.code ?? 0);
      if (code !== 0) {
        if (step.optional && UNSUPPORTED_CODES.has(code)) {
          result.steps.push({ name: step.name, operation: step.operation, status: "unsupported", code });
          continue;
        }
        throw Object.assign(new Error(`API code ${code}: ${response.message || "request failed"}`), { apiCode: code });
      }
      if (step.operation === "material.aweme.video" || step.pagination) {
        assert(OPERATIONS[step.operation].method === "GET", "pagination is read-only");
        const pagination = step.pagination || {};
        if (step.operation !== "material.aweme.video") assert(pagination.listPath && pagination.pageInfoPath && pagination.idKey, "explicit pagination schema required");
        response = await collectCursorPages(response, cursor => requestJson({baseUrl, token, operation:step.operation, query:{...step.query, [pagination.queryCursorKey || "cursor"]:cursor}}), pagination);
      }
      checkAssertions(response, step.assertions);
      result.steps.push({ name: step.name, operation: step.operation, status: "verified", data: step.resultMode === "full" ? response.data : compactData(response.data) });
    } catch (error) {
      const code = Number(error.apiCode || error.status || 0);
      if (step.optional && UNSUPPORTED_CODES.has(code)) {
        result.steps.push({ name: step.name, operation: step.operation, status: "unsupported", code });
        continue;
      }
      result.status = "failed";
      result.failedStep = step.name;
      result.error = String(error.message || error).replaceAll(token, "[REDACTED]");
      break;
    }
  }
  return result;
}

export function selfTest() {
  checkAssertions({ data: { id: 1, ids: ["2", "1"], rows: [] } }, [
    { type: "equals", path: "data.id", expected: 1 },
    { type: "setEquals", path: "data.ids", expected: ["1", "2"] },
    { type: "empty", path: "data.rows" },
    { type: "notEmpty", path: "data.ids" }
  ]);
  const url = new URL("/x", "https://api.oceanengine.com");
  addQuery(url, { ids: [1, 2], filtering: { name: "a" } });
  assert(url.searchParams.get("ids") === "[1,2]", "array query encoding failed");
  assert(url.searchParams.get("filtering") === '{"name":"a"}', "object query encoding failed");
  return { status: "ok", operationCount: Object.keys(OPERATIONS).length };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.listOperations) {
    process.stdout.write(`${JSON.stringify(OPERATIONS, null, 2)}\n`);
    return;
  }
  if (args.selfTest) {
    process.stdout.write(`${JSON.stringify(selfTest())}\n`);
    return;
  }
  assert(args.config, "--config is required");
  const configPath = path.resolve(args.config);
  const config = parseLosslessJson(fs.readFileSync(configPath, "utf8"));
  const result = await runConfig(config, { execute: args.execute });
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) fs.writeFileSync(path.resolve(args.output), rendered, { mode: 0o600 });
  process.stdout.write(rendered);
  if (result.status !== "verified") process.exitCode = 1;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`ERROR: ${String(error.message || error)}\n`);
    process.exitCode = 1;
  });
}
