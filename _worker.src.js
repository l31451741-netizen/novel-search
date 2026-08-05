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
  const limit = 20;
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
  await db.prepare(`INSERT INTO messages (novel_name, note, status, created_at) VALUES (?, ?, 'pending', datetime('now'))`).bind(name, note).run();
  return c.json({ ok: true });
});

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
.tabs{display:flex;gap:0;margin-bottom:18px;position:relative;border-bottom:1px solid #e0d5d0}
.tab-btn{padding:10px 22px;border:none;background:transparent;color:#b09a95;font-size:.88rem;cursor:pointer;font-family:inherit;position:relative;transition:color .25s ease;letter-spacing:1px}
.tab-btn:hover{color:#c97b8a}
.tab-btn.active{color:#c97b8a;font-weight:600}
.tab-indicator{position:absolute;bottom:-1px;height:2px;background:#c97b8a;border-radius:1px;transition:left .35s cubic-bezier(.4,0,.2,1),width .35s cubic-bezier(.4,0,.2,1)}
.result-list{display:flex;flex-direction:column;min-height:200px}
.result-item{padding:18px 16px;background:#fff;border-radius:4px;margin-bottom:10px;border:1px solid #f0e8e5}
.result-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px;flex-wrap:wrap}
.result-title{font-size:1.02rem;font-weight:600;color:#5a4a4a}
.result-author{font-size:.8rem;color:#b09a95}
.result-tags{display:inline-flex;gap:4px;margin-left:2px}
.result-tags span{font-size:.7rem;color:#c97b8a;background:#faf0f2;padding:1px 7px;border-radius:10px}
.result-desc{color:#888;font-size:.85rem;margin-bottom:10px}
.result-links{display:flex;flex-wrap:wrap;gap:6px}
.result-links a{font-size:.78rem;color:#7a6a6a;text-decoration:none;padding:4px 10px;background:#f7f2f0;border-radius:10px;transition:all .15s;display:inline-block}
.result-links a:hover{background:#c97b8a;color:#fff}
.result-links a code{font-family:inherit;font-size:.72rem;color:#cbb;margin-left:4px}
.expand-btn{margin-left:auto;background:transparent;border:1px solid #e6d6d3;color:#7a6a6a;padding:3px 10px;border-radius:10px;cursor:pointer;font-size:.78rem}
.expand-btn:hover{background:#faf0f2;color:#c97b8a;border-color:#c97b8a}
.author-card .result-desc{margin-top:8px}
.book-item{margin-bottom:6px;display:flex;flex-direction:column;gap:2px}
.book-title{font-size:.92rem;color:#5a4a4a;font-weight:500}
.empty{text-align:center;color:#ccc;padding:40px 0;font-size:.9rem}
.loading{text-align:center;padding:20px;color:#ccc;font-size:.85rem}
.pagination{display:flex;justify-content:center;gap:6px;margin-top:20px;flex-wrap:wrap}
.pagination button{padding:6px 14px;border:1px solid #d4c5c0;background:#fff;color:#7a6a6a;font-size:.82rem;cursor:pointer;font-family:inherit;border-radius:4px}
.pagination button:hover:not(:disabled){border-color:#c97b8a;color:#c97b8a}
.pagination button:disabled{opacity:.4}
.pagination button.current{background:#c97b8a;color:#fff;border-color:#c97b8a}
.divider{border:none;border-top:1px dashed #e0d5d0;margin:34px 0 22px}
.sec-label{font-size:.78rem;color:#b09a95;margin-bottom:14px;letter-spacing:1.5px}
.msg-form{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}
.msg-form input{padding:9px 12px;border:1px solid #d4c5c0;background:#fff;font-size:14px;font-family:inherit;outline:none;border-radius:4px;color:#4a4a4a}
.msg-form input:nth-child(1){width:190px}
.msg-form input:nth-child(2){flex:1;min-width:160px}
.msg-form button{padding:9px 20px;border:1px solid #c97b8a;background:#fff;color:#c97b8a;font-size:14px;cursor:pointer;border-radius:4px}
.msg-form button:hover{background:#c97b8a;color:#fff}
.filters{display:flex;gap:2px;margin-bottom:14px}
.filters button{padding:3px 12px;border:none;background:transparent;color:#b09a95;font-size:.78rem;cursor:pointer;border-radius:12px}
.filters button.on{background:#faf0f2;color:#c97b8a;font-weight:600}
.msg-list{display:flex;flex-direction:column;gap:8px}
.msg-item{padding:12px 16px;background:#fff;border:1px solid #f0e8e5;border-radius:4px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.msg-name{font-size:.9rem;font-weight:500;color:#5a4a4a}
.msg-note-text{font-size:.78rem;color:#aaa}
.msg-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.msg-date{font-size:.72rem;color:#ccc}
.badge{font-size:.7rem;padding:2px 9px;border-radius:10px}
.b-pending{background:#f0eee8;color:#999}
.b-accepted{background:#fbf0f0;color:#c97b8a}
.b-completed{background:#edf5ed;color:#6a9a6a}
.b-rejected{background:#f5f0ed;color:#b09088}
.footer{text-align:center;margin-top:46px;font-size:.72rem;color:#ccc}

/* 右下角悬浮按钮样式 */
.float-btn{position:fixed;right:24px;bottom:30px;background:#c97b8a;color:#fff;border:none;padding:12px 18px;border-radius:30px;font-size:.85rem;cursor:pointer;box-shadow:0 4px 12px rgba(201,123,138,0.35);z-index:99;font-family:inherit;transition:all .2s;letter-spacing:1px}
.float-btn:hover{background:#b86675;transform:translateY(-2px);box-shadow:0 6px 16px rgba(201,123,138,0.45)}
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

  <div class="tabs" id="tabs">
    <button class="tab-btn active" onclick="switchTab(this,'hot')">热门</button>
    <button class="tab-btn" onclick="switchTab(this,'featured')">精选</button>
    <button class="tab-btn" onclick="switchTab(this,'authors')">作者合集</button>
    <button class="tab-btn" onclick="switchTab(this,'latest')">最新</button>
    <div class="tab-indicator" id="indicator"></div>
  </div>

  <div class="result-list" id="resultList"><div class="loading">加载中...</div></div>
  <div class="pagination" id="pagination"></div>

  <hr class="divider" id="msgSection">
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

<!-- 右下角悬浮按钮 -->
<button class="float-btn" onclick="scrollToMsg()">求书留言</button>

<script>
let curTab='hot';
let curPage=1;
let curFilter='all';
let authorsData = [];
let authorsTotal = 0;
let authorsLimit = 5;
const defaultShownBooks = 3;
const expandedAuthors = new Set();

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
  html += '<span style="padding:6px 12px;color:#7a6a6a">第 '+page+' / '+pages+' 页</span>';
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

function scrollToMsg(){
  const el = document.getElementById('msgSection');
  if(el){
    el.scrollIntoView({behavior:'smooth'});
    document.getElementById('msgName').focus();
  }
}

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
</html>`

export default app;
