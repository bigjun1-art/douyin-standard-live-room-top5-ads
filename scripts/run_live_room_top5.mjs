#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mutateLiveRoomPayload, selectOfficialTop5, verifyLiveRoomReadback } from "./live_room_core.mjs";
import { assertDescending, parseAnalyticsCells, resolveRankingRows } from "./source_core.mjs";

const EVAL = fileURLToPath(new URL("./applescript_eval.sh", import.meta.url));
const SELF_TEST = fileURLToPath(new URL("./self_test.mjs", import.meta.url));

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { timeout: 45, dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--self-test") out.selfTest = true;
    else if (argv[i] === "--execute") out.dryRun = false;
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--config") out.config = argv[++i];
    else if (argv[i] === "--timeout") out.timeout = Number(argv[++i]);
    else fail(`unknown argument ${argv[i]}`);
  }
  if (!out.selfTest && !out.config) fail("--config is required");
  if (!Number.isFinite(out.timeout) || out.timeout < 10) fail("--timeout must be at least 10 seconds");
  return out;
}

function validateConfig(cfg) {
  assert(["create", "update"].includes(cfg.operation), "operation must be create or update");
  assert(/^\d+$/.test(String(cfg.advertiserId || "")), "advertiserId must be numeric");
  assert(/^\d{8}$/.test(String(cfg.businessDate || "")), "businessDate must be YYYYMMDD");
  cfg.gmvCount ??= 5;
  cfg.vvCount ??= 5;
  assert(cfg.gmvCount === 5 && cfg.vvCount === 5, "this skill requires GMV Top5 and VV Top5");
  assert(String(cfg.officialAccountId || ""), "officialAccountId is required");
  assert(String(cfg.currentProjectName || "") && String(cfg.projectName || ""), "currentProjectName/projectName are required");
  assert(String(cfg.currentUnitName || "") && String(cfg.unitName || ""), "currentUnitName/unitName are required");
  assert(cfg.projectName.includes(cfg.businessDate) && cfg.unitName.includes(cfg.businessDate), "project and unit names must contain businessDate");
  assert(!/_复制/.test(cfg.projectName + cfg.unitName), "copied suffix is not allowed in final names");
  cfg.rankings ??= { gmv: [], vv: [] };
  assert(Array.isArray(cfg.rankings.gmv) && Array.isArray(cfg.rankings.vv), "rankings.gmv/vv must be arrays");
  assert((cfg.rankings.gmv.length === 0) === (cfg.rankings.vv.length === 0), "supply both rankings or neither");
  cfg.analytics ??= {};
  cfg.analytics.pathContains ??= "/flow/content/my/overview";
  cfg.analytics.groupId ??= "auto";
  cfg.analytics.candidateLimit ??= 30;
  cfg.analytics.maxPages ??= 20;
  assert(/^\d+$|^auto$/.test(String(cfg.analytics.groupId)), "analytics.groupId must be numeric or auto");
  assert(Number.isInteger(cfg.analytics.candidateLimit) && cfg.analytics.candidateLimit >= 10, "analytics.candidateLimit must be at least 10");
  assert(Number.isInteger(cfg.analytics.maxPages) && cfg.analytics.maxPages >= 1, "analytics.maxPages must be positive");
  cfg.materialCaptureButtonText ??= "添加视频";
  assert(Array.isArray(cfg.protectedPromotionIds || []), "protectedPromotionIds must be an array");
  cfg.protectedPromotionIds ??= [];
  assert(cfg.tab?.pathContains && /^\/[^\s]*$/.test(cfg.tab.pathContains), "tab.pathContains is required");
  if (cfg.operation === "update") assert(/^\d+$/.test(String(cfg.promotionId || "")), "promotionId is required for update");
  return cfg;
}

function analyticsEval(cfg, code) {
  const raw = execFileSync(EVAL, [
    "--host", "www.life-data.cn", "--identity-key", "groupid",
    "--identity-value", String(cfg.analytics.groupId), "--path-contains", cfg.analytics.pathContains,
    "--code", code,
  ], { encoding: "utf8", maxBuffer: 24 * 1024 * 1024 }).trim();
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || "analytics AppleScript evaluation failed");
  return parsed.result;
}

