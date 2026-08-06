import { Hono } from 'hono';

const app = new Hono();

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

app.get('/', (c) => c.html(INDEX_HTML));

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const tab = c.req.query('tab') || 'latest';
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const db = c.env.DB;
  const limit = 10;
  const offset = (page - 1) * limit;

  try {
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean);
      const ftsQuery = tokens.map(s => `"${s.replace(/"/g,'') }"`).join(' ');
      const likeQuery = `%${q}%`;
      
      const rows = await db.prepare(
        `SELECT id, title, author, description, drive_links, tags, created_at
         FROM novels
         WHERE id IN (SELECT rowid FROM novels_fts WHERE novels_fts MATCH ?)
            OR author LIKE ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(ftsQuery, likeQuery, limit, offset).all();
      
      const cnt = await db.prepare(
        `SELECT count(*) as c 
         FROM novels 
         WHERE id IN (SELECT rowid FROM novels_fts WHERE novels_fts MATCH ?)
            OR author LIKE ?`
      ).bind(ftsQuery, likeQuery).first();
      
      const results = (rows.results || []).map(r => ({ 
        ...r, 
        drive_links: safeParse(r.drive_links, []), 
        tags: r.tags ? r.tags.split(',').map(t=>t.trim()).filter(Boolean): [] 
      }));
      return c.json({ results, total: cnt?.c || 0, page, limit });
    }

    if (tab === 'authors') {
      const authorsLimit = 5;
      const authorsOffset = (page - 1) * authorsLimit;
      const authorsRows = await db.prepare(
        `SELECT author, count(*) as c FROM novels
         WHERE author IS NOT NULL AND author != '' AND author != '未知' AND author NOT LIKE '%精选合集%' AND author NOT LIKE '%精选集合%'
         GROUP BY author ORDER BY c DESC LIMIT ? OFFSET ?`
      ).bind(authorsLimit, authorsOffset).all();
      
      const authorsList = (authorsRows.results || []);
      const resultsArr = [];
      for (const a of authorsList) {
        const novelsRes = await db.prepare(
          `SELECT id, title, drive_links FROM novels WHERE author = ? ORDER BY created_at DESC LIMIT 50`
        ).bind(a.author).all();
        const novels = (novelsRes.results || []).map(n => ({ 
          id: n.id, 
          title: n.title, 
          drive_links: safeParse(n.drive_links, []) 
        }));
        resultsArr.push({ author: a.author, count: a.c, novels });
      }
      const totalAuthors = (await db.prepare(
        `SELECT count(DISTINCT author) as c FROM novels WHERE author IS NOT NULL AND author != '' AND author != '未知' AND author NOT LIKE '%精选合集%' AND author NOT LIKE '%精选集合%'`
      ).first())?.c || 0;
      
      return c.json({ results: resultsArr, total: totalAuthors, page, limit: authorsLimit });
    }

    let sql = `SELECT id, title, author, description, drive_links, tags, created_at FROM novels`;
    let countSql = `SELECT count(*) as c FROM novels`;
    let bindArgs = [limit, offset];

    if (tab === 'hot') {
      sql += ` WHERE view_count > 0 ORDER BY view_count DESC, created_at DESC LIMIT ? OFFSET ?`;
      countSql += ` WHERE view_count > 0`;
    } else if (tab === 'featured') {
      sql += ` WHERE is_featured = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      countSql += ` WHERE is_featured = 1`;
    } else {
      sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    }

    const rows = await db.prepare(sql).bind(...bindArgs).all();
    const cnt = await db.prepare(countSql).first();
    const results = (rows.results || []).map(r => ({ ...r, drive_links: safeParse(r.drive_links, []), tags: r.tags ? r.tags.split(',').map(t=>t.trim()).filter(Boolean): [] }));
    return c.json({ results, total: cnt?.c || 0, page, limit });
  } catch (err) {
    return c.json({ results: [], total: 0, page, limit, error: err.message });
  }
});

