import assert from "node:assert/strict";

export function itemId(row) {
  return String(row?.video?.itemId ?? row?.itemId ?? row?.aweme_item_id ?? "");
}

function assertCandidate(row) {
  assert(row && Number.isFinite(Number(row.rank)), "candidate rank is required");
  assert(String(row.creatorId || ""), `creatorId is required at rank ${row.rank}`);
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(row.publish || "")), `publish minute is invalid at rank ${row.rank}`);
}

function choose(queue, count, blocked, selected, officialAccountId, metric) {
  const rows = [];
  const skipped = [];
  const seen = new Set();
  for (const row of queue) {
    assertCandidate(row);
    if (rows.length >= count) break;
    const id = itemId(row);
    let reason = "";
    if (/职人|店员/.test(String(row.role || ""))) reason = "staff";
    else if (String(row.creatorId) !== String(officialAccountId)) reason = "non_official";
    else if (!id) reason = row.reason || "unresolved";
    else if (row.canDelivery === false || row.video?.canDelivery === false) reason = "not_deliverable";
    else if ((row.invalidDeliveryCodes || row.video?.invalidDeliveryCodes || []).length) reason = "invalid_delivery";
    else if (blocked.has(id)) reason = "protected_existing_plan";
    else if (selected.has(id)) reason = metric === "vv" ? "gmv_vv_duplicate" : "already_selected";
    else if (seen.has(id)) reason = "queue_duplicate";
    if (reason) {
      skipped.push({ metric, rank: row.rank, creatorId: row.creatorId, publish: row.publish, id, reason });
      continue;
    }
    seen.add(id);
    selected.add(id);
    rows.push(row);
  }
  assert.equal(rows.length, count, `${metric} insufficient eligible official videos: expected ${count}, got ${rows.length}`);
  return { rows, skipped };
}

export function selectOfficialTop5({ gmvQueue, vvQueue, gmvCount = 5, vvCount = 5, officialAccountId, protectedIds = [] }) {
  const blocked = new Set(protectedIds.map(String));
  const selected = new Set();
  const gmv = choose(gmvQueue, gmvCount, blocked, selected, officialAccountId, "gmv");
  const vv = choose(vvQueue, vvCount, blocked, selected, officialAccountId, "vv");
  const rows = [...gmv.rows, ...vv.rows];
  assert.equal(new Set(rows.map(itemId)).size, rows.length, "combined material IDs are not unique");
  return { gmv: gmv.rows, vv: vv.rows, rows, ids: rows.map(itemId), skipped: [...gmv.skipped, ...vv.skipped] };
}

export function toVideoMaterial(row) {
  const v = row.video || row;
  const image = v.imageUrl || {};
  const poster = image.urlList?.[0] || "";
  assert(v.itemId && v.videoId && v.title != null && v.authorUid && image.uri && poster, `incomplete material ${String(v.itemId || "")}`);
  return {
    ImageMode: v.imageMode || 15,
    AwemeItemId: String(v.itemId),
    ItemSource: 1,
    IsExtendedRootPoi: Boolean(v.isExtendedRootPoi),
    VideoInfo: {
      VideoId: String(v.videoId), Vid: String(v.videoId), Width: v.width, Height: v.height,
      ThumbWidth: v.width, ThumbHeight: v.height, CoverUri: image.uri,
      Duration: Math.round(Number(v.duration)), VideoName: String(v.title), VideoPoster: poster,
    },
    ImageInfo: { WebUri: image.uri, SignUrl: poster, Width: v.width, Height: v.height },
    CoverSource: v.coverSource ?? 1,
  };
}

export function toTitleMaterial(row, index) {
  const v = row.video || row;
  return { Title: String(v.title || ""), AwemeItemId: String(v.itemId), ItemSource: 1, VideoIdxRef: String(index) };
}

function replaceExactProjectName(node, currentName, nextName) {
  let count = 0;
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/name/i.test(key) && child === currentName) { value[key] = nextName; count += 1; }
      else if (child && typeof child === "object") walk(child);
    }
  };
  walk(node);
  return count;
}