function pollWith(evalFn, stateKey, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let state;
  while (Date.now() < deadline) {
    sleep(350);
    state = evalFn(`window[${JSON.stringify(stateKey)}]`);
    if (state?.status === "done") return state.result;
    if (state?.status === "error") throw new Error(state.error || "browser job failed");
  }
  throw new Error(`browser job timed out; last=${JSON.stringify(state)}`);
}

function browserRankingJob(args) {
  const { stateKey, officialAccountId, candidateLimit, maxPages, expectedGroupId } = args;
  window[stateKey] = { status: "running" };
  (async () => {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    check(location.origin === "https://www.life-data.cn", "ANALYTICS_ORIGIN_MISMATCH");
    const groupId = new URL(location.href).searchParams.get("groupid") || "";
    if (expectedGroupId !== "auto") check(groupId === String(expectedGroupId), "ANALYTICS_GROUP_MISMATCH");
    check(new URL(location.href).searchParams.get("secondTab") === "VideoAnalysis", "VIDEO_ANALYSIS_TAB_REQUIRED");
    const visible = (el) => el && el.getClientRects().length > 0;
    const waitFor = async (fn, message, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise((r) => setTimeout(r, 150)); }
      throw new Error(message);
    };
    const exactText = (text) => [...document.querySelectorAll("button,span,div")].filter((x) => visible(x) && (x.innerText || "").trim() === text);
    const period = exactText("近7日").sort((a, b) => a.children.length - b.children.length)[0];
    check(period, "NEAR_7_DAYS_CONTROL_MISSING");
    period.click();
    await new Promise((r) => setTimeout(r, 700));
    const dateMatch = document.body.innerText.match(/周期:\s*\n?\s*(\d{4}-\d{2}-\d{2})\s*～\s*(\d{4}-\d{2}-\d{2})/);
    check(dateMatch, "NEAR_7_DAYS_RANGE_MISSING");

    const pageSizeInput = document.querySelector(".byted-pager-page-size-select input");
    if (pageSizeInput && pageSizeInput.value !== "100条/页") {
      pageSizeInput.click();
      const option = await waitFor(() => exactText("100条/页").sort((a, b) => a.children.length - b.children.length)[0], "PAGE_SIZE_100_MISSING", 2500).catch(() => null);
      if (option) { option.click(); await new Promise((r) => setTimeout(r, 700)); }
    }
    const pageSize = Number((document.querySelector(".byted-pager-page-size-select input")?.value || "10").match(/\d+/)?.[0] || 10);
    const read = (page) => {
      const headers = [...document.querySelectorAll("table th")].map((x) => (x.innerText || "").trim());
      return [...document.querySelectorAll("table tbody tr")].map((tr, index) => ({
        rank: (page - 1) * pageSize + index + 1,
        cells: [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").trim()), headers,
      }));
    };
    const metricValue = (row, metric) => {
      const i = row.headers.findIndex((x) => metric === "gmv" ? /视频总成交价值/.test(x) : /视频播放次数/.test(x));
      return Number(String(row.cells[i] || "0").replace(/[¥￥,\s]/g, "")) || 0;
    };
    const isDescending = (rows, metric) => rows.every((row, i) => i === 0 || metricValue(rows[i - 1], metric) >= metricValue(row, metric));
    const firstPage = async () => {
      const pager = document.querySelector(".byted-pager"); check(pager, "PAGER_MISSING");
      const one = [...pager.querySelectorAll("li.byted-pager-item")].find((x) => (x.innerText || "").trim() === "1");
      check(one, "FIRST_PAGE_MISSING");
      if (!one.classList.contains("byted-pager-item-checked")) { one.click(); await waitFor(() => document.querySelector(".byted-pager-item-checked")?.innerText.trim() === "1", "FIRST_PAGE_TIMEOUT"); await new Promise((r) => setTimeout(r, 350)); }
    };
    const collectMetric = async (metric) => {
      await firstPage();
      const header = [...document.querySelectorAll("table th")].filter((x) => metric === "gmv" ? /视频总成交价值/.test(x.innerText || "") : /视频播放次数/.test(x.innerText || ""));
      check(header.length === 1, `METRIC_HEADER_NOT_UNIQUE ${metric}`);
      let rows = read(1);
      for (let attempt = 0; attempt < 3 && !isDescending(rows, metric); attempt += 1) {
        header[0].click(); await new Promise((r) => setTimeout(r, 650)); rows = read(1);
      }
      check(isDescending(rows, metric), `METRIC_NOT_DESCENDING ${metric}`);
      const out = [];
      for (let page = 1; page <= maxPages; page += 1) {
        rows = read(page);
        for (const row of rows) {
          const info = String(row.cells[0] || "");
          if (info.includes(` ${officialAccountId}\n`) || info.includes(` ${officialAccountId}\r\n`)) out.push(row);
        }
        if (out.length >= candidateLimit) break;
        const pager = document.querySelector(".byted-pager");
        const items = [...pager.querySelectorAll("li.byted-pager-item")];
        const next = items.at(-1);
        if (!next || /disabled/.test(next.className)) break;
        const before = document.querySelector(".byted-pager-item-checked")?.innerText.trim();
        next.click();
        await waitFor(() => document.querySelector(".byted-pager-item-checked")?.innerText.trim() !== before, `NEXT_PAGE_TIMEOUT ${metric}`);
        await new Promise((r) => setTimeout(r, 300));
      }
      check(out.length >= 10, `INSUFFICIENT_OFFICIAL_RANKING_ROWS ${metric} count=${out.length}`);
      return out.slice(0, candidateLimit);
    };
    const gmv = await collectMetric("gmv");
    const vv = await collectMetric("vv");
    window[stateKey] = { status: "done", result: { groupId, dateRange: { start: dateMatch[1], end: dateMatch[2] }, pageSize, gmv, vv } };
  })().catch((error) => { window[stateKey] = { status: "error", error: String(error?.stack || error) }; });
  return { started: true, stateKey };
}

