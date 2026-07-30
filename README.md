# 小说搜索站 使用文档

## 一、项目简介

轻量级小说搜索 + 求书留言板，部署在 Cloudflare Pages + D1，全免费。

**技术栈**：Cloudflare Pages（托管）+ D1 SQLite（数据库）+ Hono（后端框架）+ 原生 HTML/CSS/JS（前端）

**线上地址**：

| 账号 | 地址 |
|------|------|
| 账号 1 | https://novel-search.pages.dev |
| 账号 2 | https://novel-search-3fr.pages.dev |

---

## 二、文件结构

```
├── _worker.src.js     # 源码（Hono 路由 + 前端页面，单文件，你编辑这个）
├── _worker.js         # 打包后的 worker（npm run build 自动生成，别手动改）
├── schema.sql          # 建表 SQL（一次性执行）
├── wrangler.toml       # Cloudflare 配置（D1 绑定）
├── package.json        # 依赖 + 脚本
├── package-lock.json
└── .gitignore
```

核心代码只有 `_worker.src.js` 一个文件，包含全部后端路由和前端页面。

---

## 三、环境准备

- Node.js 18+
- Cloudflare 账号

```bash
npm install
```

---

## 四、本地开发

```bash
npm run dev
```

打开 http://localhost:8788

> 本地开发会自动打包 `_worker.src.js` → `_worker.js`，然后启动 wrangler 本地服务。本地数据库是独立的，不影响线上数据。

---

## 五、部署到 Cloudflare

### 前置条件

- Cloudflare 账号
- API Token（需要 D1 Edit + Pages Edit + Workers Scripts Edit 权限）
- Account ID

### 5.1 创建 D1 数据库

```bash
CLOUDFLARE_API_TOKEN="你的Token" CLOUDFLARE_ACCOUNT_ID="你的AccountID" npx wrangler d1 create novel-search-db
```

输出会包含 `database_id`，把它填入 `wrangler.toml`。

### 5.2 执行建表

```bash
CLOUDFLARE_API_TOKEN="你的Token" CLOUDFLARE_ACCOUNT_ID="你的AccountID" npx wrangler d1 execute novel-search-db --remote --file=schema.sql
```

### 5.3 创建 Pages 项目

```bash
# 如果 wrangler pages project create 报错，用 API 直接创建
curl -X POST "https://api.cloudflare.com/client/v4/accounts/你的AccountID/pages/projects" \
  -H "Authorization: Bearer 你的Token" \
  -H "Content-Type: application/json" \
  -d '{"name":"novel-search","production_branch":"main"}'
```

### 5.4 部署

```bash
CLOUDFLARE_API_TOKEN="你的Token" CLOUDFLARE_ACCOUNT_ID="你的AccountID" npm run deploy
```

### 5.5 部署到第二个账号

如果要在另一个 CF 账号也部署一份：

1. 临时修改 `wrangler.toml` 中的 `database_id` 为新账号的数据库 ID
2. 用新账号的 Token 和 Account ID 执行上述部署命令
3. 部署完成后把 `database_id` 改回原账号的值

两个账号的数据库是**完全独立的**，需要各自添加小说数据。

---

## 六、数据库操作手册

> 所有操作在 Cloudflare Dashboard → Workers & Pages → D1 → `novel-search-db` → Console 中执行 SQL。

### 6.1 novels 表字段说明

| 字段 | 类型 | 必填 | 格式 | 说明 |
|------|------|------|------|------|
| `id` | INTEGER | 自动 | 自增主键 | 不用管 |
| `title` | TEXT | **是** | 纯文本 | 书名 |
| `author` | TEXT | 否 | 纯文本 | 作者，不填默认空 |
| `description` | TEXT | 否 | 纯文本 | 简介 |
| `drive_links` | TEXT | 否 | **JSON 数组字符串** | 网盘链接，见 6.5 详解 |
| `tags` | TEXT | 否 | 逗号分隔文本 | 标签，见 6.6 详解 |
| `view_count` | INTEGER | 否 | 整数，默认 0 | 热度值，越大越靠前（热门 Tab 排序依据） |
| `is_featured` | INTEGER | 否 | 0 或 1，默认 0 | 精选标记，1=精选（精选 Tab 只展示 1） |
| `created_at` | TEXT | 自动 | `YYYY-MM-DD HH:MM:SS` | 自动填入 |

### 6.2 添加小说

**单个网盘链接**：

