#!/usr/bin/env node
import assert from "node:assert/strict";
import { mutateLiveRoomPayload, selectOfficialTop5, verifyLiveRoomReadback } from "./live_room_core.mjs";
import { assertDescending, parseAnalyticsCells, resolveRankingRows, shanghaiMinute } from "./source_core.mjs";

const official = "official-1";
const row = (rank, id, creatorId = official, role = "官号") => ({
  rank, creatorId, publish: "2026-08-09 12:00", role, canDelivery: true,
  video: { itemId: id, videoId: `vid-${id}`, title: `title-${id}`, authorUid: creatorId, duration: 12, width: 720, height: 1280, imageMode: 15, canDelivery: true, imageUrl: { uri: `uri-${id}`, urlList: [`https://img/${id}`] } },
});

const selected = selectOfficialTop5({
  gmvQueue: [row(1, "g1"), row(2, "g2"), row(3, "g3")],
  vvQueue: [row(1, "g1"), row(2, "v1"), row(3, "v2"), row(4, "v3")],
  gmvCount: 2, vvCount: 2, officialAccountId: official,
});
assert.deepEqual(selected.ids, ["g1", "g2", "v1", "v2"]);
assert(selected.skipped.some((x) => x.reason === "gmv_vv_duplicate"));
const filtered = selectOfficialTop5({
  gmvQueue: [row(1, "x", "other"), row(2, "g4")],
  vvQueue: [row(1, "z", official, "职人"), row(2, "v4")],
  gmvCount: 1, vvCount: 1, officialAccountId: official,
});
assert.deepEqual(filtered.ids, ["g4", "v4"]);
assert(filtered.skipped.some((x) => x.reason === "non_official"));
assert(filtered.skipped.some((x) => x.reason === "staff"));

const cfg = {
  operation: "create", businessDate: "20260810", gmvCount: 2, vvCount: 2,
  currentProjectName: "copy-project", projectName: "20260810_live-project",
  currentUnitName: "copy-unit", unitName: "20260810_live-unit",
};
const payload = {
  project: { name: "copy-project" },
  multiAdProxy: { promotionCreateInfo: { 0: {
    promotionCreateInfo: { Name: "copy-unit", StartTime: "2026-07-27" },
    materialGroupCreateInfo: { VideoMaterialList: [], TitleMaterialList: [], Keep: 1 },
    untouched: { budget: 303, bid: 0.21, region: "贵州省" },
  } } },
};
const mutated = mutateLiveRoomPayload(payload, cfg, selected.rows);
assert.equal(mutated.body.project.name, cfg.projectName);
assert.equal(mutated.body.multiAdProxy.promotionCreateInfo[0].promotionCreateInfo.Name, cfg.unitName);
assert.equal(mutated.body.multiAdProxy.promotionCreateInfo[0].promotionCreateInfo.StartTime, "2026-08-10");
assert.deepEqual(mutated.body.multiAdProxy.promotionCreateInfo[0].untouched, payload.multiAdProxy.promotionCreateInfo[0].untouched);
assert.equal(mutated.body.multiAdProxy.promotionCreateInfo[0].materialGroupCreateInfo.VideoMaterialList.length, 4);

const verified = verifyLiveRoomReadback({
  id: "p1", projectId: "pr1", name: cfg.unitName, projectName: cfg.projectName,
  startDate: "2026-08-10", ids: selected.ids,
}, cfg, selected.rows);
assert.equal(verified.uniqueVideoCount, 4);

const updateCfg = { ...cfg, operation: "update", promotionId: "9001" };
const updatePayload = {
  project: { name: "copy-project" },
  multiAdProxy: { promotionUpdateInfo: {
    0: { promotionUpdateInfo: { Id: "9001", Name: "copy-unit" }, materialGroupUpdateInfo: { VideoMaterialList: [], TitleMaterialList: [], Keep: 7 } },
    1: { promotionUpdateInfo: { Id: "9002", Name: "neighbor" }, materialGroupUpdateInfo: { VideoMaterialList: [{ Keep: true }], TitleMaterialList: [{ Keep: true }] } },
  } },
};
const updated = mutateLiveRoomPayload(updatePayload, updateCfg, selected.rows).body;
assert.equal(updated.multiAdProxy.promotionUpdateInfo[0].promotionUpdateInfo.Name, cfg.unitName);
assert.equal(updated.multiAdProxy.promotionUpdateInfo[0].materialGroupUpdateInfo.VideoMaterialList.length, 4);
assert.deepEqual(updated.multiAdProxy.promotionUpdateInfo[1], updatePayload.multiAdProxy.promotionUpdateInfo[1]);

const headers = ["视频信息", "视频总成交价值(元)", "视频直接成交金额", "视频种草价值(元)", "视频播放次数", "操作"];
const parsed = parseAnalyticsCells([
  "完整官号标题\n官号名称 official-1\n商家\n发布时间：2026/08/09 12:00",
  "¥1,234.00", "¥1,000.00", "¥234.00", "9,876", "查看详情",
], headers, 7, official);
assert.deepEqual({ rank: parsed.rank, title: parsed.title, name: parsed.name, creatorId: parsed.creatorId, publish: parsed.publish, gmvValue: parsed.gmvValue, vvValue: parsed.vvValue }, {
  rank: 7, title: "完整官号标题", name: "官号名称", creatorId: official, publish: "2026-08-09 12:00", gmvValue: 1234, vvValue: 9876,
});
const epoch = Date.parse("2026-08-09T12:00:00+08:00") / 1000;
assert.equal(shanghaiMinute(epoch), "2026-08-09 12:00");
const resolved = resolveRankingRows([parsed], [{
  itemId: "auto-1", videoId: "vid-auto-1", title: parsed.title, authorUid: "internal-official",
  createTime: epoch, duration: 18, width: 720, height: 1280, imageMode: 15, canDelivery: true,
  imageUrl: { uri: "uri-auto-1", urlList: ["https://img/auto-1"] }, userInfo: { uniqueId: official },
}], official);
assert.equal(resolved[0].video.itemId, "auto-1");
assert.equal(resolved[0].canDelivery, true);
assertDescending([{ v: 10 }, { v: 10 }, { v: 1 }], "v", "fixture");
assert.equal(resolveRankingRows([{ ...parsed, title: "missing" }], [], official)[0].reason, "missing_material");

console.log(JSON.stringify({ ok: true, tests: ["analytics-parse", "descending-guard", "material-resolve", "missing-backfill", "official-only", "gmv-first-vv-dedupe", "staff-guard", "create-payload", "update-payload", "neighbor-preserved", "start-date", "preserve-config", "readback"] }));
