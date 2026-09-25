---
name: douyin-standard-live-room-top5-ads
description: Parameterize 巨量本地推 标准投放 → 直播间 → 短视频 plans with the official account's near-7-day GMV Top5 plus VV Top5. Prefer official MAPI for material resolution, project/unit mutation, and exact readback; retain 生意经 for rankings.
---

# 标准投放直播间官号 Top5 参数化执行

## 后台优先与前台兜底

执行优先级：先使用已授权、可用且能精确绑定账号与页面的端口/浏览器后台连接、参数化脚本或官方接口；其次使用已登录页面的后台同源请求；仅在相关后台路径确实不可用时使用前台兜底。官方接口已满足任务时不必为端口方式额外探测。不能把“后台优先”解释为“禁止所有前台操作”。

使用已有端口连接前核对工具允许的访问方式、浏览器资料、准确 URL 和账号/计划；不盲扫端口，不自行开启调试权限，不绕过工具限制或另建登录环境。页面 JavaScript/DOM 操作与系统键鼠分开判断，正常后台执行不激活窗口。

启用前台兜底前说明后台失败的具体证据、拟操作范围与预计占用方式；当前任务已授权该兜底且工具允许时继续，不逐批重复确认。如果用户正在使用前台、明确要求本次全程后台，或工具要求额外批准，则先协调必要的前台时段/授权。优先最少量的语义操作或一次 Console 参数化脚本提交，避免逐条鼠标重复操作及盲目坐标回放。

接口明确禁止调用、账号不匹配、登录挑战或权限拒绝不得通过换通道绕过。一般能力不支持时可采用获准的正常页面操作；写入结果不确定时，先回读并恢复检查点，绝不因切换前后台而重复提交。原有素材保留、删除授权、准确 ID 与回读验收规则始终有效。无法完成的页面验收如实记录；用户明确接受本次接口验收时按该范围交付。


## 本技能 MAPI 接口接入

执行本技能的 MAPI 查询、写入或回读前，读取 [references/mapi-execution.md](references/mapi-execution.md)。接口代码随本技能独立分发；沿用下述业务功能与筛选规则。

## Official MAPI first

Use the bundled `scripts/run_local_mapi.mjs` by default when the local account and scopes are authorized. Read [references/mapi-config.md](references/mapi-config.md) when composing its temporary credential-free config. The runner is included in this Skill and has no cross-Skill dependency.

1. Keep the near-7-day GMV/VV source collection in 生意经.
2. Resolve official-account candidates through `material.aweme.video`/`material.library.video`; require the exact official account, item ID, publish minute, and deliverability.
3. Use `project.create` plus `promotion.create`, or fresh `project.detail`/`promotion.detail` followed by the matching updates.
4. Read back with `promotion.detail` or `standard.project.materials` and enforce the same 5+5, official-account-only, unique-ID, and date assertions below.

Use the existing Chrome runner only when the official endpoint does not support the current standard-live-room schema or authorization is unavailable. Do not retry through Chrome after an uncertain MAPI write.

This is separate from `douyin-creator-material-ads`. When the MAPI fallback rule applies, use the executable runner; do not replace it with per-video mouse selection or a documentation-only workflow.

## Chrome fallback run

```bash
node ${CODEX_HOME:-$HOME/.codex}/skills/douyin-standard-live-room-top5-ads/scripts/run_live_room_top5.mjs \
  --config /private/tmp/douyin-live-room-top5.json
```

Validation after code changes:

```bash
node ${CODEX_HOME:-$HOME/.codex}/skills/douyin-standard-live-room-top5-ads/scripts/run_live_room_top5.mjs --self-test
```

Use `--dry-run` to complete tab identity checks, current-detail reads, request capture, selection, date normalization, and payload construction without final submission.

The agent creates the temporary config. Do not ask the user to write JSON, paste Console code, click confirmation dialogs, or keep Chrome foregrounded. When `rankings` is omitted or both arrays are empty, the runner automatically reads the current near-7-day rankings and resolves current local-ads materials before capture and submission.

## Config

```json
{
  "operation": "create",
  "advertiserId": "CURRENT_ADVERTISER_ID",
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

## 发布版执行参数

后台优先策略不改变发布版预演和目标校验。已授权任务由执行者填写这些参数，不代表需要逐批再次询问用户。

Chrome runner 默认预演；实际执行使用 `--execute`，并在配置中设置与 `advertiserId` 相同的 `confirmAdvertiserId`。

`applescript_eval.sh` 默认不激活窗口；仅获准的前台兜底同时使用 `--activate --allow-foreground`。没有该 helper 的技能按其连接器流程执行。