```sql
INSERT INTO novels (title, author, description, drive_links, tags)
VALUES (
  '破云',
  '淮上',
  '一场绵延二十年的阴谋，一段从对峙到交付后背的关系。',
  '[{"label":"百度网盘","url":"https://pan.baidu.com/s/xxx","code":"ab12"}]',
  '耽美,刑侦,现代'
);
```

**多个网盘链接**（在 JSON 数组里放多个对象）：

```sql
INSERT INTO novels (title, author, description, drive_links, tags)
VALUES (
  '撒野',
  '巫哲',
  '两个男孩在一个破败的小城里相遇，用彼此的温度撑过最难的那几年。',
  '[{"label":"百度网盘","url":"https://pan.baidu.com/s/xxx","code":"ab12"},{"label":"夸克网盘","url":"https://pan.quark.cn/s/yyy","code":""},{"label":"阿里云盘","url":"https://www.aliyundrive.com/s/zzz","code":""}]',
  '耽美,校园,治愈'
);
```

**没有网盘链接**（暂时只录信息）：

```sql
INSERT INTO novels (title, author, description, drive_links, tags)
VALUES (
  '某某',
  '木苏里',
  '重生一世，他只想把人护在身后。',
  '[]',
  '言情,重生,古风'
);
```

### 6.3 修改小说

```sql
-- 修改简介
UPDATE novels SET description = '新的简介内容' WHERE id = 1;

-- 修改网盘链接（整体替换）
UPDATE novels SET drive_links = '[{"label":"百度网盘","url":"https://pan.baidu.com/s/new","code":"newcode"}]' WHERE id = 1;

-- 修改标签
UPDATE novels SET tags = '耽美,校园,治愈,甜文' WHERE id = 1;
```

### 6.4 删除小说

```sql
DELETE FROM novels WHERE id = 1;
```

### 6.5 热门和精选设置

**设置热度值**（数字越大在"热门"Tab 越靠前）：
```sql
UPDATE novels SET view_count = 100 WHERE id = 1;
UPDATE novels SET view_count = 50  WHERE id = 2;
```

**标记为精选**（在"精选"Tab 展示）：
```sql
UPDATE novels SET is_featured = 1 WHERE id = 1;
```

**取消精选**：
```sql
UPDATE novels SET is_featured = 0 WHERE id = 1;
```

**查看当前热门排序**：
```sql
SELECT id, title, view_count FROM novels ORDER BY view_count DESC LIMIT 10;
```

**查看所有精选**：
```sql
SELECT id, title FROM novels WHERE is_featured = 1;
```

### 6.6 drive_links JSON 格式详解

`drive_links` 字段存的是 **JSON 数组的字符串形式**，外层用单引号包裹，内部用双引号。

**结构**：

```json
[
  {"label": "网盘名称", "url": "链接地址", "code": "提取码"},
  {"label": "网盘名称", "url": "链接地址", "code": ""}
]
```

| 字段 | 含义 | 没有提取码时 |
|------|------|------------|
| `label` | 网盘名称，显示在按钮上（如"百度网盘"） | — |
| `url` | 链接地址 | — |
| `code` | 提取码 | 填空字符串 `""`，不要省略 |

**注意事项**：
- 整个 JSON 用**单引号**包裹，内部属性名和值用**双引号**
- 没有链接时填 `'[]'`，不要填 NULL 或空字符串
- 没有提取码时 `code` 填 `""`，不要省略 `code` 字段
- 修改链接时需要**整体替换**整个 JSON，不能只改其中一条

### 6.7 tags 格式说明

用**英文逗号**分隔，不需要引号：

```
耽美,刑侦,现代
```

不要写成：`'耽美'，'刑侦'` 或 `耽美、刑侦、现代`（中文顿号不行）。

### 6.8 FTS5 全文搜索说明

数据库内置了 FTS5 全文搜索索引，会通过触发器**自动维护**：

- INSERT 小说时 → 自动加入索引
- UPDATE 小说时 → 自动更新索引
- DELETE 小说时 → 自动删除索引

**你不需要手动维护搜索索引**，只要正常增删改 novels 表，搜索就能自动生效。

搜索匹配范围：`title`、`author`、`description`、`tags` 四个字段，支持多关键词空格分隔（AND 查询）。

---

## 七、留言管理

### 7.1 留言状态流转

```
用户提交留言 → pending（待处理，默认）
                    │
          ┌─────────┼──────────┐
          ▼                    ▼
     accepted              rejected
     （已采纳）             （已拒绝）
          │
          ▼
     completed
     （已补充）
```

正常流程：`pending` → `accepted` → `completed`
无法补充：`pending` → `rejected`

### 7.2 状态值对照表