function browserMaterialResolveJob(args) {
  const { configKey, sourceKey, resultKey, stateKey } = args;
  const cfg = JSON.parse(localStorage.getItem(configKey) || "null");
  const source = JSON.parse(localStorage.getItem(sourceKey) || "null");
  window[stateKey] = { status: "running" };
  const restores = [];
  (async () => {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const captures = [];
    const record = async (url, body, response) => {
      if (!/\/api\/lamp\/pc\/v2\/agw\/creative\/getTradeItemList(?:\?|$)/.test(String(url))) return;
      let json = null; try { json = await response.clone().json(); } catch (_) {}
      captures.push({ url: new URL(String(url), location.origin).pathname + new URL(String(url), location.origin).search, body: typeof body === "string" ? JSON.parse(body || "null") : body, json });
    };
    const install = (w) => {
      try {
        if (!w || typeof w.fetch !== "function" || w.__liveTop5MaterialCapture) return;
        const originalFunction = w.fetch, original = w.fetch.bind(w);
        w.__liveTop5MaterialCapture = true;
        w.fetch = async function(input, init = {}) {
          const response = await original(input, init);
          let body = init?.body;
          if (body == null && input && typeof input.clone === "function") { try { body = await input.clone().text(); } catch (_) {} }
          await record(String(input?.url || input || ""), body, response);
          return response;
        };
        restores.push(() => { w.fetch = originalFunction; delete w.__liveTop5MaterialCapture; });
      } catch (_) {}
    };
    install(window); for (const f of document.querySelectorAll("iframe")) { try { install(f.contentWindow); } catch (_) {} }
    const text = String(cfg.materialCaptureButtonText || "添加视频");
    const buttons = [...document.querySelectorAll("button")].filter((x) => (x.innerText || "").trim() === text && !x.disabled && x.getClientRects().length);
    check(buttons.length === 1, `ADD_VIDEO_BUTTON_NOT_UNIQUE count=${buttons.length}`);
    buttons[0].click();
    for (let i = 0; i < 50 && !captures.length; i += 1) await new Promise((r) => setTimeout(r, 200));
    for (const fn of restores) fn();
    check(captures.length, "GET_TRADE_ITEM_LIST_CAPTURE_MISSING");
    const cap = captures.find((x) => Array.isArray(x.json?.data?.videoList)) || captures[0];
    check(cap.body && Array.isArray(cap.json?.data?.videoList), "GET_TRADE_ITEM_LIST_SCHEMA_CHANGED");
    check("startTime" in cap.body && "endTime" in cap.body, "MATERIAL_DATE_FIELDS_CHANGED");
    const publishes = [...source.gmv, ...source.vv].map((x) => String(x.publish || "")).filter((x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x));
    check(publishes.length, "SOURCE_PUBLISH_TIMES_MISSING");
    const dates = publishes.map((x) => x.slice(0, 10)).sort();
    const sourceStart = String(Date.parse(`${dates[0]}T00:00:00+08:00`) / 1000);
    const sourceEnd = String(Date.parse(`${dates.at(-1)}T23:59:59+08:00`) / 1000);
    let videos = [], cursor = "0", more = true;
    for (let page = 0; more && page < 20; page += 1) {
      const body = { ...cap.body, cursor: String(cursor || "0"), pageSize: 100, startTime: sourceStart, endTime: sourceEnd };
      let r = await fetch(cap.url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      let j = await r.json();
      if (Number(j.status_code ?? j.code) === 40010) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        r = await fetch(cap.url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        j = await r.json();
      }
      check(r.ok && Number(j.status_code ?? j.code) === 0, `MATERIAL_PAGE_FAILED page=${page + 1}`);
      videos.push(...(j.data?.videoList || [])); cursor = j.data?.cursor; more = Boolean(j.data?.hasMore);
      if (!cursor) break;
    }
    videos = [...new Map(videos.map((x) => [String(x.itemId || x.aweme_item_id || ""), x])).values()].filter((x) => x.itemId || x.aweme_item_id);
    localStorage.setItem(resultKey, JSON.stringify({ source, videos, capture: { url: cap.url, count: videos.length } }));
    const cancel = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === "取消" && x.getClientRects().length);
    if (cancel) cancel.click();
    window[stateKey] = { status: "done", result: { materialCount: videos.length, capturedUrl: cap.url } };
  })().catch((error) => {
    for (const fn of restores) { try { fn(); } catch (_) {} }
    window[stateKey] = { status: "error", error: String(error?.stack || error) };
  });
  return { started: true, stateKey };
}

