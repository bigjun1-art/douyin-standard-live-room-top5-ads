---
name: douyin-standard-live-room-top5-ads
description: Parameterize 巨量本地推 标准投放 → 直播间 → 短视频 plans with the official account's near-7-day GMV Top5 plus VV Top5 videos. Use when creating, copying, or updating one official-live-room unit while excluding staff/non-official/hidden/unavailable videos, deduplicating VV against GMV, backfilling by rank, submitting once through logged-in Chrome, and reading back exact material IDs and names.
---

# 标准投放直播间官号 Top5 参数化执行

This is separate from `douyin-weekly-top10-local-ads`. Use the executable runner; do not replace it with per-video mouse selection or a documentation-only workflow.

## Run

```bash
cd <skill-directory>
node scripts/run_live_room_top5.mjs \
  --config /private/tmp/douyin-live-room-top5.json
```

Validation after code changes:

```bash
node scripts/run_live_room_top5.mjs --self-test
```

The default is preview-only and completes tab identity checks, current-detail reads, request capture, selection, date normalization, and payload construction without final submission. To submit, add `"confirmAdvertiserId": "CURRENT_ADVERTISER_ID"` to the config and run with `--execute`.

The agent creates the temporary config. Do not ask the user to write JSON, paste Console code, click confirmation dialogs, or keep Chrome foregrounded. When `rankings` is omitted or both arrays are empty, the runner automatically reads the current near-7-day rankings and resolves current local-ads materials before capture and submission.

## Config

```json
{
  "operation": "create",
  "advertiserId": "CURRENT_ADVERTISER_ID",
  "confirmAdvertiserId": "CURRENT_ADVERTISER_ID",
  "businessDate": "YYYYMMDD",
  "officialAccountId": "EXACT_OFFICIAL_ACCOUNT_ID",
  "gmvCount": 5,
  "vvCount": 5,
  "currentProjectName": "EXACT_COPIED_PROJECT_NAME",
  "projectName": "YYYYMMDD_FINAL_PROJECT_NAME",
  "currentUnitName": "EXACT_COPIED_UNIT_NAME",
  "unitName": "YYYYMMDD_FINAL_UNIT_NAME",
  "tab": { "pathContains": "/lamp/pc/superior/create-v2/create" },
  "captureButtonText": "保存投放",
  "protectedPromotionIds": [],
  "analytics": {
    "groupId": "auto",
    "pathContains": "/flow/content/my/overview",
    "candidateLimit": 30,
    "maxPages": 20
  },
  "rankings": { "gmv": [], "vv": [] }
}
```

For `operation=update`, provide exact `promotionId` and use the current edit-page path. `requestBody` and `requestUrl` are optional overrides for a current verified request sample.

`rankings` is an optional verified override. Normally leave both arrays empty and let the runner collect them. If supplied, each row must contain source rank, official account name/ID, publish minute, role, title, availability, and the matched material object:

```json
{
  "rank": 1,
  "name": "官号名称",
  "creatorId": "官号ID",
  "publish": "YYYY-MM-DD HH:mm",
  "role": "官号",
  "canDelivery": true,
  "video": {
    "itemId": "AWEME_ITEM_ID",
    "videoId": "VIDEO_ID",
    "title": "完整标题",
    "authorUid": "INTERNAL_AUTHOR_ID",
    "duration": 15,
    "width": 720,
    "height": 1280,
    "imageMode": 15,
    "imageUrl": { "uri": "COVER_URI", "urlList": ["COVER_URL"] }
  }
}
```

## Input contract

1. Read `抖音生活服务生意经 → 流量 → 内容分析 → 视频分析 → 近7日` through the logged-in tab.
2. Build GMV-descending and VV-descending official-account queues. Require exact official account ID, name, publish minute, and title/cover when needed.
3. Resolve every candidate to a current `getTradeItemList` material. Promote `aweme_item_id` to canonical identity.
4. Reject non-official accounts, `职人/店员`, hidden, missing, ambiguous, `canDelivery=false`, or invalid-delivery material. Keep the reason and continue in source-rank order.
5. Select GMV 5 first. Select VV 5 second after excluding every GMV item ID. A rejected candidate never consumes a slot.

The automatic source path must reach exactly one logged-in `www.life-data.cn/flow/content/my/overview?...secondTab=VideoAnalysis` tab, select `近7日`, force each target metric into verified descending order, retain source rank while paging, and stop only after enough exact official-account candidates are collected. It then opens the current target unit's material picker once, captures the current same-origin `getTradeItemList` request/response, follows its current cursor, and matches by exact official account ID, title, and Shanghai publish minute. It must not reuse an old HAR, old material body, device ID, asset list, or account ID.

Do not use creator-level deduplication; different videos from the same official account are allowed. Do not hardcode old account IDs, campaign IDs, dates, names, budget, bid, region, stores, schedule, or audience.

## Background execution contract

The runner must:

1. Reach exactly one logged-in `localads.chengzijianzhan.cn` tab by advertiser ID and path.
2. Automatically collect rankings and resolve materials when no verified ranking override is supplied, then batch-read any protected/current promotion details.
3. Correct a copied start date earlier than `businessDate` through semantic DOM state before capture; reject an expired end date unless `endDate` is supplied.
4. Install a same-origin fetch bridge, activate the single visible `保存投放` button programmatically, block the outgoing `createPromote/updatePromote`, capture its complete body, and restore fetch.
5. Change only the exact project name, exact target unit name, target `VideoMaterialList`, paired `TitleMaterialList`, and a stale start date. Preserve budget, bid, stores, region, schedule, audience, official-account binding, optimization goal, neighboring units, and unknown fields.
6. Assert 5 GMV + 5 VV, ten unique item IDs, exact official account, no staff, no protected intersection, and no GMV/VV intersection.
7. Send one same-origin request. On uncertain status, do not retry blindly.
8. Read the resulting promotion through `/api/lamp/pc/v2/superior/ad/promotion/detail` and its project through `/api/lamp/pc/v2/superior/promote/projects/detail`.
9. Require exact project name, unit name, ten material IDs, ten unique IDs, and a non-stale start date before reporting completion.

## Fast failure

Stop at the concrete guard for a missing/non-unique target tab, changed form schema, non-unique save button, client validation block, stale end date, insufficient eligible videos, login loss, CAPTCHA, permission change, submission error, or readback mismatch. Do not probe random ports, reuse old HAR files, switch browsers, or fall back to repeated mouse selection.
