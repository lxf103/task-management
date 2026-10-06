const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApi } = require('./api');
const db = require('./db');

const DATA_FILE = path.join(__dirname, 'task-data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

function loadFromFile() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { tasks: data.tasks || [], users: data.users || [], nextId: data.nextId || 1, templates: data.templates || [] };
  } catch (e) {
    return { tasks: [], users: [], nextId: 1, templates: [] };
  }
}

// 运行时内存状态（真源）；启动时从 DB 或文件加载
let tasks = [], users = [], nextId = 1, templates = [];

function getState() { return { tasks, users, nextId, templates }; }

function saveData() {
  if (db.hasDb) {
    db.saveState(getState()).catch(e => console.log('[db] saveState error:', e.message));
  } else {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(getState(), null, 2), 'utf8'); } catch (e) {}
  }
}

// 启动时初始化存储：优先 DB，DB 空则用文件数据播种
async function initStore() {
  await db.init();
  if (db.hasDb) {
    const state = await db.loadState();
    if (state) {
      tasks = state.tasks || []; users = state.users || []; nextId = state.nextId || 1; templates = state.templates || [];
      console.log('[db] loaded state from Postgres');
    } else {
      const f = loadFromFile();
      tasks = f.tasks; users = f.users; nextId = f.nextId; templates = f.templates;
      await db.saveState(getState());
      console.log('[db] seeded Postgres from task-data.json');
    }
  } else {
    const f = loadFromFile();
    tasks = f.tasks; users = f.users; nextId = f.nextId; templates = f.templates;
    console.log('[file] using JSON file storage');
  }

  // 确保超管存在（由 ADMIN_USERNAME 环境变量指定）
  const adminName = process.env.ADMIN_USERNAME;
  if (adminName) {
    const admin = users.find(u => u.username === adminName);
    if (admin) {
      if (!admin.isAdmin || !admin.isSuperAdmin) { admin.isAdmin = true; admin.isSuperAdmin = true; saveData(); console.log('[admin] promoted ' + adminName + ' to super admin'); }
      else { console.log('[admin] ' + adminName + ' is super admin'); }
    } else {
      console.log('[admin] ADMIN_USERNAME "' + adminName + '" not found in users yet (register it first)');
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseCookies(req) {
  const cookies = {};
  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      cookies[parts[0].trim()] = (parts[1] || '').trim();
    });
  }
  return cookies;
}