function appleEval(cfg, code) {
  const raw = execFileSync(EVAL, [
    "--host", "localads.chengzijianzhan.cn",
    "--identity-key", "advid",
    "--identity-value", String(cfg.advertiserId),
    "--path-contains", cfg.tab.pathContains,
    "--code", code,
  ], { encoding: "utf8", maxBuffer: 24 * 1024 * 1024 }).trim();
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error || "AppleScript evaluation failed");
  return parsed.result;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function storeLarge(cfg, key, value) {
  const source = JSON.stringify(value);
  appleEval(cfg, `localStorage.setItem(${JSON.stringify(key)},"");({stored:0})`);
  for (let offset = 0; offset < source.length; offset += 24000) {
    const chunk = source.slice(offset, offset + 24000);
    appleEval(cfg, `(()=>{const k=${JSON.stringify(key)};localStorage.setItem(k,(localStorage.getItem(k)||"")+${JSON.stringify(chunk)});return {stored:(localStorage.getItem(k)||"").length}})()`);
  }
}

function readLarge(cfg, key) {
  const length = Number(appleEval(cfg, `(localStorage.getItem(${JSON.stringify(key)})||"").length`));
  assert(length > 0, `browser value ${key} is empty`);
  let source = "";
  for (let offset = 0; offset < length; offset += 24000) {
    source += String(appleEval(cfg, `(localStorage.getItem(${JSON.stringify(key)})||"").slice(${offset},${offset + 24000})`));
  }
  return JSON.parse(source);
}