app.get('/api/messages', async (c) => {
  const status = c.req.query('status') || '';
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit = 50;
  const offset = (page - 1) * limit;
  const db = c.env.DB;
  try {
    let rows, cnt;
    if (status && status !== 'all') {
      rows = await db.prepare(`SELECT id, novel_name, note, status, created_at FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(status, limit, offset).all();
      cnt = await db.prepare(`SELECT count(*) as c FROM messages WHERE status = ?`).bind(status).first();
    } else {
      rows = await db.prepare(`SELECT id, novel_name, note, status, created_at FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(limit, offset).all();
      cnt = await db.prepare(`SELECT count(*) as c FROM messages`).first();
    }
    return c.json({ results: rows.results || [], total: cnt?.c || 0, page, limit });
  } catch (e) {
    return c.json({ results: [], total: 0, page, limit });
  }
});

app.post('/api/messages', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const name = (body.novel_name || '').trim();
  const note = (body.note || '').trim().slice(0, 1000);
  if (!name) return c.json({ error: '请填写小说名称' }, 400);
  const db = c.env.DB;
  const res = await db.prepare(`INSERT INTO messages (novel_name, note, status, created_at) VALUES (?, ?, 'pending', datetime('now'))`).bind(name, note).run();
  return c.json({ ok: true, id: res.meta.last_row_id });
});

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>窝嘟嘟 · 小说搜索与求书板</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#F7F8FA;color:#333;line-height:1.75;font-size:15px;position:relative;padding-bottom:40px;}

/* 全局防搬运暗纹水印层 */
.watermark-layer{
    position:fixed;
    top:0;
    left:0;
    width:100vw;
    height:100vh;
    pointer-events:none;
    z-index:999;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220' viewBox='0 0 220 220'><text x='20' y='100' fill='%23333333' fill-opacity='0.04' font-size='13' font-weight='bold' transform='rotate(-30, 20, 100)'>窝嘟嘟首发·严禁搬运</text></svg>");
}

