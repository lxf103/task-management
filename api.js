/**
 * api.js — JSON API 层（供微信小程序调用）
 * 在 server.js 中通过 handleApi(req, res, ...) 调用。
 * 认证方式：无状态签名 token（HMAC），不依赖内存 session，Railway 重启后 token 仍有效。
 */

const crypto = require('crypto');

// ===== 无状态签名 Token =====
// 生产环境应把 SECRET 放环境变量；练习项目硬编码即可。
const SECRET = 'campus-task-secret-2026-do-not-share';

function generateToken(username) {
  const ts = Date.now();
  const payload = Buffer.from(username + ':' + ts).toString('base64');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}

function getTokenUser(req) {
  const auth = req.headers['authorization'] || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  if (sig !== expected) return null;
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    const username = decoded.split(':')[0];
    return username || null;
  } catch (e) { return null; }
}

// ===== JSON 响应工具 =====
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function ok(res, data) { json(res, 200, { success: true, data }); }
function created(res, data) { json(res, 201, { success: true, data }); }
function bad(res, msg) { json(res, 400, { success: false, message: msg }); }
function unauthorized(res) { json(res, 401, { success: false, message: '请先登录' }); }
function notFound(res) { json(res, 404, { success: false, message: '资源不存在' }); }

// ===== 解析 JSON Body =====
function parseJsonBody(req, callback) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 5 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    try { callback(null, body ? JSON.parse(body) : {}); }
    catch (e) { callback(e, null); }
  });
}