function normalizeStaleStartDates(node, businessDate) {
  const iso = `${businessDate.slice(0, 4)}-${businessDate.slice(4, 6)}-${businessDate.slice(6, 8)}`;
  const targetSeconds = Date.parse(`${iso}T00:00:00+08:00`) / 1000;
  let changed = 0;
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/start.*(date|time)|^startTime$/i.test(key)) {
        if (typeof child === "string" && /^\d{4}-\d{2}-\d{2}$/.test(child) && child < iso) { value[key] = iso; changed += 1; continue; }
        if ((typeof child === "number" || /^\d{10,13}$/.test(String(child))) && Number(child) > 1_500_000_000) {
          const n = Number(child); const ms = n > 10_000_000_000; const seconds = ms ? n / 1000 : n;
          if (seconds < targetSeconds) { value[key] = ms ? targetSeconds * 1000 : targetSeconds; changed += 1; continue; }
        }
      }
      if (child && typeof child === "object") walk(child);
    }
  };
  walk(node);
  return { changed, startDate: iso };
}

function createEntries(payload) {
  return Object.values(payload?.multiAdProxy?.promotionCreateInfo || {});
}

function updateEntries(payload) {
  return Object.values(payload?.multiAdProxy?.promotionUpdateInfo || {});
}

export function mutateLiveRoomPayload(payload, cfg, rows) {
  const out = structuredClone(payload);
  assert(replaceExactProjectName(out, cfg.currentProjectName, cfg.projectName) > 0, "project name was not found uniquely by value");
  const entries = cfg.operation === "create" ? createEntries(out) : updateEntries(out);
  assert(entries.length, cfg.operation === "create" ? "promotionCreateInfo is missing" : "promotionUpdateInfo is missing");
  const entry = entries.find((x) => {
    const p = cfg.operation === "create" ? (x?.promotionCreateInfo || x) : (x?.promotionUpdateInfo || x);
    if (cfg.operation === "update" && cfg.promotionId) return String(p?.Id ?? p?.ID ?? p?.id ?? "") === String(cfg.promotionId);
    return String(p?.Name ?? p?.name ?? "") === String(cfg.currentUnitName);
  });
  assert(entry, "exact target live-room unit was not found in captured payload");
  const promotion = cfg.operation === "create" ? (entry.promotionCreateInfo || entry) : (entry.promotionUpdateInfo || entry);
  if ("Name" in promotion) promotion.Name = cfg.unitName; else promotion.name = cfg.unitName;
  const materials = cfg.operation === "create"
    ? (entry.materialGroupCreateInfo || promotion.materialGroupCreateInfo)
    : (entry.materialGroupUpdateInfo || promotion.materialGroupUpdateInfo);
  assert(materials && Array.isArray(materials.VideoMaterialList) && Array.isArray(materials.TitleMaterialList), "target material arrays are missing");
  materials.VideoMaterialList = rows.map(toVideoMaterial);
  materials.TitleMaterialList = rows.map(toTitleMaterial);
  const dateResult = normalizeStaleStartDates(out, cfg.businessDate);
  return { body: out, dateResult };
}

export function verifyLiveRoomReadback(row, cfg, expectedRows) {
  const ids = (row.ids || []).map(String);
  assert.equal(row.name, cfg.unitName, "unit name mismatch");
  assert.equal(row.projectName, cfg.projectName, "project name mismatch");
  assert.equal(ids.length, cfg.gmvCount + cfg.vvCount, "material count mismatch");
  assert.deepEqual(new Set(ids), new Set(expectedRows.map(itemId)), "material ID set mismatch");
  assert.equal(new Set(ids).size, ids.length, "readback contains duplicate material IDs");
  if (row.startDate) assert(row.startDate >= `${cfg.businessDate.slice(0, 4)}-${cfg.businessDate.slice(4, 6)}-${cfg.businessDate.slice(6, 8)}`, "readback start date is stale");
  return { verified: true, projectId: row.projectId, promotionId: row.id, projectName: row.projectName, unitName: row.name, materialCount: ids.length, uniqueVideoCount: new Set(ids).size };
}