/* 1. 顶部防迷路安全公告条 */
.safe-notice-bar{
    background:linear-gradient(135deg, #FFF0F2 0%, #FFE4E8 100%);
    color:#D94659;
    font-size:12px;
    padding:8px 12px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    border-bottom:1px solid #FFD1D8;
    position:sticky;
    top:0;
    z-index:100;
    height:35px;
}
.safe-notice-content{
    display:flex;
    align-items:center;
    gap:4px;
    overflow:hidden;
    white-space:nowrap;
    text-overflow:ellipsis;
}
.safe-notice-content span{
    font-weight:600;
}

/* 顶层大 Tab 切换导航栏 */
.main-nav-tabs{
    display:flex;
    background:#ffffff;
    border-bottom:1px solid #eee;
    position:sticky;
    top:35px;
    z-index:99;
    height:46px;
}
.nav-tab-item{
    flex:1;
    text-align:center;
    padding:12px 0;
    font-size:15px;
    color:#666;
    cursor:pointer;
    border-bottom:2px solid transparent;
    font-weight:500;
}
.nav-tab-item.active{
    color:#D94659;
    border-bottom-color:#D94659;
    font-weight:bold;
    background:#fff;
}

/* 页面内容区块显隐控制 */
.page-section { display: none; padding: 20px 16px 60px; max-width: 760px; margin: 0 auto; }
.page-section.active { display: block; }

/* 搜索页顶部固定容器（包含搜索框及分类 Tabs） */
.search-sticky-container {
    position: sticky;
    top: 81px;
    z-index: 98;
    background: #F7F8FA;
    padding-top: 10px;
    margin-top: -10px;
    margin-left: -16px;
    margin-right: -16px;
    padding-left: 16px;
    padding-right: 16px;
}

.top{
    margin-bottom:14px;
    background:#fff;
    padding:16px;
    border-radius:8px;
    box-shadow:0 2px 8px rgba(0,0,0,0.06);
}
.page-title{
    font-size:1.1rem;
    font-weight:bold;
    color:#111;
    margin-bottom:12px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
}

/* 标题右侧防和谐提示标签 */
.title-notice-badge {
    background:#FEF3C7;
    color:#D97706;
    padding:2px 8px;
    border-radius:4px;
    font-size:11px;
    font-weight:normal;
    border:1px solid #FCD34D;
    white-space:nowrap;
}

.search{display:flex;height:40px;border-radius:6px;overflow:hidden;border:1px solid #D94659;background:#fff}
.search input{flex:1;border:none;padding:0 14px;font-size:14px;outline:none;background:transparent;font-family:inherit;color:#333}
.search button{padding:0 20px;border:none;background:#D94659;color:#fff;font-size:14px;cursor:pointer;font-family:inherit;font-weight:500;transition:background .15s}
.search button:hover{background:#c0394b}

.tabs{display:flex;gap:0;margin-bottom:18px;position:relative;border-bottom:1px solid #e0d5d0;background:#F7F8FA;padding-top:4px;}
.tab-btn{padding:10px 22px;border:none;background:transparent;color:#888;font-size:.88rem;cursor:pointer;font-family:inherit;position:relative;transition:color .25s ease;letter-spacing:1px}
.tab-btn:hover{color:#D94659}
.tab-btn.active{color:#D94659;font-weight:600}
.tab-indicator{position:absolute;bottom:-1px;height:2px;background:#D94659;border-radius:1px;transition:left .35s cubic-bezier(.4,0,.2,1),width .35s cubic-bezier(.4,0,.2,1)}

.result-list{display:flex;flex-direction:column;min-height:200px}
.result-item{padding:18px 16px;background:#fff;border-radius:6px;margin-bottom:10px;border:1px solid #f0e8e5;box-shadow:0 1px 2px rgba(0,0,0,0.02)}
.result-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.result-title{font-size:1.02rem;font-weight:600;color:#222}
.result-author{font-size:.8rem;color:#888}
.result-tags{display:inline-flex;gap:4px;margin-left:2px}
.result-tags span{font-size:.7rem;color:#D94659;background:#FFF0F2;padding:1px 7px;border-radius:10px}
.result-desc{color:#666;font-size:.85rem;margin-bottom:10px}
.result-links{display:flex;flex-wrap:wrap;gap:6px}
.result-links a{font-size:.78rem;color:#555;text-decoration:none;padding:4px 10px;background:#f7f2f0;border-radius:10px;transition:all .15s;display:inline-block}
.result-links a:hover{background:#D94659;color:#fff}
.result-links a code{font-family:inherit;font-size:.72rem;color:#aaa;margin-left:4px}
.expand-btn{margin-left:auto;background:transparent;border:1px solid #FFD1D8;color:#D94659;padding:3px 10px;border-radius:10px;cursor:pointer;font-size:.78rem}
.expand-btn:hover{background:#FFF0F2}
.author-card .result-desc{margin-top:8px}
.book-item{margin-bottom:6px;display:flex;flex-direction:column;gap:2px}
.book-title{font-size:.92rem;color:#333;font-weight:500}

.empty{text-align:center;color:#ccc;padding:40px 0;font-size:.9rem}
.loading{text-align:center;padding:20px;color:#ccc;font-size:.85rem}

.pagination{display:flex;justify-content:center;gap:6px;margin-top:20px;flex-wrap:wrap}
.pagination button{padding:6px 14px;border:1px solid #ddd;background:#fff;color:#666;font-size:.82rem;cursor:pointer;font-family:inherit;border-radius:4px}
.pagination button:hover:not(:disabled){border-color:#D94659;color:#D94659}
.pagination button:disabled{opacity:.4}
.pagination button.current{background:#D94659;color:#fff;border-color:#D94659}

/* 求书表单（两行） */
.msg-form{background:#fff;padding:16px;border-radius:8px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.02);display:flex;flex-direction:column;gap:10px;}
.msg-form input{padding:10px 12px;border:1px solid #ddd;background:#fff;font-size:14px;font-family:inherit;outline:none;border-radius:6px;color:#333;width:100%;}
.msg-form button{padding:10px 20px;border:1px solid #D94659;background:#D94659;color:#fff;font-size:14px;cursor:pointer;border-radius:6px;font-weight:500;width:100%;}
.msg-form button:hover{background:#c0394b}

/* 社区求书板一级主 Tab */
.req-main-tabs{
    display:flex;
    background:#fff;
    border-radius:8px;
    overflow:hidden;
    margin-bottom:14px;
    border:1px solid #e0d5d0;
    box-shadow:0 1px 2px rgba(0,0,0,0.02);
}
.req-tab-btn{
    flex:1;
    text-align:center;
    padding:12px 0;
    font-size:15px;
    color:#666;
    cursor:pointer;
    border:none;
    background:transparent;
    font-family:inherit;
    font-weight:500;
    border-bottom:2px solid transparent;
    transition:all .2s;
}
.req-tab-btn.active{
    color:#D94659;
    border-bottom-color:#D94659;
    font-weight:bold;
    background:#fff;
}

/* 求书二级筛选与时间下拉栏 */
.req-toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px;}
.filters{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;}
.filters button{padding:5px 12px;border:1px solid #ddd;background:#fff;color:#888;font-size:.78rem;cursor:pointer;border-radius:12px;white-space:nowrap}
.filters button.on{background:#D94659;color:#fff;border-color:#D94659;font-weight:600}

.time-select{
    padding:5px 10px;
    border:1px solid #ddd;
    background:#fff;
    color:#666;
    font-size:.78rem;
    border-radius:12px;
    outline:none;
    cursor:pointer;
    font-family:inherit;
}

.msg-list{display:flex;flex-direction:column;gap:8px}
.msg-item{padding:12px 16px;background:#fff;border:1px solid #f0e8e5;border-radius:6px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.msg-name{font-size:.9rem;font-weight:500;color:#333}
.msg-note-text{font-size:.78rem;color:#888;margin-top:2px}
.msg-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.msg-date{font-size:.72rem;color:#ccc}
.badge{font-size:.7rem;padding:2px 9px;border-radius:10px}
.b-pending{background:#f0eee8;color:#999}
.b-accepted{background:#FFF0F2;color:#D94659}
.b-completed{background:#edf5ed;color:#6a9a6a}
.b-rejected{background:#f5f0ed;color:#b09088}

.footer{text-align:center;margin-top:46px;font-size:.72rem;color:#aaa;line-height:1.6;}
.footer-disclaimer{margin-top:4px;color:#bbb;font-size:.68rem;}
</style>
</head>
<body>

<!-- 全局防搬运暗纹水印 -->
<div class="watermark-layer"></div>

<!-- 顶部防迷路/引流横幅 -->
<div class="safe-notice-bar">
    <div class="safe-notice-content">
        <span>💡 防迷路/求书：</span>微信公众号🔍<span>窝嘟嘟</span> | 微博🔍<span>窝嘟嘟开心崽崽</span>
    </div>
</div>

<!-- 顶层大 Tab 切换导航 -->
<div class="main-nav-tabs">
    <div class="nav-tab-item active" onclick="switchMainTab('search')">📚 小说搜索</div>
    <div class="nav-tab-item" onclick="switchMainTab('request')">💬 社区求书板</div>
</div>

<!-- ================= 模块一：小说搜索页 ================= -->
<div id="section-search" class="page-section active">
  <div class="search-sticky-container">
    <div class="top">
      <div class="page-title">
          <span>小说搜索库</span>
          <span class="title-notice-badge">📌 提示：请先转存网盘，防和谐~</span>
      </div>
      <div class="search">
        <input type="text" id="q" placeholder="书名、作者或标签" onkeydown="if(event.key==='Enter')doSearch()">
        <button onclick="doSearch()">搜 索</button>
      </div>
    </div>

    <div class="tabs" id="tabs">
      <button class="tab-btn active" onclick="switchTab(this,'hot')">热门</button>
      <button class="tab-btn" onclick="switchTab(this,'featured')">精选</button>
      <button class="tab-btn" onclick="switchTab(this,'authors')">作者合集</button>
      <button class="tab-btn" onclick="switchTab(this,'latest')">最新</button>
      <div class="tab-indicator" id="indicator"></div>
    </div>
  </div>

  <div class="result-list" id="resultList"><div class="loading">加载中...</div></div>
  <div class="pagination" id="pagination"></div>
  <div class="footer">
    <div>窝嘟嘟 · 仅提供链接索引，不存储文件</div>
    <div class="footer-disclaimer">免责声明：本站所有内容均为用户分享上传，仅供学习交流使用。如有侵权或涉及版权问题，请联系我们进行删除。</div>
  </div>
</div>

<!-- ================= 模块二：社区求书板 ================= -->
<div id="section-request" class="page-section">
  <div class="msg-form">
    <input type="text" id="msgName" placeholder="想要的小说名称（必填）" onkeydown="if(event.key==='Enter')submitMsg()">
    <input type="text" id="msgNote" placeholder="备注：作者或补充信息（选填）" onkeydown="if(event.key==='Enter')submitMsg()">
    <button onclick="submitMsg()">提交求书留言</button>
  </div>

  <!-- 主 Tab：全部留言 / 我提交的书单 -->
  <div class="req-main-tabs">
    <button class="req-tab-btn active" onclick="switchReqMainTab(this, 'all')">全部留言</button>
    <button class="req-tab-btn" onclick="switchReqMainTab(this, 'mine')">我提交的书单</button>
  </div>

  <!-- 二级工具栏：状态二级分类 + 时间筛选下拉框（仅在全部留言下展示） -->
  <div class="req-toolbar" id="reqToolbar">
    <div class="filters" id="filters">
      <button class="on" onclick="setFilter(this,'all')">全部</button>
      <button onclick="setFilter(this,'pending')">待处理</button>
      <button onclick="setFilter(this,'accepted')">已采纳</button>
      <button onclick="setFilter(this,'completed')">已补充</button>
      <button onclick="setFilter(this,'rejected')">已拒绝</button>
    </div>
    <div>
      <select class="time-select" id="timeSelect" onchange="onTimeFilterChange()">
        <option value="3days" selected>近三天</option>
        <option value="1week">近一周</option>
        <option value="1month">近一个月</option>
        <option value="all">全部时间</option>
      </select>
    </div>
  </div>

  <div class="msg-list" id="msgList"></div>
  <div class="footer">
    <div>窝嘟嘟 · 社区求书板</div>
    <div class="footer-disclaimer">免责声明：本站所有内容均为用户分享上传，仅供学习交流使用。如有侵权或涉及版权问题，请联系我们进行删除。</div>
  </div>
</div>

<script>
let curTab='hot';
let curPage=1;
let reqMainTab='all';   // 'all' 或 'mine'
let curFilter='all';    // 二级状态：all, pending, accepted, completed, rejected
let timeFilter='3days'; // 时间筛选：3days, 1week, 1month, all

let authorsData = [];
let authorsTotal = 0;
let authorsLimit = 5;
const defaultShownBooks = 3;
const expandedAuthors = new Set();
let cachedMessages = [];

// 大 Tab 切换逻辑
function switchMainTab(tabName) {
    document.querySelectorAll('.nav-tab-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.page-section').forEach(el => el.classList.remove('active'));

    if (tabName === 'search') {
        document.querySelectorAll('.nav-tab-item')[0].classList.add('active');
        document.getElementById('section-search').classList.add('active');
    } else {
        document.querySelectorAll('.nav-tab-item')[1].classList.add('active');
        document.getElementById('section-request').classList.add('active');
        loadMsgs();
    }
}

async function loadNovels(){
  const q=document.getElementById('q').value.trim();
  const list=document.getElementById('resultList');
  const pag=document.getElementById('pagination');
  list.innerHTML='<div class="loading">加载中...</div>';
  pag.innerHTML='';
  try{
    if(q){
      const r=await fetch('/api/search?q='+encodeURIComponent(q)+'&page='+curPage);
      const d=await r.json();
      if(!d.results.length){list.innerHTML='<div class="empty">没有找到相关小说</div>';return}
      list.innerHTML=d.results.map(n=>renderNovel(n)).join('');
      renderPagination(d.total,d.page,d.limit);
      return;
    }

    if(curTab === 'authors'){
      const r = await fetch('/api/search?tab=authors&page='+curPage);
      const d = await r.json();
      authorsData = d.results || [];
      authorsTotal = d.total || 0;
      authorsLimit = d.limit || 5;
      renderAuthorsPage(curPage);
      return;
    }

    const r=await fetch('/api/search?tab='+curTab+'&page='+curPage);
    const d=await r.json();
    if(!d.results.length){list.innerHTML='<div class="empty">没有找到相关小说</div>';return}
    list.innerHTML=d.results.map(n=>renderNovel(n)).join('');
    renderPagination(d.total,d.page,d.limit);
  }catch(e){
    list.innerHTML='<div class="empty">加载失败，请重试</div>';
  }
}

function renderAuthorCard(a){
  const key = 'author_' + encodeURIComponent(a.author || '');
  const isExpanded = expandedAuthors.has(key);
  const books = a.novels || [];
  const showCount = isExpanded ? books.length : Math.min(defaultShownBooks, books.length);
  
  let booksHtml = '';
  for(let i=0; i<showCount; i++){
    const b = books[i];
    const links = (b.drive_links||[]).map(l=>'<a href="'+esc(l.url)+'" target="_blank" rel="noopener">'+esc(l.label)+(l.code?'<code>'+esc(l.code)+'</code>':'')+'</a>').join('');
    booksHtml += '<div class="book-item"><div class="book-title">'+esc(b.title)+'</div><div class="result-links">'+links+'</div></div>';
  }

  const toggleBtn = books.length > defaultShownBooks ? '<button class="expand-btn" onclick="toggleAuthor(\\''+key+'\\')">'+(isExpanded? '收起':'展开全部书籍（共 '+books.length+' 本）')+'</button>' : '';
  return '<div class="result-item author-card"><div class="result-head"><span class="result-title">'+esc(a.author)+'</span><span class="result-author">'+(a.count||0)+' 本</span>'+toggleBtn+'</div><div class="result-desc">'+booksHtml+'</div></div>';
}

function renderAuthorsPage(page){
  const list=document.getElementById('resultList');
  const pag=document.getElementById('pagination');
  const total = authorsTotal || authorsData.length;
  const limit = authorsLimit || 5;
  const pages = Math.max(1, Math.ceil(total / limit));
  if(page < 1) page = 1; if(page > pages) page = pages;
  
  if(!authorsData || authorsData.length===0){ list.innerHTML = '<div class="empty">暂无作者</div>'; pag.innerHTML=''; return }
  
  list.innerHTML = authorsData.map(a=>renderAuthorCard(a)).join('');
  let html = '';
  html += '<button '+(page<=1?'disabled':'')+' onclick="goPage('+(page-1)+')">上一页</button>';
  html += '<span style="padding:6px 12px;color:#666">第 '+page+' / '+pages+' 页</span>';
  html += '<button '+(page>=pages?'disabled':'')+' onclick="goPage('+(page+1)+')">下一页</button>';
  pag.innerHTML = html;
}

function toggleAuthor(key){
  if(expandedAuthors.has(key)) expandedAuthors.delete(key); else expandedAuthors.add(key);
  renderAuthorsPage(curPage);
}

function renderNovel(n){
  const tags=(n.tags||[]).map(t=>'<span>'+esc(t)+'</span>').join('');
  const links=(n.drive_links||[]).map(l=>{
    const code=l.code?'<code>'+esc(l.code)+'</code>':'';
    return '<a class="page-link" href="'+esc(l.url)+'" target="_blank" rel="noopener">'+esc(l.label)+code+'</a>';
  }).join('');
  return '<div class="result-item"><div class="result-head"><span class="result-title">'+esc(n.title)+'</span><span class="result-author">'+(n.author?esc(n.author):'')+'</span><span class="result-tags">'+tags+'</span></div><div class="result-desc">'+esc(n.description||'')+'</div><div class="result-links">'+links+'</div></div>';
}

function renderPagination(total,page,limit){
  const pag=document.getElementById('pagination');
  const pages=Math.ceil(total/limit);
  if(pages<=1){pag.innerHTML='';return}
  let html='';
  html+='<button '+(page<=1?'disabled':'')+' onclick="goPage('+(page-1)+')">上一页</button>';
  for(let i=1;i<=pages;i++){
    if(i===1||i===pages||(i>=page-1&&i<=page+1)){
      html+='<button class="'+(i===page?'current':'')+'" onclick="goPage('+i+')">'+i+'</button>';
    }else if(i===page-2||i===page+2){
      html+='<span style="padding:6px 4px;color:#ccc">...</span>';
    }
  }
  html+='<button '+(page>=pages?'disabled':'')+' onclick="goPage('+(page+1)+')">下一页</button>';
  pag.innerHTML=html;
}

function goPage(p){
  curPage=p;
  loadNovels();
  window.scrollTo({top:0,behavior:'smooth'});
}

function switchTab(el,tab){
  curTab=tab;
  curPage=1;
  document.getElementById('q').value='';
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  moveIndicator(el);
  loadNovels();
}

function moveIndicator(el){
  const indicator=document.getElementById('indicator');
  indicator.style.width=el.offsetWidth+'px';
  indicator.style.left=el.offsetLeft+'px';
}

function doSearch(){
  curPage=1;
  loadNovels();
}

function getMyLocalRequests() {
    return JSON.parse(localStorage.getItem('my_book_requests') || '[]');
}

async function loadMsgs(){
  const list=document.getElementById('msgList');
  list.innerHTML='<div class="loading">加载中...</div>';
  try{
    const r=await fetch('/api/messages');
    const d=await r.json();
    cachedMessages = d.results || [];
    renderMessageList();
  }catch(e){list.innerHTML='<div class="empty">加载失败</div>'}
}

function switchReqMainTab(el, type) {
    reqMainTab = type;
    document.querySelectorAll('.req-main-tabs .req-tab-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');

    const toolbar = document.getElementById('reqToolbar');
    if (type === 'mine') {
        toolbar.style.display = 'none';
    } else {
        toolbar.style.display = 'flex';
    }
    renderMessageList();
}

function setFilter(el, s) {
    curFilter = s;
    document.querySelectorAll('#filters button').forEach(b => b.classList.remove('on'));
    el.classList.add('on');
    renderMessageList();
}

function onTimeFilterChange() {
    timeFilter = document.getElementById('timeSelect').value;
    renderMessageList();
}

function renderMessageList() {
    const list = document.getElementById('msgList');
    list.innerHTML = '';

    let targetList = cachedMessages;
    let myIds = getMyLocalRequests();

    if (reqMainTab === 'mine') {
        targetList = cachedMessages.filter(item => myIds.includes(item.id));
        if (targetList.length === 0) {
            list.innerHTML = '<div class="empty">您当前还没有在本机提交过求书哦~</div>';
            return;
        }
    } else {
        if (curFilter !== 'all') {
            if (curFilter === 'completed') {
                targetList = targetList.filter(item => item.status === 'completed' || item.status === 'success');
            } else {
                targetList = targetList.filter(item => item.status === curFilter);
            }
        }

        if (timeFilter !== 'all') {
            const now = new Date();
            let limitDays = 3;
            if (timeFilter === '1week') limitDays = 7;
            if (timeFilter === '1month') limitDays = 30;

            targetList = targetList.filter(item => {
                if (!item.created_at) return false;
                const itemDate = new Date(item.created_at.replace(/-/g, '/'));
                const diffDays = (now - itemDate) / (1000 * 60 * 60 * 24);
                return diffDays <= limitDays;
            });
        }
    }

    if (targetList.length === 0) {
        list.innerHTML = '<div class="empty">暂无相关留言</div>';
        return;
    }

    const cmap={pending:'b-pending',accepted:'b-accepted',completed:'b-completed',rejected:'b-rejected',success:'b-completed'};
    const labels={pending:'待处理',accepted:'已采纳',completed:'已补充',rejected:'已拒绝',success:'已补充'};

    list.innerHTML = targetList.map(m => {
        const date = (m.created_at || '').slice(5, 10);
        const statusKey = m.status || 'pending';
        return '<div class="msg-item"><div class="msg-info"><div class="msg-name">'+esc(m.novel_name)+'</div>'+(m.note?'<div class="msg-note-text">'+esc(m.note)+'</div>':'')+'</div><div class="msg-right"><span class="msg-date">'+date+'</span><span class="badge '+(cmap[statusKey]||'b-pending')+'">'+(labels[statusKey]||'待处理')+'</span></div></div>';
    }).join('');
}

async function submitMsg(){
  const name=document.getElementById('msgName').value.trim();
  const note=document.getElementById('msgNote').value.trim();
  if(!name){alert('请填写小说名称');return}
  try{
    const r=await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({novel_name:name,note})});
    const d=await r.json();
    if(d.error){alert(d.error);return}
    
    if (d.id) {
        let myIds = getMyLocalRequests();
        myIds.push(d.id);
        localStorage.setItem('my_book_requests', JSON.stringify(myIds));
    }

    document.getElementById('msgName').value='';
    document.getElementById('msgNote').value='';
    alert('提交成功！系统正在加急处理，可在【我提交的书单】中随时查看进度。');
    loadMsgs();
  }catch(e){alert('提交失败，请重试')}
}

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

window.addEventListener('load',function(){
  var activeTab=document.querySelector('.tab-btn.active');
  if(activeTab)moveIndicator(activeTab);
  loadNovels();
});
window.addEventListener('resize',function(){
  var activeTab=document.querySelector('.tab-btn.active');
  if(activeTab)moveIndicator(activeTab);
});
</script>
</body>
</html>`

export default app;