function poll(cfg, stateKey, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let state;
  while (Date.now() < deadline) {
    sleep(350);
    state = appleEval(cfg, `window[${JSON.stringify(stateKey)}]`);
    if (state?.status === "done") return state.result;
    if (state?.status === "error") throw new Error(state.error || "browser job failed");
  }
  throw new Error(`browser job timed out; last=${JSON.stringify(state)}`);
}

function browserCaptureJob(args) {
  const { configKey, capturedKey, stateKey } = args;
  const cfg = JSON.parse(localStorage.getItem(configKey) || "null");
  window[stateKey] = { status: "running" };
  (async () => {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    check(location.origin === "https://localads.chengzijianzhan.cn", "ORIGIN_MISMATCH");
    check(new URL(location.href).searchParams.get("advid") === String(cfg.advertiserId), "ADVERTISER_MISMATCH");
    const detail = async (id) => {
      const r = await fetch(`/api/lamp/pc/v2/superior/ad/promotion/detail?advid=${cfg.advertiserId}&promotion_id=${id}`, { credentials: "include", cache: "no-store" });
      const j = await r.json();
      check(r.ok && Number(j.code ?? j.status_code) === 0, `DETAIL_FAILED ${id}`);
      const row = j.data?.[String(id)];
      check(row && String(row.id) === String(id), `DETAIL_ID_MISMATCH ${id}`);
      return { id: String(id), name: String(row.name || ""), ids: (row.material_group?.video_material_info || []).map((x) => String(x.aweme_item_id || "")).filter(Boolean) };
    };
    const ids = [...new Set([...(cfg.protectedPromotionIds || []).map(String), ...(cfg.operation === "update" ? [String(cfg.promotionId)] : [])])];
    const before = [];
    for (const id of ids) before.push(await detail(id));
    if (cfg.operation === "update") {
      const target = before.find((x) => x.id === String(cfg.promotionId));
      check(target && target.name === cfg.currentUnitName, "TARGET_UNIT_NAME_MISMATCH");
    }
    if (localStorage.getItem(capturedKey)) {
      window[stateKey] = { status: "done", result: { before, captured: false, supplied: true } };
      return;
    }

    const businessIso = `${cfg.businessDate.slice(0, 4)}-${cfg.businessDate.slice(4, 6)}-${cfg.businessDate.slice(6, 8)}`;
    const setNativeValue = (input, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor.set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    };
    const startInputs = [...document.querySelectorAll("input")].filter((x) => /开始日期/.test(x.placeholder || ""));
    for (const input of startInputs) if (/^\d{4}-\d{2}-\d{2}$/.test(input.value || "") && input.value < businessIso) setNativeValue(input, businessIso);
    const endInputs = [...document.querySelectorAll("input")].filter((x) => /结束日期/.test(x.placeholder || ""));
    for (const input of endInputs) check(!/^\d{4}-\d{2}-\d{2}$/.test(input.value || "") || input.value >= businessIso || Boolean(cfg.endDate), "STALE_END_DATE; supply endDate");
    if (cfg.endDate) for (const input of endInputs) setNativeValue(input, cfg.endDate);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const restore = [];
    const install = (w) => {
      try {
        if (!w || typeof w.fetch !== "function" || w.__liveTop5CaptureInstalled) return;
        const originalFunction = w.fetch;
        const original = w.fetch.bind(w);
        w.__liveTop5CaptureInstalled = true;
        w.fetch = async function(input, init = {}) {
          const url = String(input?.url || input || "");
          const endpoint = cfg.operation === "create" ? "createPromote" : "updatePromote";
          if (new RegExp(`/api/lamp/pc/v2/ad/${endpoint}(?:\\?|$)`).test(url)) {
            let body = init?.body;
            if (body == null && input && typeof input.clone === "function") body = await input.clone().text();
            if (typeof body !== "string") body = JSON.stringify(body);
            localStorage.setItem(capturedKey, JSON.stringify({ url: new URL(url, location.origin).pathname + new URL(url, location.origin).search, body: JSON.parse(body || "null") }));
            return new w.Response(JSON.stringify({ status_code: 0, message: "captured_without_submit", data: {} }), { status: 200, headers: { "content-type": "application/json" } });
          }
          return original(input, init);
        };
        restore.push(() => { w.fetch = originalFunction; delete w.__liveTop5CaptureInstalled; });
      } catch (_) {}
    };
    install(window);
    for (const frame of document.querySelectorAll("iframe")) { try { install(frame.contentWindow); } catch (_) {} }
    const buttonText = String(cfg.captureButtonText || "保存投放");
    const buttons = [...document.querySelectorAll("button")].filter((x) => (x.innerText || "").trim() === buttonText && !x.disabled && x.getClientRects().length);
    check(buttons.length === 1, `SAVE_BUTTON_NOT_UNIQUE count=${buttons.length}`);
    buttons[0].click();
    for (let i = 0; i < 40 && !localStorage.getItem(capturedKey); i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
    for (const fn of restore) fn();
    check(Boolean(localStorage.getItem(capturedKey)), document.body.innerText.includes("有些项目填写错误") ? "FORM_VALIDATION_BLOCKED" : "REQUEST_CAPTURE_MISSING");
    window[stateKey] = { status: "done", result: { before, captured: true, supplied: false } };
  })().catch((error) => { window[stateKey] = { status: "error", error: String(error?.stack || error) }; });
  return { started: true, stateKey };
}

function browserSubmitJob(args) {
  const { configKey, mutationKey, stateKey, dryRun } = args;
  const cfg = JSON.parse(localStorage.getItem(configKey) || "null");
  const mutation = JSON.parse(localStorage.getItem(mutationKey) || "null");
  window[stateKey] = { status: "running" };
  (async () => {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    if (dryRun) { window[stateKey] = { status: "done", result: { dryRun: true, submitted: false } }; return; }
    const response = await fetch(mutation.url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(mutation.body) });
    const json = await response.json().catch(() => null);
    check(response.ok && Number(json?.status_code ?? json?.code) === 0, `SUBMIT_FAILED HTTP=${response.status} body=${JSON.stringify(json)}`);
    const collect = (node, pattern, out = []) => {
      if (!node || typeof node !== "object") return out;
      for (const [key, value] of Object.entries(node)) {
        if (pattern.test(key)) {
          if (Array.isArray(value)) {
            for (const item of value) if (/^\d+$/.test(String(item))) out.push(String(item));
          } else if (/^\d+$/.test(String(value))) {
            out.push(String(value));
          }
        }
        if (value && typeof value === "object") collect(value, pattern, out);
      }
      return [...new Set(out)];
    };
    const promotionId = cfg.operation === "update" ? String(cfg.promotionId) : collect(json, /promotion.*id|promotionids/i)[0];
    check(/^\d+$/.test(String(promotionId || "")), `PROMOTION_ID_MISSING ${JSON.stringify(json)}`);
    const readDetail = async () => {
      const r = await fetch(`/api/lamp/pc/v2/superior/ad/promotion/detail?advid=${cfg.advertiserId}&promotion_id=${promotionId}`, { credentials: "include", cache: "no-store" });
      const j = await r.json();
      check(r.ok && Number(j.code ?? j.status_code) === 0, "DETAIL_READ_FAILED");
      const row = j.data?.[String(promotionId)];
      check(row, "DETAIL_EMPTY");
      const dateOf = (value) => {
        if (value == null || value === "") return "";
        if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10);
        const n = Number(value); if (!Number.isFinite(n) || n < 1_500_000_000) return "";
        return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(n > 10_000_000_000 ? n : n * 1000));
      };
      const find = (node, pattern) => {
        if (!node || typeof node !== "object") return undefined;
        for (const [key, value] of Object.entries(node)) if (pattern.test(key) && value != null && typeof value !== "object") return value;
        for (const value of Object.values(node)) { const hit = find(value, pattern); if (hit !== undefined) return hit; }
      };
      return {
        id: String(promotionId), projectId: String(row.project_id || ""), name: String(row.name || ""),
        ids: (row.material_group?.video_material_info || []).map((x) => String(x.aweme_item_id || "")).filter(Boolean),
        startDate: dateOf(find(row, /^start(_|).*?(date|time)|^startTime$/i)), endDate: dateOf(find(row, /^end(_|).*?(date|time)|^endTime$/i)),
        budget: find(row, /^(base_)?budget$/i), bid: find(row, /^bid$/i),
      };
    };
    let row;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      row = await readDetail();
      if (row.name === cfg.unitName && row.ids.length === cfg.gmvCount + cfg.vvCount) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
    check(row.projectId, "PROJECT_ID_MISSING_IN_DETAIL");
    const pr = await fetch(`/api/lamp/pc/v2/superior/promote/projects/detail?advid=${cfg.advertiserId}&project_ids=${row.projectId}`, { credentials: "include", cache: "no-store" });
    const pj = await pr.json();
    check(pr.ok && Number(pj.code ?? pj.status_code) === 0, "PROJECT_DETAIL_FAILED");
    const project = pj.data?.[row.projectId] || pj.data?.detail || pj.data;
    row.projectName = String(project?.name || project?.project_name || project?.projectName || "");
    window[stateKey] = { status: "done", result: { row, response: { code: json?.status_code ?? json?.code } } };
  })().catch((error) => { window[stateKey] = { status: "error", error: String(error?.stack || error) }; });
  return { started: true, stateKey };
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) {
  execFileSync(process.execPath, [SELF_TEST], { stdio: "inherit" });
  console.log(JSON.stringify({ ok: true, runner: "run_live_room_top5.mjs" }));
  process.exit(0);
}

