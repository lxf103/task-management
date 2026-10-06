/**
 * api.js — JSON API 层（供微信小程序调用）
 * 在 server.js 中通过 handleApi(req, res, ...) 调用。
 * 认证方式：无状态签名 token（HMAC），不依赖内存 session，Railway 重启后 token 仍有效。
 */

const crypto = require('crypto');
const db = require('./db');

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

// ===== 站内通知 =====
function notify(users, targetUser, text, link, saveData) {
  const u = users.find(x => x.username === targetUser);
  if (!u) return;
  u.notifications = u.notifications || [];
  u.notifications.unshift({ text, link: link || '', at: Date.now(), read: false });
  if (u.notifications.length > 50) u.notifications.length = 50;
}

// ===== 密码哈希（scrypt 加盐）=====
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  stored = String(stored || '');
  if (!stored.includes(':')) return stored === String(pw); // 兼容旧明文
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex')); }
  catch (e) { return false; }
}

// ===== JSON 响应工具 =====
function json(res, code, data) {
  // 防止二次写入导致 ERR_STREAM_WRITE_AFTER_END 崩溃（某些 GET 分支未 return 会继续往下掉）
  if (res.writableEnded || res.headersSent) return;
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
      users.push({ username, password: hashPassword(password), region: region || '', isAdmin: isFirstUser });
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
      const user = users.find(u => u.username === username);
      if (!user || !verifyPassword(password, user.password)) return bad(res, '用户名或密码错误');
      // 兼容旧的明文密码：登录成功时升级为哈希
      if (!String(user.password).includes(':')) { user.password = hashPassword(password); saveData(); }
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
    return ok(res, { username: user.username, region: user.region, avatar: user.avatar || '', isAdmin: user.isAdmin, published, claimed, completed, balance: user.balance || 0 });
  }

  // ---------- 钱包：查余额 ----------
  if (url === '/wallet' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const user = users.find(u => u.username === currentUser);
    if (!user) return notFound(res);
    // 冻结中的金额（已发单但未确认的任务）
    const frozen = tasks.filter(t => t.publisher === currentUser && !t.confirmedAt && t.rewardAmount > 0).reduce((s, t) => s + t.rewardAmount, 0);
    return ok(res, { balance: user.balance || 0, frozen });
  }

  // ---------- 钱包：充值（模拟） ----------
  if (url === '/wallet/recharge' && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const amount = parseFloat(body.amount);
      if (!amount || amount <= 0 || amount > 9999) return bad(res, '金额无效（0.01-9999）');
      const user = users.find(u => u.username === currentUser);
      if (!user) return notFound(res);
      user.balance = (user.balance || 0) + Math.round(amount * 100) / 100;
      saveData();
      ok(res, { balance: user.balance });
    });
  }

  // ---------- 用户主页 ----------
  const userMatch = url.match(/^\/users\/([^\/]+)$/);
  if (userMatch && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const target = decodeURIComponent(userMatch[1]);
    const user = users.find(u => u.username === target);
    if (!user) return notFound(res);
    const stats = computeUserStats(target, tasks);
    const reviews = collectReviews(target, tasks);
    const isFollowing = currentUser && (users.find(u => u.username === currentUser) || {}).following && users.find(u => u.username === currentUser).following.includes(target);
    return ok(res, { username: user.username, region: user.region, avatar: user.avatar || '', joined: user.joined || null, ...stats, reviews, isFollowing });
  }

  // ---------- 关注 / 取关 ----------
  if (url === '/follow' && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const target = body.username;
      if (!target || target === currentUser) return bad(res, '无效用户');
      const me = users.find(u => u.username === currentUser);
      if (!me) return notFound(res);
      me.following = me.following || [];
      if (!me.following.includes(target)) me.following.push(target);
      saveData();
      ok(res, { following: me.following });
    });
  }
  const unfollowMatch = url.match(/^\/follow\/([^\/]+)$/);
  if (unfollowMatch && method === 'DELETE') {
    if (!currentUser) return unauthorized(res);
    const target = decodeURIComponent(unfollowMatch[1]);
    const me = users.find(u => u.username === currentUser);
    if (!me) return notFound(res);
    me.following = (me.following || []).filter(u => u !== target);
    saveData();
    return ok(res, { following: me.following });
  }
  if (url === '/me/following' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const me = users.find(u => u.username === currentUser);
    const list = (me && me.following) || [];
    const enriched = list.map(name => {
      const u = users.find(x => x.username === name);
      if (!u) return null;
      const s = computeUserStats(name, tasks);
      return { username: name, region: u.region, ...s };
    }).filter(Boolean);
    return ok(res, { following: enriched });
  }

  // ---------- 个人看板 ----------
  if (url === '/me/stats' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const myPublished = tasks.filter(t => t.publisher === currentUser);
    const myClaimed = tasks.filter(t => t.claimer === currentUser);
    const myOfferBookings = tasks.filter(t => t.type === 'offer' && t.publisher === currentUser).flatMap(t => t.bookings || []);
    const earned = myClaimed.filter(t => t.confirmedAt).reduce((s, t) => s + (t.rewardAmount || 0), 0)
                  + myOfferBookings.filter(b => b.status === 'confirmed').reduce((s, b) => {
                      const t = tasks.find(x => (x.bookings || []).includes(b));
                      return s + (t ? t.rewardAmount || 0 : 0);
                    }, 0);
    const asPublisher = computeUserStats(currentUser, tasks);
    return ok(res, {
      published: myPublished.length,
      claimed: myClaimed.length,
      confirmedPublished: myPublished.filter(t => t.confirmedAt).length,
      confirmedClaimed: myClaimed.filter(t => t.confirmedAt).length,
      offerBookings: myOfferBookings.filter(b => b.status !== 'cancelled').length,
      earned: Math.round(earned * 100) / 100,
      rating: asPublisher.rating,
      ratingCount: asPublisher.ratingCount
    });
  }

  // ---------- 站内通知 ----------
  if (url === '/me/notifications' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const me = users.find(u => u.username === currentUser);
    const list = (me && me.notifications) || [];
    const unread = list.filter(n => !n.read).length;
    return ok(res, { notifications: list.slice(0, 50), unread });
  }
  if (url === '/me/notifications/read' && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const me = users.find(u => u.username === currentUser);
    if (me && me.notifications) { me.notifications.forEach(n => n.read = true); saveData(); }
    return ok(res, { ok: true });
  }

  // ---------- 上传图片/附件 ----------
  if (url === '/upload' && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    // 接收 multipart/form-data 或原始 body（小程序 wx.uploadFile 用 multipart）
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      // 简单解析 multipart：提取文件内容
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) return bad(res, '缺少 multipart boundary');
      const parts = buffer.toString('binary').split('--' + boundary);
      let fileData = null; let fileName = 'image.png';
      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.substring(0, headerEnd);
        if (headers.includes('filename=')) {
          const fnMatch = headers.match(/filename="([^"]+)"/);
          if (fnMatch) fileName = fnMatch[1];
          fileData = Buffer.from(part.substring(headerEnd + 4, part.lastIndexOf('\r\n')), 'binary');
        }
      }
      if (!fileData || fileData.length === 0) return bad(res, '未找到文件');
      if (fileData.length > 10 * 1024 * 1024) return bad(res, '文件不能超过 10MB');
      const ext = fileName.split('.').pop() || 'png';
      const savedName = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
      const ctype = (req.headers['content-type'] || '').match(/Content-Type:\s*([^\r\n;]+)/i);
      const mime = ctype ? ctype[1].trim() : ('image/' + (ext === 'jpg' ? 'jpeg' : ext));

      // 优先存数据库
      if (db.hasDb) {
        db.saveUpload(savedName, fileData, mime).then(() => {
          ok(res, { url: '/uploads/' + savedName, name: fileName });
        }).catch(e => bad(res, '存储失败: ' + e.message));
        return;
      }
      // 回退到文件系统
      const fs = require('fs');
      const path = require('path');
      const UPLOADS_DIR = path.join(__dirname, 'uploads');
      if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
      fs.writeFileSync(path.join(UPLOADS_DIR, savedName), fileData);
      ok(res, { url: '/uploads/' + savedName, name: fileName });
    });
    return; // 已自行处理
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

  // ---------- 更新头像 ----------
  if (url === '/me/avatar' && method === 'PUT') {
    if (!currentUser) return unauthorized(res);
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const user = users.find(u => u.username === currentUser);
      if (user) { user.avatar = body.avatar || ''; saveData(); }
      ok(res, { avatar: user ? user.avatar : '' });
    });
  }

  // ---------- 任务列表（支持筛选） ----------
  if (url === '/tasks' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    // 重新解析原始带 query 的 url
    const rawUrl = ctx.originalUrl || req.url;
    const q = new URLSearchParams(rawUrl.split('?')[1] || '');
    let list = [...tasks].filter(t => t.status !== 'cancelled');

    const category = q.get('category');
    const region = q.get('region');
    const status = q.get('status');
    const keyword = q.get('keyword');

    if (category) list = list.filter(t => t.category === category);
    const typeFilter = q.get('type');
    if (typeFilter) list = list.filter(t => (t.type || 'demand') === typeFilter);
    if (region) list = list.filter(t => t.region === region || (t.delivery || '').includes(region) || (t.pickup || '').includes(region));
    if (q.get('nearby') === '1' && currentUser) {
      const me = users.find(u => u.username === currentUser);
      if (me && me.region) list = list.filter(t => t.region === me.region || (t.delivery || '').includes(me.region) || (t.pickup || '').includes(me.region));
    }
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
    const withRating = paged.map(t => {
      const f = formatTask(t);
      const pubStats = computeUserStats(t.publisher, tasks);
      f.publisherRating = pubStats.rating;
      f.publisherCompleted = pubStats.completed;
      const pub = users.find(u => u.username === t.publisher);
      f.publisherAvatar = (pub && pub.avatar) || '';
      return f;
    });

    return ok(res, { total, page, size, tasks: withRating });
  }

  // ---------- 我发布的 / 我接的 ----------
  if (url === '/tasks/my-published' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const list = tasks.filter(t => t.publisher === currentUser).sort((a, b) => b.createdAt - a.createdAt);
    return ok(res, { tasks: list.map(formatTask) });
  }
  if (url === '/tasks/my-claimed' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const list = tasks.filter(t => t.claimer === currentUser).sort((a, b) => b.createdAt - a.createdAt);
    return ok(res, { tasks: list.map(formatTask) });
  }
  if (url === '/tasks/my-offers' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const list = tasks.filter(t => t.publisher === currentUser && t.type === 'offer').sort((a, b) => b.createdAt - a.createdAt);
    return ok(res, { tasks: list.map(formatTask) });
  }

  // ---------- 任务详情 ----------
  const detailMatch = url.match(/^\/tasks\/(\d+)$/);
  if (detailMatch && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(detailMatch[1]));
    if (!task) return notFound(res);
    return ok(res, { task: formatTask(task, true) });
  }

  // ---------- 发布任务/服务 ----------
  if (url === '/tasks' && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const { description, delivery, reward, category, deadline, pickup, attachments, type, capacity, serviceTime } = body;
      const taskType = (type === 'offer') ? 'offer' : 'demand';
      if (!description || !reward) return bad(res, '描述和报酬为必填');
      if (!delivery) return bad(res, taskType === 'demand' ? '请填写送达地点' : '请填写服务地点');
      const user = users.find(u => u.username === currentUser);
      const rewardAmount = parseFloat(reward) || 0;
      const task = {
        id: nextIdRef.value++,
        type: taskType,
        description, publisher: currentUser,
        delivery: delivery || '', reward, rewardAmount,
        pickup: pickup || '',
        category: category || '其他',
        deadline: deadline || '',
        region: user ? (user.region || '') : '',
        claimed: taskType === 'offer' ? false : false,
        claimer: '',
        capacity: taskType === 'offer' ? (parseInt(capacity) || 1) : 1,
        serviceTime: serviceTime || '',
        bookings: [],
        createdAt: Date.now(),
        completedAt: null, confirmedAt: null,
        messages: [], rating: 0, attachments: attachments || [], pinned: false
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
    return ok(res, { deleted: true });
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
    notify(users, task.publisher, currentUser + ' 领取了你的任务「' + task.description.slice(0, 15) + '」', '/pages/detail/detail?id=' + task.id, saveData);
    saveData();
    return ok(res, { task: formatTask(task) });
  }

  // ---------- 取消任务（发布者操作，未领取时可取消） ----------
  const cancelMatch = url.match(/^\/tasks\/(\d+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(cancelMatch[1]));
    if (!task) return notFound(res);
    if (task.publisher !== currentUser) return bad(res, '只有发布者能取消');
    if (task.claimed) return bad(res, '已被领取的任务不能直接取消，请协商');
    task.status = 'cancelled';
    task.cancelledAt = Date.now();
    saveData();
    return ok(res, { task: formatTask(task) });
  }

  // ---------- 放弃接单（接单人反悔） ----------
  const unclaimMatch = url.match(/^\/tasks\/(\d+)\/unclaim$/);
  if (unclaimMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(unclaimMatch[1]));
    if (!task) return notFound(res);
    if (task.claimer !== currentUser) return bad(res, '只有接单人能放弃');
    if (task.completedAt) return bad(res, '已完成的任务不能放弃');
    task.claimed = false;
    task.claimer = '';
    saveData();
    return ok(res, { task: formatTask(task) });
  }

  // ---------- 完成任务（接单者操作） ----------
  const completeMatch = url.match(/^\/tasks\/(\d+)\/complete$/);
  if (completeMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(completeMatch[1]));
    if (!task) return notFound(res);
    if (task.claimer !== currentUser) return bad(res, '只有接单者能标记完成');
    task.completedAt = Date.now();
    notify(users, task.publisher, currentUser + ' 完成了任务「' + task.description.slice(0, 15) + '」，请确认', '/pages/detail/detail?id=' + task.id, saveData);
    saveData();
    return ok(res, { task: formatTask(task) });
  }

  // ---------- 确认完成（发布者操作） ----------
  const confirmMatch = url.match(/^\/tasks\/(\d+)\/confirm$/);
  if (confirmMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(confirmMatch[1]));
    if (!task) return notFound(res);
    if (task.publisher !== currentUser) return bad(res, '只有发布者能确认');
    task.confirmedAt = Date.now();
    if (task.claimer) notify(users, task.claimer, '你完成的任务「' + task.description.slice(0, 15) + '」已被确认', '/pages/detail/detail?id=' + task.id, saveData);
    saveData();
    return ok(res, { task: formatTask(task) });
  }

  // ---------- 服务：预约（占名额） ----------
  const bookMatch = url.match(/^\/tasks\/(\d+)\/book$/);
  if (bookMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(bookMatch[1]));
    if (!task) return notFound(res);
    if (task.type !== 'offer') return bad(res, '只有服务类可以预约');
    if (task.publisher === currentUser) return bad(res, '不能预约自己的服务');
    const active = (task.bookings || []).filter(b => b.status !== 'cancelled');
    if (active.length >= task.capacity) return bad(res, '名额已满');
    if (active.find(b => b.user === currentUser)) return bad(res, '你已经预约过了');
    task.bookings = task.bookings || [];
    task.bookings.push({ user: currentUser, status: 'booked', bookedAt: Date.now(), completedAt: null, confirmedAt: null });
    notify(users, task.publisher, currentUser + ' 预约了你的服务「' + task.description.slice(0, 15) + '」', '/pages/detail/detail?id=' + task.id, saveData);
    saveData();
    return ok(res, { task: formatTask(task, true) });
  }

  // ---------- 服务：完成某个预约（服务者操作） ----------
  const bookCompleteMatch = url.match(/^\/tasks\/(\d+)\/bookings\/(\d+)\/complete$/);
  if (bookCompleteMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(bookCompleteMatch[1]));
    if (!task || task.type !== 'offer') return notFound(res);
    if (task.publisher !== currentUser) return bad(res, '只有服务者能标记完成');
    const idx = parseInt(bookCompleteMatch[2]);
    if (!task.bookings || !task.bookings[idx]) return notFound(res);
    task.bookings[idx].status = 'completed';
    task.bookings[idx].completedAt = Date.now();
    saveData();
    return ok(res, { task: formatTask(task, true) });
  }

  // ---------- 服务：确认某个预约（客户操作） ----------
  const bookConfirmMatch = url.match(/^\/tasks\/(\d+)\/bookings\/(\d+)\/confirm$/);
  if (bookConfirmMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(bookConfirmMatch[1]));
    if (!task || task.type !== 'offer') return notFound(res);
    const idx = parseInt(bookConfirmMatch[2]);
    if (!task.bookings || !task.bookings[idx]) return notFound(res);
    if (task.bookings[idx].user !== currentUser) return bad(res, '只有预约者能确认');
    task.bookings[idx].status = 'confirmed';
    task.bookings[idx].confirmedAt = Date.now();
    saveData();
    return ok(res, { task: formatTask(task, true) });
  }

  // ---------- 服务：取消预约 ----------
  const bookCancelMatch = url.match(/^\/tasks\/(\d+)\/bookings\/(\d+)\/cancel$/);
  if (bookCancelMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(bookCancelMatch[1]));
    if (!task || task.type !== 'offer') return notFound(res);
    const idx = parseInt(bookCancelMatch[2]);
    if (!task.bookings || !task.bookings[idx]) return notFound(res);
    if (task.bookings[idx].user !== currentUser && task.publisher !== currentUser) return bad(res, '无权限');
    task.bookings[idx].status = 'cancelled';
    saveData();
    return ok(res, { task: formatTask(task, true) });
  }

  // ---------- 服务：评价某次预约（服务者评价客户） ----------
  const bookRateMatch = url.match(/^\/tasks\/(\d+)\/bookings\/(\d+)\/rate$/);
  if (bookRateMatch && method === 'POST') {
    if (!currentUser) return unauthorized(res);
    const task = tasks.find(t => t.id === parseInt(bookRateMatch[1]));
    if (!task || task.type !== 'offer') return notFound(res);
    if (task.publisher !== currentUser) return bad(res, '只有服务者能评价');
    const idx = parseInt(bookRateMatch[2]);
    if (!task.bookings || !task.bookings[idx]) return notFound(res);
    return parseJsonBody(req, (err, body) => {
      if (err) return bad(res, 'JSON 格式错误');
      const rating = parseInt(body.rating);
      if (!rating || rating < 1 || rating > 5) return bad(res, '评分 1-5');
      task.bookings[idx].rating = rating;
      if (body.comment) task.bookings[idx].comment = String(body.comment).slice(0, 200);
      saveData();
      ok(res, { task: formatTask(task, true) });
    });
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
      if (body.comment) task.reviewComment = String(body.comment).slice(0, 200);
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
      const other = task.publisher === currentUser ? task.claimer : task.publisher;
      if (other) notify(users, other, currentUser + ' 在任务「' + task.description.slice(0, 12) + '」给你发了消息', '/pages/detail/detail?id=' + task.id, saveData);
      saveData();
      return ok(res, { messages: task.messages });
    });
  }

  // ---------- 管理后台 ----------
  if (url.startsWith('/admin')) {
    if (!currentUser) return unauthorized(res);
    const me = users.find(u => u.username === currentUser);
    if (!me || !me.isAdmin) return json(res, 403, { success: false, message: '无管理员权限' });
    const isSuper = !!me.isSuperAdmin;

    // 概览：统计 + 用户列表 + 所有任务
    if (url === '/admin/overview' && method === 'GET') {
      return ok(res, {
        isSuper,
        stats: { tasks: tasks.length, users: users.length, completed: tasks.filter(t => t.confirmedAt).length },
        users: users.map(u => ({ username: u.username, region: u.region || '', isAdmin: !!u.isAdmin, isSuperAdmin: !!u.isSuperAdmin, banned: !!u.banned })),
        tasks: [...tasks].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.createdAt - a.createdAt).map(formatTask)
      });
    }

    // 封禁 / 解封
    if (url === '/admin/ban' && method === 'POST') {
      return parseJsonBody(req, (err, body) => {
        if (err) return bad(res, 'JSON 格式错误');
        const u = users.find(x => x.username === body.username);
        if (!u || u.isAdmin || u.isSuperAdmin) return bad(res, '不能封禁管理员');
        u.banned = true; saveData(); return ok(res, { banned: true });
      });
    }
    if (url === '/admin/unban' && method === 'POST') {
      return parseJsonBody(req, (err, body) => {
        if (err) return bad(res, 'JSON 格式错误');
        const u = users.find(x => x.username === body.username);
        if (!u) return notFound(res);
        u.banned = false; saveData(); return ok(res, { banned: false });
      });
    }

    // 设为 / 取消管理员（仅超管）
    if (url === '/admin/set-admin' && method === 'POST') {
      if (!isSuper) return json(res, 403, { success: false, message: '只有超级管理员能设置管理员' });
      return parseJsonBody(req, (err, body) => {
        if (err) return bad(res, 'JSON 格式错误');
        const u = users.find(x => x.username === body.username);
        if (!u || u.isSuperAdmin) return bad(res, '无效操作对象');
        u.isAdmin = true; saveData(); return ok(res, { isAdmin: true });
      });
    }
    if (url === '/admin/remove-admin' && method === 'POST') {
      if (!isSuper) return json(res, 403, { success: false, message: '只有超级管理员能取消管理员' });
      return parseJsonBody(req, (err, body) => {
        if (err) return bad(res, 'JSON 格式错误');
        const u = users.find(x => x.username === body.username);
        if (!u || u.isSuperAdmin || u.username === currentUser) return bad(res, '无效操作对象');
        u.isAdmin = false; saveData(); return ok(res, { isAdmin: false });
      });
    }

    // 删除任意任务
    if (url === '/admin/delete-task' && method === 'POST') {
      return parseJsonBody(req, (err, body) => {
        if (err) return bad(res, 'JSON 格式错误');
        const idx = tasks.findIndex(t => t.id === parseInt(body.taskId));
        if (idx === -1) return notFound(res);
        tasks.splice(idx, 1); saveData(); return ok(res, { deleted: true });
      });
    }

    return notFound(res);
  }

  // ---------- 获取分类列表（固定） ----------
  if (url === '/categories' && method === 'GET') {
    return ok(res, { categories: ['快递代拿', '学习', '生活', '跑腿', '其他'] });
  }

  // ---------- 获取地区列表（从已有用户中提取） ----------
  if (url === '/regions' && method === 'GET') {
    const regions = [...new Set(users.map(u => u.region).filter(Boolean))];
    return ok(res, { regions });
  }

  // ---------- 新单计数（轮询用：since 之后有多少可接新单） ----------
  if (url === '/tasks/new-count' && method === 'GET') {
    if (!currentUser) return unauthorized(res);
    const rawUrl = ctx.originalUrl || req.url;
    const q = new URLSearchParams(rawUrl.split('?')[1] || '');
    const since = parseInt(q.get('since')) || 0;
    const nearby = q.get('nearby') === '1';
    let list = tasks.filter(t => !t.claimed && !t.confirmedAt && t.createdAt > since);
    if (nearby) {
      const me = users.find(u => u.username === currentUser);
      if (me && me.region) list = list.filter(t => t.region === me.region || (t.delivery || '').includes(me.region) || (t.pickup || '').includes(me.region));
    }
    return ok(res, { count: list.length, latest: list.length ? Math.max(...list.map(t => t.createdAt)) : since });
  }

  // ---------- 未匹配 ----------
  notFound(res);
}

