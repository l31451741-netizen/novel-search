import { Hono } from 'hono';

const app = new Hono();

// 首页
app.get('/', (c) => c.html(INDEX_HTML));

// 搜索小说
app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const tab = c.req.query('tab') || 'latest';
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit = 10;
  const offset = (page - 1) * limit;

  const db = c.env.DB;
  let rows, total;

  if (q) {
    // 关键词搜索（FTS5，忽略 tab）
    const ftsQuery = q.split(/\s+/).filter(Boolean).map(s => `"${s}"`).join(' ');
    rows = await db.prepare(
      `SELECT n.id, n.title, n.author, n.description, n.drive_links, n.tags, n.created_at
       FROM novels_fts f JOIN novels n ON n.id = f.rowid
       WHERE novels_fts MATCH ?
       ORDER BY rank LIMIT ? OFFSET ?`
    ).bind(ftsQuery, limit, offset).all();
    const countRes = await db.prepare(
      `SELECT count(*) as c FROM novels_fts WHERE novels_fts MATCH ?`
    ).bind(ftsQuery).first();
    total = countRes?.c || 0;
  } else if (tab === 'hot') {
    // 热门：按热度值排序
    rows = await db.prepare(
      `SELECT id, title, author, description, drive_links, tags, created_at
       FROM novels ORDER BY view_count DESC, created_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    total = (await db.prepare(`SELECT count(*) as c FROM novels`).first())?.c || 0;
  } else if (tab === 'featured') {
    // 精选：只展示标记的
    rows = await db.prepare(
      `SELECT id, title, author, description, drive_links, tags, created_at
       FROM novels WHERE is_featured = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    total = (await db.prepare(`SELECT count(*) as c FROM novels WHERE is_featured = 1`).first())?.c || 0;
  } else {
    // 最新：按时间排序
    rows = await db.prepare(
      `SELECT id, title, author, description, drive_links, tags, created_at
       FROM novels ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    total = (await db.prepare(`SELECT count(*) as c FROM novels`).first())?.c || 0;
  }

  const results = (rows.results || []).map(r => ({
    ...r,
    drive_links: safeParse(r.drive_links, []),
    tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
  }));

  return c.json({ results, total, page, limit });
});

// 留言列表
app.get('/api/messages', async (c) => {
  const status = c.req.query('status') || '';
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit = 20;
  const offset = (page - 1) * limit;

  const db = c.env.DB;
  let rows, total;

  if (status && status !== 'all') {
    rows = await db.prepare(
      `SELECT id, novel_name, note, status, created_at
       FROM messages WHERE status = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(status, limit, offset).all();
    total = (await db.prepare(`SELECT count(*) as c FROM messages WHERE status = ?`).bind(status).first())?.c || 0;
  } else {
    rows = await db.prepare(
      `SELECT id, novel_name, note, status, created_at
       FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    total = (await db.prepare(`SELECT count(*) as c FROM messages`).first())?.c || 0;
  }

  return c.json({ results: rows.results || [], total, page, limit });
});

// 提交留言
app.post('/api/messages', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const name = (body.novel_name || '').trim();
  const note = (body.note || '').trim().slice(0, 500);

  if (!name) return c.json({ error: '请填写小说名称' }, 400);
  if (name.length > 200) return c.json({ error: '名称过长' }, 400);

  const db = c.env.DB;
  await db.prepare(
    `INSERT INTO messages (novel_name, note, status) VALUES (?, ?, 'pending')`
  ).bind(name, note).run();

  return c.json({ ok: true });
});

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>小说搜索</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#faf7f5;color:#4a4a4a;line-height:1.75;font-size:15px}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 60px}
.top{margin-bottom:24px}
.top h1{font-size:1.2rem;font-weight:600;margin-bottom:14px;color:#5a4a4a}
.search{display:flex;border:1px solid #d4c5c0;background:#fff;border-radius:4px;overflow:hidden}
.search input{flex:1;border:none;padding:11px 14px;font-size:14px;outline:none;background:transparent;font-family:inherit;color:#4a4a4a}
.search button{padding:11px 22px;border:none;background:#c97b8a;color:#fff;font-size:14px;cursor:pointer;font-family:inherit;letter-spacing:2px;transition:background .15s}
.search button:hover{background:#b86675}

/* Tab 栏 */
.tabs{display:flex;gap:0;margin-bottom:18px;position:relative;border-bottom:1px solid #e0d5d0}
.tab-btn{padding:10px 22px;border:none;background:transparent;color:#b09a95;font-size:.88rem;cursor:pointer;font-family:inherit;position:relative;transition:color .25s ease;letter-spacing:1px}
.tab-btn:hover{color:#c97b8a}
.tab-btn.active{color:#c97b8a;font-weight:600}
.tab-indicator{position:absolute;bottom:-1px;height:2px;background:#c97b8a;border-radius:1px;transition:left .35s cubic-bezier(.4,0,.2,1),width .35s cubic-bezier(.4,0,.2,1)}

/* 结果列表 */
.result-list{display:flex;flex-direction:column;min-height:200px}
.result-item{padding:18px 16px;background:#fff;border-radius:4px;margin-bottom:10px;border:1px solid #f0e8e5;animation:fadeUp .3s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.result-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.result-title{font-size:1.02rem;font-weight:600;color:#5a4a4a}
.result-author{font-size:.8rem;color:#b09a95}
.result-tags{display:inline-flex;gap:4px;margin-left:2px}
.result-tags span{font-size:.7rem;color:#c97b8a;background:#faf0f2;padding:1px 7px;border-radius:10px}
.result-desc{color:#888;font-size:.85rem;margin-bottom:10px}
.result-links{display:flex;flex-wrap:wrap;gap:6px}
.result-links a{font-size:.78rem;color:#7a6a6a;text-decoration:none;padding:3px 10px;background:#f7f2f0;border-radius:3px;transition:all .15s}
.result-links a:hover{background:#c97b8a;color:#fff}
.result-links a code{font-family:inherit;font-size:.72rem;color:#cbb;margin-left:4px}
.result-links a:hover code{color:#f0d8dd}
.empty{text-align:center;color:#ccc;padding:40px 0;font-size:.9rem}
.loading{text-align:center;padding:20px;color:#ccc;font-size:.85rem}

/* 分页 */
.pagination{display:flex;justify-content:center;gap:6px;margin-top:20px;flex-wrap:wrap}
.pagination button{padding:6px 14px;border:1px solid #d4c5c0;background:#fff;color:#7a6a6a;font-size:.82rem;cursor:pointer;font-family:inherit;border-radius:4px;transition:all .15s}
.pagination button:hover:not(:disabled){border-color:#c97b8a;color:#c97b8a}
.pagination button:disabled{opacity:.4;cursor:default}
.pagination button.current{background:#c97b8a;color:#fff;border-color:#c97b8a}

/* 留言 */
.divider{border:none;border-top:1px dashed #e0d5d0;margin:34px 0 22px}
.sec-label{font-size:.78rem;color:#b09a95;margin-bottom:14px;letter-spacing:1.5px}
.msg-form{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}
.msg-form input{padding:9px 12px;border:1px solid #d4c5c0;background:#fff;font-size:14px;font-family:inherit;outline:none;border-radius:4px;color:#4a4a4a}
.msg-form input:focus{border-color:#c97b8a}
.msg-form input:nth-child(1){width:190px}
.msg-form input:nth-child(2){flex:1;min-width:160px}
.msg-form button{padding:9px 20px;border:1px solid #c97b8a;background:#fff;color:#c97b8a;font-size:14px;cursor:pointer;font-family:inherit;border-radius:4px;transition:all .15s}
.msg-form button:hover{background:#c97b8a;color:#fff}
.filters{display:flex;gap:2px;margin-bottom:14px}
.filters button{padding:3px 12px;border:none;background:transparent;color:#b09a95;font-size:.78rem;cursor:pointer;font-family:inherit;border-radius:12px;transition:all .15s}
.filters button:hover{color:#c97b8a}
.filters button.on{background:#faf0f2;color:#c97b8a;font-weight:600}
.msg-list{display:flex;flex-direction:column;gap:8px}
.msg-item{padding:12px 16px;background:#fff;border:1px solid #f0e8e5;border-radius:4px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.msg-info{flex:1}
.msg-name{font-size:.9rem;font-weight:500;color:#5a4a4a}
.msg-note-text{font-size:.78rem;color:#aaa}
.msg-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.msg-date{font-size:.72rem;color:#ccc}
.badge{font-size:.7rem;padding:2px 9px;border-radius:10px;font-weight:500}
.b-pending{background:#f0eee8;color:#999}
.b-accepted{background:#fbf0f0;color:#c97b8a}
.b-completed{background:#edf5ed;color:#6a9a6a}
.b-rejected{background:#f5f0ed;color:#b09088}
.footer{text-align:center;margin-top:46px;font-size:.72rem;color:#ccc}
@media(max-width:580px){.msg-item{flex-direction:column;align-items:flex-start}.msg-right{align-self:flex-end}.msg-form input:nth-child(1){width:100%}.tab-btn{padding:10px 16px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>小说搜索</h1>
    <div class="search">
      <input type="text" id="q" placeholder="书名、作者或标签" onkeydown="if(event.key==='Enter')doSearch()">
      <button onclick="doSearch()">搜 索</button>
    </div>
  </div>

  <!-- Tab 栏 -->
  <div class="tabs" id="tabs">
    <button class="tab-btn active" onclick="switchTab(this,'hot')">热门</button>
    <button class="tab-btn" onclick="switchTab(this,'featured')">精选</button>
    <button class="tab-btn" onclick="switchTab(this,'latest')">最新</button>
    <div class="tab-indicator" id="indicator"></div>
  </div>

  <!-- 结果列表 -->
  <div class="result-list" id="resultList"><div class="loading">加载中...</div></div>

  <!-- 分页 -->
  <div class="pagination" id="pagination"></div>

  <hr class="divider">

  <div class="sec-label">求书留言</div>
  <div class="msg-form">
    <input type="text" id="msgName" placeholder="小说名称" onkeydown="if(event.key==='Enter')submitMsg()">
    <input type="text" id="msgNote" placeholder="备注（选填）" onkeydown="if(event.key==='Enter')submitMsg()">
    <button onclick="submitMsg()">提 交</button>
  </div>

  <div class="filters" id="filters">
    <button class="on" onclick="setFilter(this,'all')">全部</button>
    <button onclick="setFilter(this,'pending')">待处理</button>
    <button onclick="setFilter(this,'accepted')">已采纳</button>
    <button onclick="setFilter(this,'completed')">已补充</button>
    <button onclick="setFilter(this,'rejected')">已拒绝</button>
  </div>

  <div class="msg-list" id="msgList"></div>

  <div class="footer">仅提供链接索引，不存储文件</div>
</div>

<script>
let curTab='hot';
let curPage=1;
let curFilter='all';

// === 小说列表加载 ===
async function loadNovels(){
  const q=document.getElementById('q').value.trim();
  const list=document.getElementById('resultList');
  const pag=document.getElementById('pagination');
  list.innerHTML='<div class="loading">加载中...</div>';
  pag.innerHTML='';
  try{
    const url=q
      ?'/api/search?q='+encodeURIComponent(q)+'&page='+curPage
      :'/api/search?tab='+curTab+'&page='+curPage;
    const r=await fetch(url);
    const d=await r.json();
    if(!d.results.length){list.innerHTML='<div class="empty">没有找到相关小说</div>';return}
    list.innerHTML=d.results.map(n=>renderNovel(n)).join('');
    renderPagination(d.total,d.page,d.limit);
  }catch(e){list.innerHTML='<div class="empty">加载失败，请重试</div>'}
}

function renderNovel(n){
  const tags=(n.tags||[]).map(t=>'<span>'+esc(t)+'</span>').join('');
  const links=(n.drive_links||[]).map(l=>{
    const code=l.code?'<code>'+esc(l.code)+'</code>':'';
    return '<a href="'+esc(l.url)+'" target="_blank" rel="noopener">'+esc(l.label)+code+'</a>';
  }).join('');
  return '<div class="result-item"><div class="result-head"><span class="result-title">'+esc(n.title)+'</span><span class="result-author">'+(n.author?esc(n.author):'')+'</span><span class="result-tags">'+tags+'</span></div><div class="result-desc">'+esc(n.description||'')+'</div><div class="result-links">'+links+'</div></div>';
}

// === 分页 ===
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

// === Tab 切换 ===
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

// === 搜索 ===
function doSearch(){
  curPage=1;
  loadNovels();
}

// === 留言 ===
async function loadMsgs(){
  const list=document.getElementById('msgList');
  list.innerHTML='<div class="loading">加载中...</div>';
  try{
    const r=await fetch('/api/messages?status='+curFilter);
    const d=await r.json();
    if(!d.results.length){list.innerHTML='<div class="empty">暂无留言</div>';return}
    list.innerHTML=d.results.map(m=>{
      const cmap={pending:'b-pending',accepted:'b-accepted',completed:'b-completed',rejected:'b-rejected'};
      const labels={pending:'待处理',accepted:'已采纳',completed:'已补充',rejected:'已拒绝'};
      const date=(m.created_at||'').slice(5,10);
      return '<div class="msg-item"><div class="msg-info"><div class="msg-name">'+esc(m.novel_name)+'</div>'+(m.note?'<div class="msg-note-text">'+esc(m.note)+'</div>':'')+'</div><div class="msg-right"><span class="msg-date">'+date+'</span><span class="badge '+cmap[m.status]+'">'+labels[m.status]+'</span></div></div>';
    }).join('');
  }catch(e){list.innerHTML='<div class="empty">加载失败</div>'}
}

async function submitMsg(){
  const name=document.getElementById('msgName').value.trim();
  const note=document.getElementById('msgNote').value.trim();
  if(!name){alert('请填写小说名称');return}
  try{
    const r=await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({novel_name:name,note})});
    const d=await r.json();
    if(d.error){alert(d.error);return}
    document.getElementById('msgName').value='';
    document.getElementById('msgNote').value='';
    loadMsgs();
  }catch(e){alert('提交失败，请重试')}
}

function setFilter(el,s){
  curFilter=s;
  document.querySelectorAll('#filters button').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  loadMsgs();
}

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

// === 初始化 ===
window.addEventListener('load',function(){
  var activeTab=document.querySelector('.tab-btn.active');
  if(activeTab)moveIndicator(activeTab);
  loadNovels();
  loadMsgs();
});
window.addEventListener('resize',function(){
  var activeTab=document.querySelector('.tab-btn.active');
  if(activeTab)moveIndicator(activeTab);
});
</script>
</body>
</html>`;

export default app;
