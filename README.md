# github-trending-data 数据仓库

每日自动抓取 GitHub Trending 榜单并生成静态 JSON，供微信小程序（工具箱类）读取。数据完全自主可控，不依赖任何第三方 API 服务。

## 数据流

```
GitHub Actions（每日 08:30 北京时间）
        │  抓取 github.com/trending
        ▼
本仓库 data/{daily,weekly,monthly}/{language}.json   ← 数据仓库（public）
        │  经 jsDelivr CDN 分发（国内可访问）
        ▼
微信云函数 github-trending（10 分钟缓存）
        │
        ▼
小程序「GitHub 热门」页面
```

## 一、部署步骤（一次性）

1. **创建 GitHub 仓库**：在 GitHub 新建一个 **public** 仓库，名为 `github-trending-data`（保持公开，jsDelivr 只服务 public 仓库）。

2. **推送本目录内容**：
   ```bash
   cd github-trending-data
   npm install          # 生成本地 node_modules（不必提交，.gitignore 会忽略）
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/github-trending-data.git
   git push -u origin main
   ```

3. **验证自动抓取**：推送会触发一次 workflow（`push` 事件），到仓库 Actions 页确认执行成功，然后查看 `data/daily/all.json` 是否生成。

4. **配置云函数**：把 `cloudfunctions/github-trending/index.js` 顶部的 `DATA_OWNER` 改成你的 GitHub 用户名，然后在微信开发者工具中右键该目录 →「上传并部署：云端安装依赖」。

## 二、长期稳定性说明

- **定时更新**：workflow 每天 00:30 UTC（北京时间 08:30）运行一次，只有数据有变化才会产生新 commit（避免无意义提交）。
- **手动触发**：仓库 Actions 页 → Fetch GitHub Trending → Run workflow，可随时手动更新。
- **重要：60 天自动暂停**。GitHub 规定：仓库 60 天无活动时，`schedule` 触发的 workflow 会被自动禁用。如果你的仓库超过 60 天没人推送 commit，请到 Actions 页手动 Run workflow 一次即可恢复。这是目前唯一需要留意的运维动作。
- **CDN 备源**：云函数优先请求 jsDelivr（国内快），失败自动回退 `raw.githubusercontent.com`，双源兜底。

## 三、数据格式

`data/{since}/{language}.json`，其中 `since` 为 `daily | weekly | monthly`，`language` 为 `all | javascript | python | go | rust | typescript | java | c | c++ | php | shell`。

```json
{
  "generated_at": "2026-08-21T00:30:00.000Z",
  "since": "daily",
  "language": "all",
  "count": 25,
  "list": [
    {
      "rank": 1,
      "owner": "owner",
      "name": "repo",
      "full_name": "owner/repo",
      "description": "仓库描述",
      "language": "JavaScript",
      "language_color": "#f1e05a",
      "stars": 12345,
      "forks": 678,
      "delta_stars": 234,
      "url": "https://github.com/owner/repo"
    }
  ]
}
```

## 四、本地测试

```bash
node scripts/fetch-trending.js   # 在仓库根目录执行，会抓取全量并写入 data/
```

## 五、小程序端访问地址

无需在代码中写死，云函数已内置数据源拼接逻辑。直接调用：

```js
wx.cloud.callFunction({
  name: 'github-trending',
  data: { since: 'daily', language: 'all' }
});
```