| 数据库里的值 | 页面显示 | 颜色 | 含义 |
|-------------|---------|------|------|
| `pending` | 待处理 | 灰色 | 用户刚提交，你还没处理 |
| `accepted` | 已采纳 | 粉色 | 确认要补充，进行中 |
| `completed` | 已补充 | 绿色 | 数据已录入 novels 表 |
| `rejected` | 已拒绝 | 暗红色 | 找不到资源或无法补充 |

> **status 值必须全小写**，填 `Pending` 或 `PENDING` 不会生效。

### 7.3 修改留言状态

在 D1 Console 执行：

```sql
-- 查看所有留言（先看 id）
SELECT id, novel_name, status FROM messages ORDER BY id;

-- 标记为已采纳（准备补充）
UPDATE messages SET status = 'accepted' WHERE id = 1;

-- 标记为已补充（数据已录入）
UPDATE messages SET status = 'completed' WHERE id = 1;

-- 标记为已拒绝（无法补充）
UPDATE messages SET status = 'rejected' WHERE id = 1;

-- 批量处理（比如统一拒绝多条）
UPDATE messages SET status = 'rejected' WHERE id IN (3, 5, 7);
```

### 7.4 按状态筛选留言

```sql
-- 只看待处理的
SELECT * FROM messages WHERE status = 'pending';

-- 只看已补充的
SELECT * FROM messages WHERE status = 'completed';
```

> 改完 SQL 后**刷新页面**即可看到新状态，不需要重新部署。

---

## 八、API 接口说明

### GET /api/search

搜索小说。

| 参数 | 类型 | 说明 |
|------|------|------|
| `q` | string | 搜索关键词，匹配书名/作者/简介/标签。为空时返回最新收录 |
| `page` | number | 页码，默认 1，每页 20 条 |

**响应**：
```json
{
  "results": [
    {
      "id": 1,
      "title": "破云",
      "author": "淮上",
      "description": "...",
      "drive_links": [
        {"label": "百度网盘", "url": "https://...", "code": "ab12"}
      ],
      "tags": ["耽美", "刑侦", "现代"],
      "created_at": "2024-01-15 10:30:00"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### GET /api/messages

获取留言列表。

| 参数 | 类型 | 说明 |
|------|------|------|
| `status` | string | 筛选状态：`pending`/`accepted`/`completed`/`rejected`/`all`。为空返回全部 |
| `page` | number | 页码，默认 1，每页 20 条 |

**响应**：
```json
{
  "results": [
    {
      "id": 1,
      "novel_name": "天官赐福",
      "note": "求全本+番外",
      "status": "pending",
      "created_at": "2024-01-15 10:30:00"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### POST /api/messages

提交留言。

**请求体**：
```json
{
  "novel_name": "天官赐福",
  "note": "求全本+番外"
}
```

**响应**：
```json
{"ok": true}
```

**错误响应**：
```json
{"error": "请填写小说名称"}
```

---

## 九、修改代码后重新部署

1. 编辑 `_worker.src.js`
2. 运行部署命令（会自动打包 + 部署）：

```bash
CLOUDFLARE_API_TOKEN="你的Token" CLOUDFLARE_ACCOUNT_ID="你的AccountID" npm run deploy
```

> **不要手动编辑 `_worker.js`**，它是 esbuild 自动生成的打包文件，每次 `npm run build` 会覆盖。

---

## 十、常见问题

### Q：添加了小说但搜索不到？

检查以下几点：
1. INSERT 语句是否执行成功
2. `title` 字段是否填写了
3. 搜索关键词是否匹配了 title/author/description/tags 中的内容
4. 多个关键词用空格分隔，是 AND 查询（所有关键词都要匹配）

### Q：改了留言状态但页面没变？

1. 确认 status 值是**全小写**（`pending`/`accepted`/`completed`/`rejected`）
2. 确认改的是正确的 id
3. 刷新页面

### Q：部署后页面显示 522？

刚部署后 Worker 需要初始化，等 1-2 分钟再访问。如果持续 522，检查 `_worker.js` 是否正确打包。

### Q：要在另一个 CF 账号部署？

1. 临时修改 `wrangler.toml` 的 `database_id` 为新账号的
2. 用新账号的 Token + Account ID 执行部署
3. 部署后改回原 `database_id`
4. 两个账号的数据库独立，需要各自添加数据

### Q：如何导出数据？

```sql
-- 导出全部小说
SELECT * FROM novels;

-- 导出全部留言
SELECT * FROM messages;
```

在 D1 Console 执行后可以复制结果。