try {
  const cfg = validateConfig(JSON.parse(fs.readFileSync(args.config, "utf8")));
  if (!args.dryRun) assert(String(cfg.confirmAdvertiserId || "") === String(cfg.advertiserId), "--execute requires config.confirmAdvertiserId matching advertiserId");
  const prefix = `__douyinLiveTop5_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const configKey = `${prefix}_config`;
  const sourceKey = `${prefix}_source`;
  const materialKey = `${prefix}_materials`;
  const capturedKey = `${prefix}_captured`;
  const mutationKey = `${prefix}_mutation`;
  const rankingStateKey = `${prefix}_ranking_state`;
  const materialStateKey = `${prefix}_material_state`;
  const captureStateKey = `${prefix}_capture_state`;
  const submitStateKey = `${prefix}_submit_state`;
  storeLarge(cfg, configKey, cfg);
  let sourceSummary = { suppliedRankings: cfg.rankings.gmv.length > 0 };
  if (!cfg.rankings.gmv.length) {
    const rankingStarted = analyticsEval(cfg, `(${browserRankingJob.toString()})(${JSON.stringify({
      stateKey: rankingStateKey,
      officialAccountId: String(cfg.officialAccountId),
      candidateLimit: cfg.analytics.candidateLimit,
      maxPages: cfg.analytics.maxPages,
      expectedGroupId: String(cfg.analytics.groupId),
    })})`);
    assert(rankingStarted?.started, "ranking job did not start");
    const rawSource = pollWith((code) => analyticsEval(cfg, code), rankingStateKey, Math.max(args.timeout, 90));
    const parseMetric = (rows, metric) => rows.map((row) => ({
      ...parseAnalyticsCells(row.cells, row.headers, row.rank, cfg.officialAccountId),
      metric,
    }));
    const source = { gmv: parseMetric(rawSource.gmv, "gmv"), vv: parseMetric(rawSource.vv, "vv"), dateRange: rawSource.dateRange };
    assertDescending(source.gmv, "gmvValue", "gmv");
    assertDescending(source.vv, "vvValue", "vv");
    storeLarge(cfg, sourceKey, source);
    const materialStarted = appleEval(cfg, `(${browserMaterialResolveJob.toString()})(${JSON.stringify({ configKey, sourceKey, resultKey: materialKey, stateKey: materialStateKey })})`);
    assert(materialStarted?.started, "material resolver did not start");
    const materialSummary = poll(cfg, materialStateKey, Math.max(args.timeout, 90));
    const materialResult = readLarge(cfg, materialKey);
    cfg.rankings = {
      gmv: resolveRankingRows(source.gmv, materialResult.videos, cfg.officialAccountId),
      vv: resolveRankingRows(source.vv, materialResult.videos, cfg.officialAccountId),
    };
    sourceSummary = {
      suppliedRankings: false, analyticsGroupId: rawSource.groupId, dateRange: rawSource.dateRange,
      gmvCandidates: cfg.rankings.gmv.length, vvCandidates: cfg.rankings.vv.length,
      resolvedGmv: cfg.rankings.gmv.filter((x) => x.video && x.canDelivery).length,
      resolvedVv: cfg.rankings.vv.filter((x) => x.video && x.canDelivery).length,
      materialCount: materialSummary.materialCount,
    };
    storeLarge(cfg, configKey, cfg);
  }
  if (cfg.requestBody) {
    const endpoint = cfg.operation === "create" ? "createPromote" : "updatePromote";
    storeLarge(cfg, capturedKey, { url: cfg.requestUrl || `/api/lamp/pc/v2/ad/${endpoint}?advid=${cfg.advertiserId}`, body: cfg.requestBody });
  }
  const captureStarted = appleEval(cfg, `(${browserCaptureJob.toString()})(${JSON.stringify({ configKey, capturedKey, stateKey: captureStateKey })})`);
  assert(captureStarted?.started, "capture job did not start");
  const capture = poll(cfg, captureStateKey, args.timeout);
  const captured = readLarge(cfg, capturedKey);
  const endpoint = cfg.operation === "create" ? "createPromote" : "updatePromote";
  assert(new RegExp(`/api/lamp/pc/v2/ad/${endpoint}(?:\\?|$)`).test(captured.url), `captured URL is not ${endpoint}`);
  const protectedSet = new Set(cfg.protectedPromotionIds.map(String));
  const protectedIds = capture.before.filter((x) => protectedSet.has(String(x.id))).flatMap((x) => x.ids);
  const selected = selectOfficialTop5({
    gmvQueue: cfg.rankings.gmv, vvQueue: cfg.rankings.vv,
    gmvCount: cfg.gmvCount, vvCount: cfg.vvCount,
    officialAccountId: cfg.officialAccountId, protectedIds,
  });
  const mutation = mutateLiveRoomPayload(captured.body, cfg, selected.rows);
  storeLarge(cfg, mutationKey, { url: captured.url, body: mutation.body });
  const submitStarted = appleEval(cfg, `(${browserSubmitJob.toString()})(${JSON.stringify({ configKey, mutationKey, stateKey: submitStateKey, dryRun: Boolean(args.dryRun) })})`);
  assert(submitStarted?.started, "submit job did not start");
  const result = poll(cfg, submitStateKey, args.timeout);
  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, source: sourceSummary, captured: capture.captured, selected: { gmv: selected.gmv.map((x) => x.rank), vv: selected.vv.map((x) => x.rank), ids: selected.ids }, skipped: selected.skipped, dateNormalization: mutation.dateResult }, null, 2));
  } else {
    const verified = verifyLiveRoomReadback(result.row, cfg, selected.rows);
    console.log(JSON.stringify({ ok: true, source: sourceSummary, ...verified, gmvRanks: selected.gmv.map((x) => x.rank), vvRanks: selected.vv.map((x) => x.rank), skipped: selected.skipped, startDate: result.row.startDate, endDate: result.row.endDate, budget: result.row.budget, bid: result.row.bid }, null, 2));
  }
  try { appleEval(cfg, `[${[configKey, sourceKey, materialKey, capturedKey, mutationKey].map((x) => JSON.stringify(x)).join(",")}].forEach(k=>localStorage.removeItem(k));true`); } catch {}
} catch (error) {
  fail(error?.stderr?.toString() || error?.message || String(error));
}
