import assert from "node:assert/strict";

export function numberValue(value) {
  const text = String(value ?? "").replace(/[¥￥,\s]/g, "");
  if (!text || text === "-" || text === "--") return 0;
  const n = Number(text);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function parseAnalyticsCells(cells, headers, rank, officialAccountId) {
  assert(Array.isArray(cells) && cells.length, `analytics cells are empty at rank ${rank}`);
  const lines = String(cells[0] || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const publishIndex = lines.findIndex((x) => /^发布时间[:：]/.test(x));
  assert(publishIndex >= 2, `analytics identity fields changed at rank ${rank}`);
  const role = lines[publishIndex - 1];
  const identity = lines[publishIndex - 2];
  const creatorId = String(officialAccountId || "");
  const suffix = ` ${creatorId}`;
  assert(identity.endsWith(suffix), `official account id mismatch at rank ${rank}`);
  const publish = lines[publishIndex].replace(/^发布时间[:：]\s*/, "").replaceAll("/", "-");
  const title = lines.slice(0, publishIndex - 2).join(" ").trim();
  const indexOf = (pattern) => headers.findIndex((x) => pattern.test(String(x || "")));
  const gmvIndex = indexOf(/视频总成交价值/);
  const vvIndex = indexOf(/视频播放次数/);
  assert(gmvIndex >= 0 && vvIndex >= 0, "analytics GMV/VV headers changed");
  return {
    rank: Number(rank), title, name: identity.slice(0, -suffix.length), creatorId,
    role, publish, gmvValue: numberValue(cells[gmvIndex]), vvValue: numberValue(cells[vvIndex]),
  };
}

export function shanghaiMinute(epoch) {
  const n = Number(epoch);
  if (!Number.isFinite(n) || n <= 0) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(n > 10_000_000_000 ? n : n * 1000));
  const part = (type) => parts.find((x) => x.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

export function materialCreatorIds(video) {
  const u = video?.userInfo || video?.user || {};
  return [u.uniqueId, u.shortId, u.idStr, u.aggregiateId, u.aggregateId]
    .filter((x) => x != null && String(x) !== "").map(String);
}

export function normalizeMaterial(video) {
  const itemId = String(video?.itemId ?? video?.aweme_item_id ?? "");
  const imageUrl = video?.imageUrl || video?.image_url || {};
  return {
    itemId,
    videoId: String(video?.videoId ?? video?.video_id ?? video?.vid ?? ""),
    title: String(video?.title ?? video?.videoName ?? ""),
    authorUid: String(video?.authorUid ?? video?.author_uid ?? ""),
    createTime: video?.createTime ?? video?.create_time,
    duration: Number(video?.duration ?? 0), width: Number(video?.width ?? 0), height: Number(video?.height ?? 0),
    imageMode: Number(video?.imageMode ?? video?.image_mode ?? 15), imageUrl,
    canDelivery: video?.canDelivery !== false && video?.can_delivery !== false,
    invalidDeliveryCodes: (() => {
      const value = video?.invalidDeliveryCodes ?? video?.invalid_delivery_codes;
      return Array.isArray(value) ? value : (value == null || value === "" ? [] : [value]);
    })(),
    userInfo: video?.userInfo || video?.user || {},
  };
}

export function resolveRankingRows(rows, videos, officialAccountId) {
  const normalized = videos.map(normalizeMaterial).filter((x) => x.itemId);
  return rows.map((row) => {
    const hits = normalized.filter((video) => {
      const ids = materialCreatorIds(video);
      const creatorMatches = ids.length ? ids.includes(String(officialAccountId)) : true;
      return creatorMatches && video.title === row.title && shanghaiMinute(video.createTime) === row.publish;
    });
    if (hits.length !== 1) return { ...row, canDelivery: false, reason: hits.length ? "ambiguous_material" : "missing_material" };
    const video = hits[0];
    if (!video.canDelivery) return { ...row, video, canDelivery: false, reason: "not_deliverable" };
    if (video.invalidDeliveryCodes.length) return { ...row, video, canDelivery: false, reason: "invalid_delivery" };
    return { ...row, video, canDelivery: true };
  });
}

export function assertDescending(rows, field, metric) {
  for (let i = 1; i < rows.length; i += 1) {
    assert(Number(rows[i - 1][field]) >= Number(rows[i][field]), `${metric} ranking is not descending at ${i + 1}`);
  }
}