// ===== 主入口 =====
// 由 server.js 调用，传入 req/res 和共享数据引用
function handleApi(req, res, ctx) {
  const { tasks, users, templates, saveData, nextIdRef } = ctx;
  const url = req.url.replace(/^\/api/, '').split('?')[0];
  const method = req.method;
  const currentUser = getTokenUser(req);

  // ---------- 注册 ----------
  if (url === '/register' && method === 'POST') {
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const { username, password, region } = body;
      if (!username || !password) return bad(res, '用户名和密码不能为空');
      if (users.find(u => u.username === username)) return bad(res, '用户名已存在');
      const isFirstUser = users.length === 0;
      users.push({ username, password, region: region || '', isAdmin: isFirstUser });
      saveData();
      const token = generateToken(username);
      ok(res, { token, username });
    });
  }

  // ---------- 登录 ----------
  if (url === '/login' && method === 'POST') {
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const { username, password } = body;
      const user = users.find(u => u.username === username && u.password === password);
      if (!user) return bad(res, '用户名或密码错误');
      if (user.banned) return bad(res, '账号已被封禁');
      const token = generateToken(username);
      ok(res, { token, username });
    });
  }

  // ---------- 获取当前用户信息 ----------
  if (url === '/me' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const user = users.find(u => u.username === currentUser);
    if (!user) return notFound(res);
    const published = tasks.filter(t => t.publisher === currentUser).length;
    const claimed = tasks.filter(t => t.claimer === currentUser).length;
    const completed = tasks.filter(t => t.claimer === currentUser && t.confirmedAt).length;
    ok(res, { username: user.username, region: user.region, isAdmin: user.isAdmin, published, claimed, completed });
  }

  // ---------- 更新地区 ----------
  if (url === '/me/region' && method === 'PUT') {
    if (!currentUser) return unauthorized(res);
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const user = users.find(u => u.username === currentUser);
      if (user) { user.region = body.region || ''; saveData(); }
      ok(res, { region: user ? user.region : '' });
    });
  }

  // ---------- 任务列表（支持筛选） ----------
  if (url === '/tasks' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    // 重新解析原始带 query 的 url
    const rawUrl = ctx.originalUrl || req.url;
    const q = new URLSearchParams(rawUrl.split('?')[1] || '');
    let list = [...tasks];

    const category = q.get('category');
    const region = q.get('region');
    const status = q.get('status');
    const keyword = q.get('keyword');

    if (category) list = list.filter(t => t.category === category);
    if (region) list = list.filter(t => t.region === region || (t.delivery || '').includes(region));
    if (keyword) list = list.filter(t => t.description.includes(keyword) || (t.reward || '').includes(keyword));
    if (status === 'available') list = list.filter(t => !t.claimed && !t.confirmedAt);
    else if (status === 'claimed') list = list.filter(t => t.claimed && !t.completedAt);
    else if (status === 'completed') list = list.filter(t => t.completedAt && !t.confirmedAt);
    else if (status === 'confirmed') list = list.filter(t => t.confirmedAt);

    // 置顶排前面，其余按时间倒序
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.createdAt - a.createdAt);

    // 分页
    const page = parseInt(q.get('page')) || 1;
    const size = Math.min(parseInt(q.get('size')) || 20, 50);
    const total = list.length;
    const paged = list.slice((page - 1) * size, page * size);

    ok(res, { total, page, size, tasks: paged.map(formatTask) });
  }

  // ---------- 我发布的 / 我接的 ----------
  if (url === '/tasks/my-published' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const list = tasks.filter(t => t.publisher === currentUser).sort((a, b) => b.createdAt - a.createdAt);
    ok(res, { tasks: list.map(formatTask) });
  }
  if (url === '/tasks/my-claimed' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const list = tasks.filter(t => t.claimer === currentUser).sort((a, b) => b.createdAt - a.createdAt);
    ok(res, { tasks: list.map(formatTask) });
  }

  // ---------- 任务详情 ----------
  const detailMatch = url.match(/^\/tasks\/(\d+)$/);
  if (detailMatch && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(detailMatch[1]));
    if (!task) return notFound(res);
    ok(res, { task: formatTask(task, true) });
  }

  // ---------- 发布任务 ----------
  if (url === '/tasks' && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const { description, delivery, reward, category, deadline } = body;
      if (!description || !delivery || !reward) return bad(res, '描述、送达地点、报酬为必填');
      const user = users.find(u => u.username === currentUser);
      const task = {
        id: nextIdRef.value++,
        description, publisher: currentUser,
        delivery, reward,
        category: category || '其他',
        deadline: deadline || '',
        region: user ? (user.region || '') : '',
        claimed: false, claimer: '',
        createdAt: Date.now(),
        completedAt: null, confirmedAt: null,
        messages: [], rating: 0, attachments: [], pinned: false
      };
      tasks.push(task);
      saveData();
      created(res, { task: formatTask(task) });
    });
  }

  // ---------- 编辑任务 ----------
  if (detailMatch && method === 'PUT') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(detailMatch[1]));
    if (!task) return notFound(res);
    if (task.publisher !== currentUser) return bad(res, '只能编辑自己发布的任务');
    if (task.claimed) return bad(res, '任务已被领取，不能修改');
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      if (body.description) task.description = body.description;
      if (body.delivery) task.delivery = body.delivery;
      if (body.reward) task.reward = body.reward;
      if (body.category) task.category = body.category;
      if (body.deadline !== undefined) task.deadline = body.deadline;
      saveData();
      ok(res, { task: formatTask(task) });
    });
  }

  // ---------- 删除任务 ----------
  if (detailMatch && method === 'DELETE') {
    if (!currentUser) return unauthorized(res);
    const idx = tasks.findIndex(t => t.id === parseInt(detailMatch[1]));
    if (idx === -1) return notFound(res);
    const task = tasks[idx];
    const user = users.find(u => u.username === currentUser);
    if (task.publisher !== currentUser && !(user && user.isAdmin)) return bad(res, '无权限删除');
    tasks.splice(idx, 1);
    saveData();
    ok(res, { deleted: true });
  }

  // ---------- 领取任务 ----------
  const claimMatch = url.match(/^\/tasks\/(\d+)\/claim$/);
  if (claimMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(claimMatch[1]));
    if (!task) return notFound(res);
    if (task.claimed) return bad(res, '任务已被别人领取');
    if (task.publisher === currentUser) return bad(res, '不能领取自己发布的任务');
    task.claimed = true;
    task.claimer = currentUser;
    saveData();
    ok(res, { task: formatTask(task) });
  }

  // ---------- 完成任务（接单者操作） ----------
  const completeMatch = url.match(/^\/tasks\/(\d+)\/complete$/);
  if (completeMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(completeMatch[1]));
    if (!task) return notFound(res);
    if (task.claimer !== currentUser) return bad(res, '只有接单者能标记完成');
    task.completedAt = Date.now();
    saveData();
    ok(res, { task: formatTask(task) });
  }

  // ---------- 确认完成（发布者操作） ----------
  const confirmMatch = url.match(/^\/tasks\/(\d+)\/confirm$/);
  if (confirmMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(confirmMatch[1]));
    if (!task) return notFound(res);
    if (task.publisher !== currentUser) return bad(res, '只有发布者能确认');
    task.confirmedAt = Date.now();
    saveData();
    ok(res, { task: formatTask(task) });
  }

  // ---------- 评价 ----------
  const rateMatch = url.match(/^\/tasks\/(\d+)\/rate$/);
  if (rateMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(rateMatch[1]));
    if (!task) return notFound(res);
    if (task.publisher !== currentUser) return bad(res, '只有发布者能评价');
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const rating = parseInt(body.rating);
      if (!rating || rating < 1 || rating > 5) return bad(res, '评分 1-5');
      task.rating = rating;
      saveData();
      ok(res, { task: formatTask(task) });
    });
  }

  // ---------- 发消息 ----------
  const msgMatch = url.match(/^\/tasks\/(\d+)\/messages$/);
  if (msgMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(msgMatch[1]));
    if (!task) return notFound(res);
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      if (!body.content) return bad(res, '消息不能为空');
      task.messages.push({ user: currentUser, content: body.content, at: Date.now() });
      saveData();
      ok(res, { messages: task.messages });
    });
  }

  // ---------- 获取分类列表（固定） ----------
  if (url === '/categories' && method === 'GET') {
    ok(res, { categories: ['快递代拿', '学习', '生活', '跑腿', '其他'] });
  }

  // ---------- 获取地区列表（从已有用户中提取） ----------
  if (url === '/regions' && method === 'GET') {
    const regions = [...new Set(users.map(u => u.region).filter(Boolean))];
    ok(res, { regions });
  }

  // ---------- 未匹配 ----------
  notFound(res);
}

// ===== 格式化任务输出 =====
function formatTask(t, includeMessages = false) {
  const obj = {
    id: t.id,
    description: t.description,
    publisher: t.publisher,
    delivery: t.delivery,
    reward: t.reward,
    category: t.category,
    deadline: t.deadline,
    region: t.region || '',
    claimed: t.claimed,
    claimer: t.claimer || '',
    createdAt: t.createdAt,
    completedAt: t.completedAt,
    confirmedAt: t.confirmedAt,
    rating: t.rating || 0,
    pinned: t.pinned || false,
    attachments: (t.attachments || []).map(a => ({ name: a.originalName, url: a.path })),
    messageCount: (t.messages || []).length
  };
  if (includeMessages) obj.messages = t.messages || [];
  return obj;
}

module.exports = { handleApi };