// ===== 格式化任务输出 =====
function formatTask(t, includeMessages = false) {
  const obj = {
    id: t.id,
    type: t.type || 'demand',
    status: t.status || '',
    description: t.description,
    publisher: t.publisher,
    delivery: t.delivery,
    reward: t.reward,
    rewardAmount: t.rewardAmount || 0,
    pickup: t.pickup || '',
    category: t.category,
    deadline: t.deadline,
    region: t.region || '',
    claimed: t.claimed,
    claimer: t.claimer || '',
    capacity: t.capacity || 1,
    serviceTime: t.serviceTime || '',
    bookings: (t.bookings || []).map((b, i) => ({ ...b, _idx: i })),
    bookedCount: (t.bookings || []).filter(b => b.status !== 'cancelled').length,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
    confirmedAt: t.confirmedAt,
    rating: t.rating || 0,
    reviewComment: t.reviewComment || '',
    pinned: t.pinned || false,
    attachments: (t.attachments || []).map(a => ({ name: a.originalName || a.name, url: a.url || a.path })),
    messageCount: (t.messages || []).length
  };
  if (includeMessages) obj.messages = t.messages || [];
  return obj;
}

// 计算某个用户的评分和完成数（作为接单者/服务者被评价）
function computeUserStats(username, tasks) {
  let total = 0, count = 0;
  tasks.forEach(t => {
    if (t.type === 'offer') {
      (t.bookings || []).forEach(b => {
        if (b.user === username && b.rating) { total += b.rating; count++; }
      });
    } else if (t.claimer === username && t.rating) {
      total += t.rating; count++;
    }
  });
  // 作为发布者被完成/确认数
  const completed = tasks.filter(t => (t.claimer === username && t.confirmedAt) || (t.type === 'offer' && (t.bookings || []).some(b => b.user === username && b.status === 'confirmed'))).length;
  return {
    rating: count > 0 ? Math.round((total / count) * 10) / 10 : 0,
    ratingCount: count,
    completed
  };
}

// 收集某个用户收到的评价（别人给他的评分）
function collectReviews(username, tasks) {
  const reviews = [];
  tasks.forEach(t => {
    if (t.type === 'offer') {
      (t.bookings || []).forEach(b => {
        if (b.user === username && b.rating) {
          reviews.push({ from: t.publisher, rating: b.rating, comment: b.comment || '', taskId: t.id, taskDesc: t.description, at: b.confirmedAt || b.completedAt });
        }
      });
    } else if (t.claimer === username && t.rating) {
      reviews.push({ from: t.publisher, rating: t.rating, comment: t.reviewComment || '', taskId: t.id, taskDesc: t.description, at: t.confirmedAt });
    }
  });
  return reviews.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 20);
}

module.exports = { handleApi };