function setCookie(res, name, value) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly`);
}

function sendHTML(res, html) {
  res.writeHead(200, {'Content-Type': 'text/html; charset=UTF-8'});
  res.end(html);
}

function redirect(res, url) {
  res.writeHead(302, {'Location': url});
  res.end();
}

function isExpired(task) {
  return task.deadline && new Date(task.deadline) < new Date() && !task.claimed;
}

function getStatus(task) {
  if (isExpired(task)) return 'expired';
  if (task.confirmedAt) return 'confirmed';
  if (task.completedAt) return 'completed';
  if (task.claimed) return 'claimed';
  return 'available';
}

function getStatusBadge(task) {
  const status = getStatus(task);
  if (status === 'expired') return '<span class="status-badge status-expired">已过期</span>';
  if (status === 'confirmed') return '<span class="status-badge status-confirmed">已完成</span>';
  if (status === 'completed') return '<span class="status-badge status-completed">待确认</span>';
  if (status === 'claimed') return '<span class="status-badge status-claimed">已领取</span>';
  return '<span class="status-badge status-available">待领取</span>';
}

function renderStars(rating) {
  let s = '';
  for (let i = 1; i <= 5; i++) {
    s += i <= rating ? '<span class="star filled">&#9733;</span>' : '<span class="star">&#9734;</span>';
  }
  return s;
}

function getUserReputation(username) {
  const ratedTasks = tasks.filter(t => t.confirmedAt && t.rating && (t.publisher === username || t.claimer === username));
  if (ratedTasks.length === 0) return { score: 0, level: '新手', color: '#999' };
  const avgRating = ratedTasks.reduce((sum, t) => sum + t.rating, 0) / ratedTasks.length;
  const score = avgRating * Math.log(ratedTasks.length + 1) * 10;
  let level = '普通', color = '#666';
  if (score >= 80) { level = '金牌'; color = '#f59e0b'; }
  else if (score >= 60) { level = '银牌'; color = '#94a3b8'; }
  else if (score >= 40) { level = '铜牌'; color = '#cd7f32'; }
  else if (score >= 20) { level = '普通'; color = '#3b82f6'; }
  else { level = '新手'; color = '#999'; }
  return { score: Math.round(score), level, color };
}

function renderUserBadge(username) {
  const rep = getUserReputation(username);
  return `<span class="user-badge" style="background:${rep.color};">${rep.level} ${rep.score}分</span>`;
}

function renderTaskCard(task, currentUser, isAdmin) {
  const status = getStatus(task);
  const expired = status === 'expired';
  const pinned = task.pinned;
  const cls = expired ? 'task task-expired' : (task.claimed ? 'task task-claimed' : 'task') + (pinned ? ' task-pinned' : '');

  let html = '<div class="' + cls + '">';
  if (pinned) {
    html += '<div class="pinned-ind">📌 置顶</div>';
  }
  html += '<div class="task-header"><div class="task-title">' + escapeHtml(task.description) + '</div><div class="task-id">#' + task.id + '</div></div>';
  html += '<div class="task-time">发布于 ' + new Date(task.createdAt).toLocaleString('zh-CN') + '</div>';

  if (task.category) {
    html += '<div class="category-tag">' + escapeHtml(task.category) + '</div>';
  }

  if (task.region) {
    html += '<div class="region-tag" style="display:inline-block;background:#f0f9ff;color:#0369a1;padding:3px 10px;border-radius:12px;font-size:12px;margin:5px 5px 0 0;">📍 ' + escapeHtml(task.region) + '</div>';
  }

  html += '<div class="task-details">';
  html += '<div class="detail-item"><div class="detail-label">发布人</div><div class="detail-value">' + escapeHtml(task.publisher) + ' ' + renderUserBadge(task.publisher) + '</div></div>';
  html += '<div class="detail-item"><div class="detail-label">交付方式</div><div class="detail-value">' + escapeHtml(task.delivery) + '</div></div>';
  html += '<div class="detail-item"><div class="detail-label">报酬</div><div class="detail-value task-reward">' + escapeHtml(task.reward) + '</div></div>';
  html += '<div class="detail-item"><div class="detail-label">状态</div><div class="detail-value">' + getStatusBadge(task) + '</div></div>';

  if (task.deadline) {
    html += '<div class="detail-item"><div class="detail-label">截止时间</div><div class="detail-value' + (expired ? ' deadline-expired' : '') + '">' + new Date(task.deadline).toLocaleString('zh-CN') + '</div></div>';
  }

  if (task.claimed && task.claimer) {
    html += '<div class="detail-item"><div class="detail-label">领取人</div><div class="detail-value claimer-name">' + escapeHtml(task.claimer) + ' ' + renderUserBadge(task.claimer) + '</div></div>';
  }

  if (task.rating) {
    html += '<div class="detail-item"><div class="detail-label">评分</div><div class="detail-value">' + renderStars(task.rating) + '</div></div>';
  }

  html += '</div>';

  if (task.attachments && task.attachments.length > 0) {
    html += '<div class="attachments">';
    task.attachments.forEach(att => {
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(att.originalName);
      if (isImage) {
        html += '<div class="attachment-preview"><img src="/uploads/' + att.savedName + '" alt="' + escapeHtml(att.originalName) + '"></div>';
      } else {
        html += '<div class="attachment-file"><a href="/uploads/' + att.savedName + '" download="' + escapeHtml(att.originalName) + '">📎 ' + escapeHtml(att.originalName) + '</a></div>';
      }
    });
    html += '</div>';
  }

  if (task.completedAt && !task.confirmedAt && task.publisher === currentUser) {
    html += '<a href="/confirm?id=' + task.id + '" class="confirm-btn" onclick="return confirm(\'确认任务已完成？\')">确认完成</a>';
  }

  if (task.completedAt && !task.confirmedAt && task.claimer === currentUser) {
    html += '<span class="waiting-text">等待发布人确认...</span>';
  }

  if (task.confirmedAt && !task.rating && (task.claimer === currentUser || task.publisher === currentUser)) {
    html += '<a href="/rate?id=' + task.id + '" class="rate-btn">评分</a>';
  }

  if (task.confirmedAt && task.rating) {
    html += '<div class="rating-display">评分：' + renderStars(task.rating) + '</div>';
  }

  if (task.claimed && !task.completedAt && task.claimer === currentUser && !expired) {
    html += '<a href="/complete?id=' + task.id + '" class="complete-btn" onclick="return confirm(\'标记任务已完成？\')">标记完成</a>';
  }

  if (task.claimed && task.claimer && !task.completedAt) {
    html += '<a href="/message?id=' + task.id + '" class="message-btn">留言 (' + (task.messages ? task.messages.length : 0) + ')</a>';
  }

  if (task.publisher === currentUser && !task.claimed && !expired) {
    html += '<a href="/edit?id=' + task.id + '" class="edit-btn">编辑</a>';
    html += '<a href="/delete?id=' + task.id + '" class="delete-btn" onclick="return confirm(\'确定删除这个任务吗？\')">删除</a>';
  }

  if (!task.claimed && !expired && task.publisher !== currentUser) {
    html += '<a href="/claim?id=' + task.id + '" class="claim-btn">领取任务</a>';
  }

  if (expired && task.publisher === currentUser) {
    html += '<a href="/delete?id=' + task.id + '" class="delete-btn" onclick="return confirm(\'确定删除这个过期任务吗？\')">删除</a>';
  }

  if (isAdmin && !pinned) {
    html += '<a href="/pin?id=' + task.id + '" class="pin-btn">📌 置顶</a>';
  }
  if (isAdmin && pinned) {
    html += '<a href="/unpin?id=' + task.id + '" class="unpin-btn">取消置顶</a>';
  }

  html += '</div>';
  return html;
}

function pageShell(title, bodyHtml, currentUser, navLinks) {
  let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="manifest" href="/manifest.json"><link rel="icon" href="/icon-192.png"><title>' + escapeHtml(title) + '</title>' + style + '</head><body><div class="container">';
  if (currentUser) {
    const user = users.find(u => u.username === currentUser);
    const isAdmin = user && (user.isAdmin || user.isSuperAdmin);
    html += '<div class="user-info">当前用户：<strong>' + escapeHtml(currentUser) + '</strong> ' + renderUserBadge(currentUser);
    html += ' <a href="/profile" class="profile-btn">个人中心</a>';
    if (isAdmin) html += ' <a href="/admin" class="admin-btn">管理后台</a>';
    html += ' <a href="/logout" class="logout-btn">退出登录</a></div>';
  }
  if (navLinks) {
    html += '<div class="nav">';
    navLinks.forEach(link => {
      html += '<a href="' + link.href + '">' + escapeHtml(link.text) + '</a>';
    });
    html += '</div>';
  }
  html += bodyHtml;
  html += '</div>';
  html += '</body></html>';
  return html;
}

function parseMultipart(buffer, boundary) {
  const fields = {};
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = buffer.indexOf(boundaryBuffer);
  if (start === -1) return fields;

  while (start !== -1) {
    const partStart = start + boundaryBuffer.length;
    let partEnd = buffer.indexOf(boundaryBuffer, partStart);
    if (partEnd === -1) break;

    const part = buffer.slice(partStart, partEnd);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = partEnd; continue; }

    const headers = part.slice(0, headerEnd).toString('utf8');
    let content = part.slice(headerEnd + 4);
    if (content.length >= 2 && content[content.length - 2] === 13 && content[content.length - 1] === 10) {
      content = content.slice(0, content.length - 2);
    }

    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch) { start = partEnd; continue; }
    const name = nameMatch[1];

    const filenameMatch = headers.match(/filename="([^"]*)"/);
    if (filenameMatch && filenameMatch[1]) {
      const originalName = filenameMatch[1];
      const ext = path.extname(originalName);
      const savedName = Date.now() + '-' + Math.random().toString(36).substr(2, 9) + ext;
      fs.writeFileSync(path.join(UPLOADS_DIR, savedName), content);
      fields[name] = { originalName, savedName, path: '/uploads/' + savedName };
    } else {
      fields[name] = content.toString('utf8');
    }

    start = partEnd;
  }
  return fields;
}

const style = `<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    .header { background: white; padding: 30px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); margin-bottom: 30px; text-align: center; }
    h1 { color: #667eea; font-size: 32px; margin-bottom: 10px; }
    .subtitle { color: #666; font-size: 14px; }
    .user-info { background: #f0f9ff; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; font-size: 16px; color: #0369a1; }
    .user-info strong { color: #0c4a6e; }
    .user-badge { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; color: white; margin-left: 8px; }
    .profile-btn, .admin-btn { background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; margin-left: 8px; text-decoration: none; }
    .admin-btn { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
    .nav { background: white; padding: 20px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 30px; display: flex; justify-content: center; gap: 15px; flex-wrap: wrap; }
    .nav a { color: #667eea; text-decoration: none; font-size: 15px; font-weight: 600; padding: 10px 18px; border-radius: 8px; transition: all 0.3s; }
    .nav a:hover { background: #667eea; color: white; }
    .stats { background: white; padding: 20px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 30px; display: flex; justify-content: space-around; flex-wrap: wrap; gap: 20px; }
    .stat-item { text-align: center; }
    .stat-number { font-size: 32px; font-weight: bold; color: #667eea; }
    .stat-label { font-size: 13px; color: #888; margin-top: 5px; }
    .task { background: white; padding: 25px; margin-bottom: 20px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); transition: transform 0.2s; }
    .task:hover { transform: translateY(-3px); box-shadow: 0 10px 25px rgba(0,0,0,0.15); }
    .task-claimed { border-left: 4px solid #10b981; }
    .task-expired { opacity: 0.5; border-left: 4px solid #999; }
    .task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px; }
    .task-title { font-size: 20px; font-weight: bold; color: #333; flex: 1; }
    .task-id { background: #667eea; color: white; padding: 5px 12px; border-radius: 20px; font-size: 14px; }
    .task-time { font-size: 12px; color: #999; margin-top: 5px; }
    .task-details { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin: 20px 0; }
    .detail-item { display: flex; flex-direction: column; }
    .detail-label { font-size: 12px; color: #888; text-transform: uppercase; margin-bottom: 5px; }
    .detail-value { font-size: 16px; color: #333; font-weight: 500; }
    .task-reward { color: #f59e0b; font-size: 18px; font-weight: bold; }
    .claimer-name { color: #10b981; font-weight: bold; }
    .deadline-expired { color: #ef4444; }
    .category-tag { display: inline-block; background: #ede9fe; color: #7c3aed; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; margin-top: 8px; }
    .status-badge { display: inline-block; padding: 6px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; }
    .status-available { background: #dbeafe; color: #1e40af; }
    .status-claimed { background: #d1fae5; color: #065f46; }
    .status-completed { background: #fef3c7; color: #92400e; }
    .status-confirmed { background: #d1fae5; color: #065f46; }
    .status-expired { background: #f3f4f6; color: #6b7280; }
    .claim-btn { display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 15px; transition: all 0.3s; box-shadow: 0 4px 10px rgba(16,185,129,0.3); }
    .claim-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 15px rgba(16,185,129,0.4); }
    .complete-btn { display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 10px; margin-right: 8px; transition: all 0.3s; }
    .complete-btn:hover { transform: translateY(-2px); }
    .confirm-btn { display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 10px; margin-right: 8px; transition: all 0.3s; }
    .confirm-btn:hover { transform: translateY(-2px); }
    .edit-btn { display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; margin-right: 8px; margin-top: 10px; transition: all 0.3s; }
    .edit-btn:hover { transform: translateY(-2px); }
    .delete-btn { display: inline-block; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; margin-top: 10px; transition: all 0.3s; }
    .delete-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 10px rgba(239,68,68,0.3); }
    .rate-btn { display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #eab308 100%); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; margin-top: 10px; margin-right: 8px; transition: all 0.3s; }
    .rate-btn:hover { transform: translateY(-2px); }
    .message-btn { display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; margin-top: 10px; margin-right: 8px; transition: all 0.3s; }
    .message-btn:hover { transform: translateY(-2px); }
    .pin-btn { display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; margin-top: 10px; margin-right: 8px; transition: all 0.3s; }
    .pin-btn:hover { transform: translateY(-2px); }
    .unpin-btn { display: inline-block; background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; margin-top: 10px; margin-right: 8px; transition: all 0.3s; }
    .unpin-btn:hover { transform: translateY(-2px); }
    .task-pinned { border-left: 4px solid #f59e0b; background: #fffbeb; }
    .pinned-ind { background: #f59e0b; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; display: inline-block; margin-bottom: 10px; }
    .waiting-text { display: inline-block; color: #f59e0b; font-weight: 600; margin-top: 10px; font-style: italic; }
    .rating-display { margin-top: 10px; font-size: 16px; }
    .star { font-size: 20px; color: #d1d5db; }
    .star.filled { color: #f59e0b; }
    .messages-section { background: #f9fafb; border-radius: 10px; padding: 15px; margin-top: 15px; }
    .messages-section h3 { color: #667eea; margin-bottom: 10px; font-size: 16px; }
    .message-item { background: white; padding: 10px 15px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid #667eea; }
    .message-item .msg-user { font-weight: bold; color: #667eea; font-size: 13px; }
    .message-item .msg-text { color: #333; margin-top: 4px; }
    .message-item .msg-time { color: #999; font-size: 11px; margin-top: 4px; }
    .empty-state { background: white; padding: 60px 20px; border-radius: 15px; text-align: center; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
    .empty-state p { color: #888; font-size: 18px; }
    form { background: white; padding: 30px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
    label { display: block; margin-top: 20px; font-weight: 600; color: #333; font-size: 15px; }
    input, select, textarea { width: 100%; padding: 12px; margin-top: 8px; border: 2px solid #e5e7eb; border-radius: 8px; font-size: 15px; font-family: inherit; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #667eea; }
    textarea { min-height: 80px; resize: vertical; }
    button[type="submit"] { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 14px 30px; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: 600; margin-top: 25px; width: 100%; }
    .success-message { background: white; padding: 40px; border-radius: 15px; text-align: center; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
    .success-icon { font-size: 60px; margin-bottom: 20px; }
    .back-btn { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 16px; margin-top: 30px; box-shadow: 0 4px 15px rgba(102,126,234,0.4); transition: all 0.3s; }
    .back-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102,126,234,0.5); }
    .back-container { text-align: center; margin-top: 30px; }
    .section-title { color: white; font-size: 24px; margin-bottom: 20px; margin-top: 30px; }
    .filter-bar { background: white; padding: 20px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 30px; display: flex; gap: 15px; flex-wrap: wrap; align-items: center; }
    .filter-bar select { width: auto; min-width: 120px; margin: 0; }
    .filter-bar input { width: auto; flex: 1; min-width: 150px; margin: 0; }
    .login-form { max-width: 400px; margin: 50px auto; }
    .login-form h2 { text-align: center; margin-bottom: 30px; color: #667eea; }
    .error-msg { color: #ef4444; text-align: center; margin-top: 15px; font-size: 14px; }
    .logout-btn { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; margin-left: 10px; text-decoration: none; }
    .rating-select { display: flex; gap: 8px; margin-top: 10px; }
    .rating-select label { margin: 0; cursor: pointer; }
    .rating-select input { width: auto; margin: 0; }
    .attachments { margin: 15px 0; display: flex; gap: 10px; flex-wrap: wrap; }
    .attachment-preview { max-width: 200px; max-height: 200px; border-radius: 8px; overflow: hidden; border: 2px solid #e5e7eb; }
    .attachment-preview img { width: 100%; height: 100%; object-fit: cover; }
    .attachment-file { background: #f3f4f6; padding: 10px 15px; border-radius: 8px; }
    .attachment-file a { color: #667eea; text-decoration: none; font-weight: 600; }
    .template-section { background: white; padding: 20px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .template-section h3 { color: #667eea; margin-bottom: 15px; }
    .template-card { background: #f9fafb; padding: 15px; border-radius: 10px; margin-bottom: 10px; border-left: 4px solid #8b5cf6; cursor: pointer; transition: all 0.3s; }
    .template-card:hover { background: #f3f4f6; transform: translateX(5px); }
    .template-card .template-title { font-weight: 600; color: #333; margin-bottom: 5px; }
    .template-card .template-info { font-size: 13px; color: #666; }
    .template-card .template-actions { margin-top: 10px; }
    .template-card .template-actions button { background: #8b5cf6; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-right: 8px; }
    .template-card .template-actions button.delete { background: #ef4444; }
    .profile-stats { background: white; padding: 30px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .profile-stats h2 { color: #667eea; margin-bottom: 20px; }
    .profile-stats .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
    .profile-stats .stat-box { text-align: center; background: #f9fafb; padding: 20px; border-radius: 10px; }
    .profile-stats .stat-box .number { font-size: 32px; font-weight: bold; color: #667eea; }
    .profile-stats .stat-box .label { font-size: 14px; color: #666; margin-top: 5px; }
    .admin-section { background: white; padding: 30px; border-radius: 15px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .admin-section h2 { color: #667eea; margin-bottom: 20px; }
    .admin-user-list { display: grid; gap: 10px; }
    .admin-user-item { background: #f9fafb; padding: 15px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; }
    .admin-user-item .user-info { flex: 1; }
    .admin-user-item .user-actions button { background: #ef4444; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-left: 8px; }
    .admin-user-item .user-actions button.unban { background: #10b981; }
    @media (max-width: 600px) {
      .task-details { grid-template-columns: 1fr; }
      .stats { flex-direction: column; }
      .nav { flex-direction: column; align-items: center; }
      .filter-bar { flex-direction: column; }
      .filter-bar select, .filter-bar input { width: 100%; }
      .profile-stats .stat-grid { grid-template-columns: 1fr; }
    }
  </style>`;

const server = http.createServer((req, res) => {
  const cookies = parseCookies(req);
  const currentUser = cookies.username ? decodeURIComponent(cookies.username) : null;
  const url = req.url;

  // ===== API 路由（供小程序调用）=====
  if (url.startsWith('/api/')) {
    const nextIdRef = { get value() { return nextId; }, set value(v) { nextId = v; } };
    return handleApi(req, res, { tasks, users, templates, saveData, nextIdRef, originalUrl: url });
  }

  function collectBody(callback) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => callback(Buffer.concat(chunks)));
  }

  function getParam(params, key) {
    return typeof params.get === 'function' ? params.get(key) : params[key];
  }

  function parseBody(callback) {
    const contentType = req.headers['content-type'] || '';
    collectBody(buffer => {
      if (contentType.includes('multipart/form-data')) {
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
        const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : '';
        callback(parseMultipart(buffer, boundary), true);
      } else {
        callback(new URLSearchParams(buffer.toString('utf8')), false);
      }
    });
  }

  function requireLogin() {
    if (!currentUser) {
      redirect(res, '/login');
      return true;
    }
    const user = users.find(u => u.username === currentUser);
    if (user && user.banned) {
      res.setHeader('Set-Cookie', 'username=; Path=/; HttpOnly; Max-Age=0');
      let body = '<div class="empty-state"><h1>账号已被封禁</h1><p style="margin-top:20px;color:#666;">请联系管理员</p></div>';
      sendHTML(res, pageShell('已封禁', body, null, []));
      return true;
    }
    return false;
  }

  // ===== 静态文件 =====
  if (url === '/manifest.json') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    fs.createReadStream(path.join(__dirname, 'manifest.json')).pipe(res);
    return;
  }
  if (url === '/icon-192.png') {
    res.writeHead(200, {'Content-Type': 'image/png'});
    fs.createReadStream(path.join(__dirname, 'icon-192.png')).pipe(res);
    return;
  }
  if (url.startsWith('/uploads/')) {
    const name = url.replace('/uploads/', '');
    // 优先从数据库读
    if (db.hasDb) {
      db.getUpload(name).then(row => {
        if (row) {
          res.writeHead(200, { 'Content-Type': row.content_type || 'application/octet-stream' });
          res.end(row.data);
        } else {
          serveUploadFromFile();
        }
      }).catch(() => serveUploadFromFile());
      return;
    }
    serveUploadFromFile();
    function serveUploadFromFile() {
      const filePath = path.join(__dirname, 'uploads', path.basename(name));
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
        res.writeHead(200, {'Content-Type': mimeTypes[ext] || 'application/octet-stream'});
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    }
    return;
  }

  // ===== POST: 登录 =====
  if (url === '/login' && req.method === 'POST') {
    parseBody((params) => {
      const username = getParam(params, 'username');
      const password = getParam(params, 'password');
      const user = users.find(u => u.username === username && u.password === password);
      if (user) {
        if (user.banned) {
          redirect(res, '/login?error=' + encodeURIComponent('账号已被封禁'));
          return;
        }
        setCookie(res, 'username', username);
        redirect(res, '/');
      } else {
        redirect(res, '/login?error=' + encodeURIComponent('用户名或密码错误'));
      }
    });
  }
  // ===== POST: 注册 =====
  else if (url === '/register' && req.method === 'POST') {
    parseBody((params) => {
      const username = getParam(params, 'username');
      const password = getParam(params, 'password');
      const region = getParam(params, 'region') || '';
      if (users.find(u => u.username === username)) {
        redirect(res, '/register?error=' + encodeURIComponent('用户名已存在'));
      } else {
        const isFirstUser = users.length === 0;
        users.push({username, password, region, isAdmin: isFirstUser});
        saveData();
        setCookie(res, 'username', username);
        redirect(res, '/');
      }
    });
  }
  // ===== POST: 更新地区 =====
  else if (url === '/update-region' && req.method === 'POST') {
    if (requireLogin()) return;
    parseBody((params) => {
      const region = getParam(params, 'region') || '';
      const user = users.find(u => u.username === currentUser);
      if (user) {
        user.region = region;
        saveData();
      }
      redirect(res, '/profile');
    });
  }
  // ===== POST: 发布任务（带附件） =====
  else if (url === '/publish' && req.method === 'POST') {
    if (requireLogin()) return;
    parseBody((params, isMultipart) => {
      const desc = getParam(params, 'desc');
      const delivery = getParam(params, 'delivery');
      const reward = getParam(params, 'reward');
      const category = getParam(params, 'category') || '其他';
      const deadline = getParam(params, 'deadline') || '';
      const saveAsTemplate = getParam(params, 'saveTemplate');

      if (desc && delivery && reward) {
        const publisherUser = users.find(u => u.username === currentUser);
        const publisherRegion = publisherUser ? (publisherUser.region || '') : '';
        const attachments = [];
        if (isMultipart && params.attachment && params.attachment.originalName) {
          attachments.push({ originalName: params.attachment.originalName, savedName: params.attachment.savedName, path: params.attachment.path });
        }

        tasks.push({
          id: nextId++, description: desc, publisher: currentUser, delivery, reward, category, deadline, region: publisherRegion,
          claimed: false, claimer: '', createdAt: Date.now(),
          completedAt: null, confirmedAt: null, messages: [], rating: 0, attachments
        });

        if (saveAsTemplate) {
          templates.push({ id: Date.now(), description: desc, category, delivery, reward, owner: currentUser });
        }

        saveData();
        let body = '<div class="success-message">';
        body += '<div class="success-icon">&#10004;</div><h1 style="color:#10b981;">任务发布成功！</h1>';
        body += '<p style="margin-top:20px;color:#666;">任务#' + (nextId - 1) + '：' + escapeHtml(desc) + '</p></div>';
        body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a> <a href="/list" class="back-btn" style="margin-left:15px;">查看任务</a></div>';
        sendHTML(res, pageShell('发布成功', body, currentUser, []));
      } else {
        redirect(res, '/publish');
      }
    });
  }
  // ===== POST: 编辑任务 =====
  else if (url === '/edit' && req.method === 'POST') {
    if (requireLogin()) return;
    parseBody(params => {
      const id = parseInt(getParam(params, 'id'));
      const task = tasks.find(t => t.id === id);
      if (!task || task.publisher !== currentUser) {
        redirect(res, '/');
        return;
      }
      if (task.claimed) {
        redirect(res, '/edit?error=' + encodeURIComponent('任务已被领取，不能修改'));
        return;
      }
      task.description = getParam(params, 'desc') || task.description;
      task.delivery = getParam(params, 'delivery') || task.delivery;
      task.reward = getParam(params, 'reward') || task.reward;
      task.category = getParam(params, 'category') || task.category;
      task.deadline = getParam(params, 'deadline') || '';
      saveData();
      redirect(res, '/my-published');
    });
  }
  // ===== POST: 留言 =====
  else if (url === '/message' && req.method === 'POST') {
    if (requireLogin()) return;
    parseBody(params => {
      const id = parseInt(getParam(params, 'id'));
      const content = getParam(params, 'content');
      const task = tasks.find(t => t.id === id);
      if (task && content && (task.claimer === currentUser || task.publisher === currentUser)) {
        if (!task.messages) task.messages = [];
        task.messages.push({user: currentUser, content, at: Date.now()});
        saveData();
      }
      redirect(res, '/message?id=' + id);
    });
  }
  // ===== POST: 保存模板 =====
  else if (url === '/save-template' && req.method === 'POST') {
    if (requireLogin()) return;
    parseBody(params => {
      const taskId = parseInt(getParam(params, 'taskId'));
      const task = tasks.find(t => t.id === taskId);
      if (task && task.publisher === currentUser) {
        templates.push({ id: Date.now(), description: task.description, category: task.category, delivery: task.delivery, reward: task.reward, owner: currentUser });
        saveData();
      }
      redirect(res, '/my-published');
    });
  }
  // ===== POST: 删除模板 =====
  else if (url === '/delete-template' && req.method === 'POST') {
    if (requireLogin()) return;
    parseBody(params => {
      const templateId = parseInt(getParam(params, 'templateId'));
      const idx = templates.findIndex(t => t.id === templateId && t.owner === currentUser);
      if (idx > -1) {
        templates.splice(idx, 1);
        saveData();
      }
      redirect(res, '/profile');
    });
  }
  // ===== POST: 管理后台删除任务 =====
  else if (url === '/admin-delete' && req.method === 'POST') {
    if (requireLogin()) return;
    const user = users.find(u => u.username === currentUser);
    if (!user || !user.isAdmin) {
      redirect(res, '/');
      return;
    }
    parseBody(params => {
      const taskId = parseInt(getParam(params, 'taskId'));
      const idx = tasks.findIndex(t => t.id === taskId);
      if (idx > -1) {
        tasks.splice(idx, 1);
        saveData();
      }
      redirect(res, '/admin');
    });
  }
  // ===== POST: 封禁用户 =====
  else if (url === '/admin-ban' && req.method === 'POST') {
    if (requireLogin()) return;
    const user = users.find(u => u.username === currentUser);
    if (!user || !user.isAdmin) {
      redirect(res, '/');
      return;
    }
    parseBody(params => {
      const username = getParam(params, 'username');
      const targetUser = users.find(u => u.username === username);
      if (targetUser && !targetUser.isAdmin) {
        targetUser.banned = true;
        saveData();
      }
      redirect(res, '/admin');
    });
  }
  // ===== POST: 解封用户 =====
  else if (url === '/admin-unban' && req.method === 'POST') {
    if (requireLogin()) return;
    const user = users.find(u => u.username === currentUser);
    if (!user || !user.isAdmin) {
      redirect(res, '/');
      return;
    }
    parseBody(params => {
      const username = getParam(params, 'username');
      const targetUser = users.find(u => u.username === username);
      if (targetUser) {
        targetUser.banned = false;
        saveData();
      }
      redirect(res, '/admin');
    });
  }
  // ===== POST: 设为管理员（超级管理员） =====
  else if (url === '/admin-set-admin' && req.method === 'POST') {
    if (requireLogin()) return;
    const user = users.find(u => u.username === currentUser);
    if (!user || !user.isSuperAdmin) {
      redirect(res, '/');
      return;
    }
    parseBody(params => {
      const username = getParam(params, 'username');
      const targetUser = users.find(u => u.username === username);
      if (targetUser && !targetUser.isSuperAdmin) {
        targetUser.isAdmin = true;
        saveData();
      }
      redirect(res, '/admin');
    });
  }
  // ===== POST: 取消管理员（超级管理员） =====
  else if (url === '/admin-remove-admin' && req.method === 'POST') {
    if (requireLogin()) return;
    const user = users.find(u => u.username === currentUser);
    if (!user || !user.isSuperAdmin) {
      redirect(res, '/');
      return;
    }
    parseBody(params => {
      const username = getParam(params, 'username');
      const targetUser = users.find(u => u.username === username);
      if (targetUser && !targetUser.isSuperAdmin) {
        targetUser.isAdmin = false;
        saveData();
      }
      redirect(res, '/admin');
    });
  }
  // ===== GET: 置顶任务 =====
  else if (url.startsWith('/pin?') && currentUser) {
    const user = users.find(u => u.username === currentUser);
    if (!user || (!user.isAdmin && !user.isSuperAdmin)) {
      redirect(res, '/');
      return;
    }
    const params = new URLSearchParams(url.split('?')[1]);
    const id = parseInt(params.get('id'));
    const task = tasks.find(t => t.id === id);
    if (task) {
      task.pinned = true;
      saveData();
    }
    redirect(res, '/admin');
  }
  // ===== GET: 取消置顶 =====
  else if (url.startsWith('/unpin?') && currentUser) {
    const user = users.find(u => u.username === currentUser);
    if (!user || (!user.isAdmin && !user.isSuperAdmin)) {
      redirect(res, '/');
      return;
    }
    const params = new URLSearchParams(url.split('?')[1]);
    const id = parseInt(params.get('id'));
    const task = tasks.find(t => t.id === id);
    if (task) {
      task.pinned = false;
      saveData();
    }
    redirect(res, '/admin');
  }
  // ===== GET: 登录页面 =====
  else if (url === '/login' || (url === '/' && !currentUser)) {
    const qs = url.includes('?') ? new URLSearchParams(url.split('?')[1]) : null;
    const error = qs ? qs.get('error') : null;

    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="manifest" href="/manifest.json"><link rel="icon" href="/icon-192.png"><title>登录</title>' + style + '</head><body><div class="container">';
    html += '<div class="login-form">';
    html += '<h2>任务管理系统</h2>';
    html += '<form action="/login" method="POST">';
    html += '<label>用户名</label><input type="text" name="username" placeholder="输入用户名" required>';
    html += '<label>密码</label><input type="text" name="password" placeholder="输入密码" required>';
    html += '<button type="submit">登录</button>';
    html += '</form>';
    if (error) html += '<p class="error-msg">' + escapeHtml(error) + '</p>';
    html += '<p style="text-align:center;margin-top:20px;color:#666;">还没有账号？<a href="/register" style="color:#667eea;">点击注册</a></p>';
    html += '</div></div></body></html>';
    sendHTML(res, html);
  }
  // ===== GET: 注册页面 =====
  else if (url === '/register') {
    const qs = url.includes('?') ? new URLSearchParams(url.split('?')[1]) : null;
    const error = qs ? qs.get('error') : null;

    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="manifest" href="/manifest.json"><link rel="icon" href="/icon-192.png"><title>注册</title>' + style + '</head><body><div class="container">';
    html += '<div class="login-form">';
    html += '<h2>注册新账号</h2>';
    html += '<form action="/register" method="POST">';
    html += '<label>用户名</label><input type="text" name="username" placeholder="设置用户名" required>';
    html += '<label>密码</label><input type="text" name="password" placeholder="设置密码" required>';
    html += '<label>所在地区</label><select name="region" required><option value="">请选择城市</option><option value="北京">北京</option><option value="上海">上海</option><option value="天津">天津</option><option value="重庆">重庆</option><option value="石家庄">石家庄</option><option value="太原">太原</option><option value="沈阳">沈阳</option><option value="大连">大连</option><option value="长春">长春</option><option value="哈尔滨">哈尔滨</option><option value="南京">南京</option><option value="苏州">苏州</option><option value="无锡">无锡</option><option value="常州">常州</option><option value="徐州">徐州</option><option value="杭州">杭州</option><option value="宁波">宁波</option><option value="温州">温州</option><option value="合肥">合肥</option><option value="福州">福州</option><option value="厦门">厦门</option><option value="泉州">泉州</option><option value="南昌">南昌</option><option value="济南">济南</option><option value="青岛">青岛</option><option value="烟台">烟台</option><option value="郑州">郑州</option><option value="武汉">武汉</option><option value="长沙">长沙</option><option value="广州">广州</option><option value="深圳">深圳</option><option value="东莞">东莞</option><option value="佛山">佛山</option><option value="珠海">珠海</option><option value="南宁">南宁</option><option value="海口">海口</option><option value="成都">成都</option><option value="贵阳">贵阳</option><option value="昆明">昆明</option><option value="拉萨">拉萨</option><option value="西安">西安</option><option value="兰州">兰州</option><option value="西宁">西宁</option><option value="银川">银川</option><option value="乌鲁木齐">乌鲁木齐</option><option value="呼和浩特">呼和浩特</option><option value="台北">台北</option><option value="香港">香港</option><option value="澳门">澳门</option></select>';
    html += '<button type="submit">注册</button>';
    html += '</form>';
    if (error) html += '<p class="error-msg">' + escapeHtml(error) + '</p>';
    html += '<p style="text-align:center;margin-top:20px;color:#666;">已有账号？<a href="/login" style="color:#667eea;">点击登录</a></p>';
    html += '</div></div></body></html>';
    sendHTML(res, html);
  }
  // ===== 退出登录 =====
  else if (url === '/logout') {
    res.setHeader('Set-Cookie', 'username=; Path=/; HttpOnly; Max-Age=0');
    redirect(res, '/login');
  }
  // ===== 首页 =====
  else if (url === '/' && currentUser) {
    const user = users.find(u => u.username === currentUser);
    const isAdmin = user && (user.isAdmin || user.isSuperAdmin);
    const userRegion = user ? (user.region || '') : '';
    let body = '<div class="header"><h1>任务管理系统</h1>';
    if (userRegion) {
      body += '<p class="subtitle">当前地区：📍 ' + escapeHtml(userRegion) + ' | 发布、领取、管理你的任务</p>';
    } else {
      body += '<p class="subtitle">发布、领取、管理你的任务</p>';
    }
    body += '</div>';

    const regionTasks = userRegion ? tasks.filter(t => t.region === userRegion) : tasks;

    body += '<div class="stats">';
    body += '<div class="stat-item"><div class="stat-number">' + regionTasks.length + '</div><div class="stat-label">总任务数</div></div>';
    body += '<div class="stat-item"><div class="stat-number">' + regionTasks.filter(t => !t.claimed && !isExpired(t)).length + '</div><div class="stat-label">待领取</div></div>';
    body += '<div class="stat-item"><div class="stat-number">' + regionTasks.filter(t => t.claimed && !t.confirmedAt).length + '</div><div class="stat-label">进行中</div></div>';
    body += '<div class="stat-item"><div class="stat-number">' + regionTasks.filter(t => t.confirmedAt).length + '</div><div class="stat-label">已完成</div></div>';
    body += '</div>';

    body += '<h2 class="section-title">任务大厅（待领取）</h2>';
    const availableTasks = regionTasks.filter(t => !t.claimed && !isExpired(t)).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    if (availableTasks.length === 0) {
      body += '<div class="empty-state"><p>暂无待领取任务，快去发布一个吧！</p></div>';
    } else {
      availableTasks.forEach(task => {
        body += renderTaskCard(task, currentUser, isAdmin);
      });
    }

    sendHTML(res, pageShell('任务系统', body, currentUser, [
      {href: '/publish', text: '发布任务'},
      {href: '/list', text: '任务大厅'},
      {href: '/my-published', text: '我发布的'},
      {href: '/my-claimed', text: '我领取的'}
    ]));
  }
  // ===== 任务大厅 =====
  else if (url.startsWith('/list') && currentUser) {
    const user = users.find(u => u.username === currentUser);
    const isAdmin = user && (user.isAdmin || user.isSuperAdmin);
    const qs = new URLSearchParams(url.split('?')[1] || '');
    const filter = qs.get('filter') || 'all';
    const search = qs.get('search') || '';
    const category = qs.get('category') || '';
    const userRegion = user ? (user.region || '') : '';

    let filteredTasks = tasks;
    if (userRegion) {
      filteredTasks = filteredTasks.filter(t => t.region === userRegion);
    }
    if (filter === 'available') filteredTasks = filteredTasks.filter(t => !t.claimed && !isExpired(t));
    else if (filter === 'claimed') filteredTasks = filteredTasks.filter(t => t.claimed && !t.confirmedAt);
    else if (filter === 'confirmed') filteredTasks = filteredTasks.filter(t => t.confirmedAt);
    else if (filter === 'expired') filteredTasks = filteredTasks.filter(t => isExpired(t));
    if (search) filteredTasks = filteredTasks.filter(t => t.description.includes(search) || t.publisher.includes(search));
    if (category) filteredTasks = filteredTasks.filter(t => t.category === category);

    let body = '<div class="header"><h1>所有任务</h1>';
    if (userRegion) {
      body += '<p class="subtitle">📍 ' + escapeHtml(userRegion) + ' 地区的任务</p>';
    } else {
      body += '<p class="subtitle">包括已领取和待领取的任务</p>';
    }
    body += '</div>';
    body += '<div class="filter-bar">';
    body += '<form action="/list" method="GET" style="display:flex;gap:15px;flex-wrap:wrap;margin:0;padding:0;box-shadow:none;background:transparent;">';
    body += '<select name="filter"><option value="all"' + (filter === 'all' ? ' selected' : '') + '>全部</option><option value="available"' + (filter === 'available' ? ' selected' : '') + '>待领取</option><option value="claimed"' + (filter === 'claimed' ? ' selected' : '') + '>进行中</option><option value="confirmed"' + (filter === 'confirmed' ? ' selected' : '') + '>已完成</option><option value="expired"' + (filter === 'expired' ? ' selected' : '') + '>已过期</option></select>';
    body += '<select name="category"><option value="">全部分类</option><option value="学习"' + (category === '学习' ? ' selected' : '') + '>学习</option><option value="生活"' + (category === '生活' ? ' selected' : '') + '>生活</option><option value="工作"' + (category === '工作' ? ' selected' : '') + '>工作</option><option value="其他"' + (category === '其他' ? ' selected' : '') + '>其他</option></select>';
    body += '<input type="text" name="search" placeholder="搜索任务..." value="' + escapeHtml(search) + '">';
    body += '<button type="submit" style="width:auto;margin:0;padding:12px 24px;">筛选</button>';
    body += '</form></div>';

    if (filteredTasks.length === 0) {
      body += '<div class="empty-state"><p>没有找到匹配的任务</p></div>';
    } else {
      filteredTasks.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).forEach(task => { body += renderTaskCard(task, currentUser, isAdmin); });
    }
    body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';

    sendHTML(res, pageShell('所有任务', body, currentUser, [
      {href: '/', text: '返回首页'},
      {href: '/my-published', text: '我发布的'},
      {href: '/my-claimed', text: '我领取的'}
    ]));
  }
  // ===== 我发布的 =====
  else if (url === '/my-published' && currentUser) {
    const user = users.find(u => u.username === currentUser);
    const isAdmin = user && (user.isAdmin || user.isSuperAdmin);
    const myTasks = tasks.filter(t => t.publisher === currentUser);
    let body = '<div class="header"><h1>我发布的任务</h1><p class="subtitle">你发布的所有任务</p></div>';
    if (myTasks.length === 0) {
      body += '<div class="empty-state"><p>你还没有发布过任务</p></div>';
    } else {
      myTasks.forEach(task => {
        body += renderTaskCard(task, currentUser, isAdmin);
        if (task.confirmedAt) {
          body += '<form action="/save-template" method="POST" style="display:inline;margin-top:10px;padding:10px;"><input type="hidden" name="taskId" value="' + task.id + '"><button type="submit" style="width:auto;margin:0;padding:6px 12px;font-size:13px;">保存为模板</button></form>';
        }
      });
    }
    body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';

    sendHTML(res, pageShell('我发布的任务', body, currentUser, [
      {href: '/', text: '返回首页'},
      {href: '/publish', text: '发布新任务'},
      {href: '/my-claimed', text: '我领取的'}
    ]));
  }
  // ===== 我领取的 =====
  else if (url === '/my-claimed' && currentUser) {
    const user = users.find(u => u.username === currentUser);
    const isAdmin = user && (user.isAdmin || user.isSuperAdmin);
    const claimedTasks = tasks.filter(t => t.claimed && t.claimer === currentUser);
    let body = '<div class="header"><h1>我领取的任务</h1><p class="subtitle">你领取的所有任务</p></div>';
    if (claimedTasks.length === 0) {
      body += '<div class="empty-state"><p>你还没有领取过任务</p></div>';
    } else {
      claimedTasks.forEach(task => { body += renderTaskCard(task, currentUser, isAdmin); });
    }
    body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';

    sendHTML(res, pageShell('我领取的任务', body, currentUser, [
      {href: '/', text: '返回首页'},
      {href: '/my-published', text: '我发布的'},
      {href: '/list', text: '任务大厅'}
    ]));
  }
  // ===== 发布任务页面（GET） =====
  else if (url === '/publish' && currentUser) {
    const qs = new URLSearchParams(url.split('?')[1] || '');
    const templateId = parseInt(qs.get('template'));
    const template = templateId ? templates.find(t => t.id === templateId && t.owner === currentUser) : null;

    let body = '<div class="header"><h1>发布新任务</h1><p class="subtitle">填写任务信息，等待他人领取</p></div>';

    const myTemplates = templates.filter(t => t.owner === currentUser);
    if (myTemplates.length > 0) {
      body += '<div class="template-section"><h3>我的模板</h3>';
      myTemplates.forEach(t => {
        body += '<div class="template-card">';
        body += '<div class="template-title">' + escapeHtml(t.description) + '</div>';
        body += '<div class="template-info">' + escapeHtml(t.category) + ' | ' + escapeHtml(t.delivery) + ' | ' + escapeHtml(t.reward) + '</div>';
        body += '<div class="template-actions"><button onclick="fillTemplate(' + JSON.stringify(t).replace(/"/g, '&quot;') + ')">使用模板</button></div>';
        body += '</div>';
      });
      body += '</div>';
    }

    body += '<form action="/publish" method="POST" enctype="multipart/form-data">';
    body += '<label>任务描述</label><input type="text" name="desc" id="desc" placeholder="例如：帮忙取快递" required' + (template ? ' value="' + escapeHtml(template.description) + '"' : '') + '>';
    body += '<label>分类</label><select name="category" id="category"><option value="学习"' + (template && template.category === '学习' ? ' selected' : '') + '>学习</option><option value="生活"' + (template && template.category === '生活' ? ' selected' : '') + '>生活</option><option value="工作"' + (template && template.category === '工作' ? ' selected' : '') + '>工作</option><option value="其他"' + (template && template.category === '其他' ? ' selected' : '') + '>其他</option></select>';
    body += '<label>交付方式</label><select name="delivery" id="delivery"><option value="线上"' + (template && template.delivery === '线上' ? ' selected' : '') + '>线上</option><option value="线下"' + (template && template.delivery === '线下' ? ' selected' : '') + '>线下</option><option value="快递"' + (template && template.delivery === '快递' ? ' selected' : '') + '>快递</option></select>';
    body += '<label>报酬</label><input type="text" name="reward" id="reward" placeholder="例如：50元、一杯奶茶" required' + (template ? ' value="' + escapeHtml(template.reward) + '"' : '') + '>';
    body += '<label>截止时间（可选）</label><input type="datetime-local" name="deadline">';
    body += '<label>附件（图片或其他文件）</label><input type="file" name="attachment" accept="image/*,.pdf,.doc,.docx">';
    body += '<label style="display:flex;align-items:center;gap:10px;"><input type="checkbox" name="saveTemplate" value="1" style="width:auto;"> 保存为模板，下次快速发布</label>';
    body += '<button type="submit">发布任务</button></form>';
    body += '<script>function fillTemplate(t){document.getElementById("desc").value=t.description;document.getElementById("category").value=t.category;document.getElementById("delivery").value=t.delivery;document.getElementById("reward").value=t.reward;}</script>';
    body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';

    sendHTML(res, pageShell('发布任务', body, currentUser, [
      {href: '/', text: '返回首页'},
      {href: '/list', text: '任务大厅'},
      {href: '/my-published', text: '我发布的'}
    ]));
  }
  // ===== 编辑任务页面 =====
  else if (url.startsWith('/edit') && currentUser) {
    const qs = new URLSearchParams(url.split('?')[1] || '');
    const id = parseInt(qs.get('id'));
    const err = qs.get('error');
    const task = tasks.find(t => t.id === id);

    if (!task || task.publisher !== currentUser) {
      redirect(res, '/');
      return;
    }

    if (task.claimed) {
      let body = '<div class="empty-state"><h1>任务已被领取，不能修改</h1><p style="margin-top:20px;color:#666;">领取人：' + escapeHtml(task.claimer) + '</p></div>';
      body += '<div class="back-container"><a href="/my-published" class="back-btn">返回</a></div>';
      sendHTML(res, pageShell('无法编辑', body, currentUser, []));
      return;
    }

    let body = '<div class="header"><h1>编辑任务</h1><p class="subtitle">修改任务信息</p></div>';
    if (err) body += '<p class="error-msg" style="margin-bottom:15px;">' + escapeHtml(err) + '</p>';
    body += '<form action="/edit" method="POST">';
    body += '<input type="hidden" name="id" value="' + task.id + '">';
    body += '<label>任务描述</label><input type="text" name="desc" value="' + escapeHtml(task.description) + '" required>';
    body += '<label>分类</label><select name="category">';
    ['学习', '生活', '工作', '其他'].forEach(c => {
      body += '<option value="' + c + '"' + (task.category === c ? ' selected' : '') + '>' + c + '</option>';
    });
    body += '</select>';
    body += '<label>交付方式</label><select name="delivery">';
    ['线上', '线下', '快递'].forEach(d => {
      body += '<option value="' + d + '"' + (task.delivery === d ? ' selected' : '') + '>' + d + '</option>';
    });
    body += '</select>';
    body += '<label>报酬</label><input type="text" name="reward" value="' + escapeHtml(task.reward) + '" required>';
    body += '<label>截止时间</label><input type="datetime-local" name="deadline" value="' + (task.deadline || '') + '">';
    body += '<button type="submit">保存修改</button></form>';
    body += '<div class="back-container"><a href="/my-published" class="back-btn">返回</a></div>';

    sendHTML(res, pageShell('编辑任务', body, currentUser, []));
  }
  // ===== 删除任务 =====
  else if (url.startsWith('/delete?') && currentUser) {
    const params = new URLSearchParams(url.split('?')[1]);
    const id = parseInt(params.get('id'));
    const taskIndex = tasks.findIndex(t => t.id === id && t.publisher === currentUser);
    if (taskIndex > -1) {
      tasks.splice(taskIndex, 1);
      saveData();
      let body = '<div class="success-message"><div class="success-icon">&#10004;</div><h1 style="color:#10b981;">任务已删除</h1></div>';
      body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a> <a href="/list" class="back-btn" style="margin-left:15px;">查看任务</a></div>';
      sendHTML(res, pageShell('删除成功', body, currentUser, []));
    } else {
      let body = '<div class="empty-state"><h1>任务不存在或无权删除</h1></div>';
      body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';
      sendHTML(res, pageShell('错误', body, currentUser, []));
    }
  }
  // ===== 领取任务 =====
  else if (url.startsWith('/claim') && currentUser) {
    const user = users.find(u => u.username === currentUser);
    const isAdmin = user && (user.isAdmin || user.isSuperAdmin);
    const params = new URLSearchParams(url.split('?')[1] || '');
    const id = parseInt(params.get('id'));
    const confirmClaim = params.get('claimer');
    const task = tasks.find(t => t.id === id);

    if (!task) {
      let body = '<div class="empty-state"><h1>任务不存在</h1></div><div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';
      sendHTML(res, pageShell('错误', body, currentUser, []));
    } else if (isExpired(task)) {
      let body = '<div class="empty-state"><h1>任务已过期</h1></div><div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';
      sendHTML(res, pageShell('已过期', body, currentUser, []));
    } else if (task.claimed) {
      let body = '<div class="empty-state"><h1>任务已被领取</h1><p style="margin-top:20px;color:#666;">领取人：' + escapeHtml(task.claimer) + '</p></div><div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';
      sendHTML(res, pageShell('已领取', body, currentUser, []));
    } else if (task.publisher === currentUser) {
      let body = '<div class="empty-state"><h1>不能领取自己发布的任务</h1></div><div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';
      sendHTML(res, pageShell('错误', body, currentUser, []));
    } else if (!confirmClaim) {
      let body = '<div class="header"><h1>领取任务</h1><p class="subtitle">确认任务信息</p></div>';
      body += renderTaskCard(task, currentUser, isAdmin);
      body += '<form action="/claim" method="GET"><input type="hidden" name="id" value="' + task.id + '"><input type="hidden" name="claimer" value="' + encodeURIComponent(currentUser) + '">';
      body += '<button type="submit">确认领取</button></form>';
      body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';
      sendHTML(res, pageShell('领取任务', body, currentUser, []));
    } else {
      task.claimed = true;
      task.claimer = decodeURIComponent(confirmClaim);
      saveData();
      let body = '<div class="success-message">';
      body += '<div class="success-icon">&#10004;</div><h1 style="color:#10b981;">任务领取成功！</h1>';
      body += '<p style="margin-top:20px;color:#666;">任务#' + task.id + '：' + escapeHtml(task.description) + '</p>';
      body += '<p style="margin-top:10px;color:#666;">领取人：' + escapeHtml(currentUser) + '</p></div>';
      body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';
      sendHTML(res, pageShell('领取成功', body, currentUser, []));
    }
  }
  // ===== 标记完成 =====
  else if (url.startsWith('/complete?') && currentUser) {
    const params = new URLSearchParams(url.split('?')[1]);
    const id = parseInt(params.get('id'));
    const task = tasks.find(t => t.id === id);
    if (task && task.claimer === currentUser && !task.completedAt) {
      task.completedAt = Date.now();
      saveData();
    }
    redirect(res, '/my-claimed');
  }
  // ===== 确认完成 =====
  else if (url.startsWith('/confirm?') && currentUser) {
    const params = new URLSearchParams(url.split('?')[1]);
    const id = parseInt(params.get('id'));
    const task = tasks.find(t => t.id === id);
    if (task && task.publisher === currentUser && task.completedAt && !task.confirmedAt) {
      task.confirmedAt = Date.now();
      saveData();
    }
    redirect(res, '/my-published');
  }
  // ===== 评分页面 =====
  else if (url.startsWith('/rate') && currentUser && !url.includes('rating=')) {
    const qs = new URLSearchParams(url.split('?')[1] || '');
    const id = parseInt(qs.get('id'));
    const task = tasks.find(t => t.id === id);

    if (!task || !task.confirmedAt || task.rating) {
      redirect(res, '/');
      return;
    }
    if (task.publisher !== currentUser && task.claimer !== currentUser) {
      redirect(res, '/');
      return;
    }

    let body = '<div class="header"><h1>为任务评分</h1><p class="subtitle">任务：' + escapeHtml(task.description) + '</p></div>';
    body += '<form action="/rate" method="GET">';
    body += '<input type="hidden" name="id" value="' + task.id + '">';
    body += '<label>选择评分</label>';
    body += '<div class="rating-select">';
    for (let i = 1; i <= 5; i++) {
      body += '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:15px;width:auto;"><input type="radio" name="rating" value="' + i + '"' + (i === 5 ? ' checked' : '') + ' style="width:auto;margin:0;"> ' + i + '星</label>';
    }
    body += '</div>';
    body += '<button type="submit">提交评分</button></form>';
    body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';

    sendHTML(res, pageShell('评分', body, currentUser, []));
  }
  // ===== 处理评分 =====
  else if (url.startsWith('/rate?') && url.includes('rating=')) {
    const qs = new URLSearchParams(url.split('?')[1]);
    const id = parseInt(qs.get('id'));
    const rating = parseInt(qs.get('rating'));
    const task = tasks.find(t => t.id === id);
    if (task && task.confirmedAt && !task.rating && rating >= 1 && rating <= 5) {
      if (task.publisher === currentUser || task.claimer === currentUser) {
        task.rating = rating;
        saveData();
      }
    }
    redirect(res, '/');
  }
  // ===== 留言页面 =====
  else if (url.startsWith('/message') && currentUser) {
    const qs = new URLSearchParams(url.split('?')[1] || '');
    const id = parseInt(qs.get('id'));
    const task = tasks.find(t => t.id === id);

    if (!task || !task.claimed) {
      redirect(res, '/');
      return;
    }
    if (task.publisher !== currentUser && task.claimer !== currentUser) {
      redirect(res, '/');
      return;
    }

    let body = '<div class="header"><h1>任务留言</h1><p class="subtitle">任务：' + escapeHtml(task.description) + '</p></div>';

    if (task.messages && task.messages.length > 0) {
      body += '<div class="messages-section"><h3>留言记录</h3>';
      task.messages.forEach(msg => {
        body += '<div class="message-item">';
        body += '<div class="msg-user">' + escapeHtml(msg.user) + '</div>';
        body += '<div class="msg-text">' + escapeHtml(msg.content) + '</div>';
        body += '<div class="msg-time">' + new Date(msg.at).toLocaleString('zh-CN') + '</div>';
        body += '</div>';
      });
      body += '</div>';
    } else {
      body += '<div class="empty-state" style="padding:30px;"><p>暂无留言</p></div>';
    }

    if (task.claimer && !task.completedAt) {
      body += '<form action="/message" method="POST" style="margin-top:20px;">';
      body += '<input type="hidden" name="id" value="' + task.id + '">';
      body += '<label>发表留言</label>';
      body += '<textarea name="content" placeholder="输入留言内容..." required></textarea>';
      body += '<button type="submit">发送</button></form>';
    }

    body += '<div class="back-container"><a href="/my-claimed" class="back-btn">返回</a></div>';

    sendHTML(res, pageShell('任务留言', body, currentUser, []));
  }
  // ===== 个人中心 =====
  else if (url === '/profile' && currentUser) {
    const user = users.find(u => u.username === currentUser);
    const rep = getUserReputation(currentUser);
    const publishedCount = tasks.filter(t => t.publisher === currentUser).length;
    const claimedCount = tasks.filter(t => t.claimer === currentUser).length;
    const completedCount = tasks.filter(t => t.confirmedAt && (t.publisher === currentUser || t.claimer === currentUser)).length;
    const userRegion = user ? (user.region || '') : '';

    let body = '<div class="profile-stats">';
    body += '<h2>个人中心 - ' + escapeHtml(currentUser) + ' ' + renderUserBadge(currentUser) + '</h2>';
    body += '<div class="stat-grid">';
    body += '<div class="stat-box"><div class="number">' + rep.score + '</div><div class="label">信誉分</div></div>';
    body += '<div class="stat-box"><div class="number">' + publishedCount + '</div><div class="label">发布任务</div></div>';
    body += '<div class="stat-box"><div class="number">' + claimedCount + '</div><div class="label">领取任务</div></div>';
    body += '<div class="stat-box"><div class="number">' + completedCount + '</div><div class="label">完成任务</div></div>';
    body += '</div>';
    body += '<div style="margin-top:20px;padding:20px;background:#f8fafc;border-radius:12px;">';
    body += '<h3 style="margin:0 0 10px 0;">📍 当前地区：' + (userRegion ? escapeHtml(userRegion) : '<span style="color:#ef4444;">未设置</span>') + '</h3>';
    body += '<form action="/update-region" method="POST" style="display:flex;gap:10px;align-items:center;margin:0;padding:0;box-shadow:none;background:transparent;">';
    body += '<select name="region" style="flex:1;padding:10px;border-radius:8px;border:1px solid #ddd;"><option value="">请选择城市</option>';
    const regions = ['北京','上海','天津','重庆','石家庄','太原','沈阳','大连','长春','哈尔滨','南京','苏州','无锡','常州','徐州','杭州','宁波','温州','合肥','福州','厦门','泉州','南昌','济南','青岛','烟台','郑州','武汉','长沙','广州','深圳','东莞','佛山','珠海','南宁','海口','成都','贵阳','昆明','拉萨','西安','兰州','西宁','银川','乌鲁木齐','呼和浩特','台北','香港','澳门'];
    regions.forEach(r => {
      body += '<option value="' + r + '"' + (userRegion === r ? ' selected' : '') + '>' + r + '</option>';
    });
    body += '</select>';
    body += '<button type="submit" style="width:auto;margin:0;padding:10px 20px;">更新</button>';
    body += '</form></div>';
    body += '</div>';

    const myTemplates = templates.filter(t => t.owner === currentUser);
    if (myTemplates.length > 0) {
      body += '<div class="template-section"><h3>我的模板</h3>';
      myTemplates.forEach(t => {
        body += '<div class="template-card">';
        body += '<div class="template-title">' + escapeHtml(t.description) + '</div>';
        body += '<div class="template-info">' + escapeHtml(t.category) + ' | ' + escapeHtml(t.delivery) + ' | ' + escapeHtml(t.reward) + '</div>';
        body += '<div class="template-actions">';
        body += '<button onclick="location.href=\'/publish?template=' + t.id + '\'">使用</button>';
        body += '<form action="/delete-template" method="POST" style="display:inline;"><input type="hidden" name="templateId" value="' + t.id + '"><button type="submit" class="delete">删除</button></form>';
        body += '</div></div>';
      });
      body += '</div>';
    }

    body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';
    sendHTML(res, pageShell('个人中心', body, currentUser, []));
  }
  // ===== 管理后台 =====
  else if (url === '/admin' && currentUser) {
    const user = users.find(u => u.username === currentUser);
    if (!user || (!user.isAdmin && !user.isSuperAdmin)) {
      redirect(res, '/');
      return;
    }
    const isAdmin = true;
    const isSuperAdmin = user.isSuperAdmin;

    let body = '<div class="admin-section">';
    body += '<h2>管理后台</h2>';
    if (isSuperAdmin) body += '<p style="color:#ef4444;font-weight:600;margin-bottom:10px;">🔑 超级管理员模式</p>';
    body += '<div class="stats" style="box-shadow:none;margin-bottom:20px;">';
    body += '<div class="stat-item"><div class="stat-number">' + tasks.length + '</div><div class="stat-label">总任务数</div></div>';
    body += '<div class="stat-item"><div class="stat-number">' + users.length + '</div><div class="stat-label">用户数</div></div>';
    body += '<div class="stat-item"><div class="stat-number">' + tasks.filter(t => t.confirmedAt).length + '</div><div class="stat-label">已完成</div></div>';
    body += '</div></div>';

    body += '<div class="admin-section"><h2>用户管理</h2><div class="admin-user-list">';
    users.forEach(u => {
      body += '<div class="admin-user-item"><div class="user-info"><strong>' + escapeHtml(u.username) + '</strong>';
      if (u.isSuperAdmin) body += ' <span style="color:#dc2626;font-size:12px;font-weight:600;">超级管理员</span>';
      else if (u.isAdmin) body += ' <span style="color:#ef4444;font-size:12px;">管理员</span>';
      if (u.region) body += ' <span style="color:#0369a1;font-size:12px;">📍' + escapeHtml(u.region) + '</span>';
      if (u.banned) body += ' <span style="color:#999;font-size:12px;">已封禁</span>';
      body += '</div><div class="user-actions">';
      if (isSuperAdmin && !u.isSuperAdmin) {
        if (u.isAdmin) {
          body += '<form action="/admin-remove-admin" method="POST" style="display:inline;"><input type="hidden" name="username" value="' + escapeHtml(u.username) + '"><button type="submit" style="background:#6b7280;">取消管理员</button></form>';
        } else {
          body += '<form action="/admin-set-admin" method="POST" style="display:inline;"><input type="hidden" name="username" value="' + escapeHtml(u.username) + '"><button type="submit" style="background:#3b82f6;">设为管理员</button></form>';
        }
      }
      if (!u.isAdmin && !u.isSuperAdmin) {
        if (u.banned) {
          body += '<form action="/admin-unban" method="POST" style="display:inline;"><input type="hidden" name="username" value="' + escapeHtml(u.username) + '"><button type="submit" class="unban">解封</button></form>';
        } else {
          body += '<form action="/admin-ban" method="POST" style="display:inline;"><input type="hidden" name="username" value="' + escapeHtml(u.username) + '"><button type="submit">封禁</button></form>';
        }
      }
      body += '</div></div>';
    });
    body += '</div></div>';

    body += '<div class="admin-section"><h2>所有任务</h2>';
    if (tasks.length === 0) {
      body += '<p style="color:#666;">暂无任务</p>';
    } else {
      const sortedTasks = [...tasks].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      sortedTasks.forEach(task => {
        body += renderTaskCard(task, currentUser, isAdmin);
        body += '<form action="/admin-delete" method="POST" style="margin-top:10px;"><input type="hidden" name="taskId" value="' + task.id + '"><button type="submit" style="background:#ef4444;width:auto;padding:8px 16px;font-size:13px;">管理员删除</button></form>';
      });
    }
    body += '</div>';

    body += '<div class="back-container"><a href="/" class="back-btn">返回首页</a></div>';
    sendHTML(res, pageShell('管理后台', body, currentUser, []));
  }
  // ===== 404 =====
  else {
    res.writeHead(200, {'Content-Type': 'text/html; charset=UTF-8'});
    res.end('<meta charset="UTF-8"><h1>404 - 页面不存在</h1><p><a href="/">返回首页</a></p>');
  }
});

const port = process.env.PORT || 3000;
(async () => {
  try { await initStore(); } catch (e) { console.log('[db] init failed, using in-memory/file:', e.message); }
  server.listen(port, () => { console.log('Server running on port ' + port); });
})();
