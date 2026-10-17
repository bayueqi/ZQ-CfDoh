let DoH = "cloudflare-dns.com";
let dnsDoH = `https://${DoH}/dns-query`;
let jsonDoH = `https://${DoH}/resolve`;
let DoHPath = 'dns-query';
export default {
  async fetch(request, env, ctx) {
    // 上游可用环境变量 DOH 覆盖，两个地址跟着一起变
    if (env.DOH) {
      DoH = (env.DOH.match(/:\/\/([^\/]+)/) || [])[1] || env.DOH;
      dnsDoH = `https://${DoH}/dns-query`;
      jsonDoH = `https://${DoH}/resolve`;
    }
    if (env.DoHPath) {
      DoHPath = env.DoHPath;
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // 解析 cookie（供后面主页面认证检查使用）
    const cookies = Object.fromEntries(
      (request.headers.get('Cookie') || '')
        .split(';')
        .map(c => c.trim())
        .filter(c => c)
        .map(c => {
          const eq = c.indexOf('=');
          return eq >= 0 ? [c.slice(0, eq), c.slice(eq + 1)] : [c, ''];
        })
    );

    // 处理密码认证路由（验证密码 = DoHPath 变量）
    if (path === '/auth') {
      if (request.method === 'POST') {
        const formData = await request.formData();
        const password = formData.get('password') || '';

        if (password === DoHPath) {
          // 密码正确，设置 HttpOnly cookie，跳转回主页
          return new Response('验证成功，正在跳转...', {
            status: 302,
            headers: {
              'Location': '/',
              'Set-Cookie': `auth=${btoa(encodeURIComponent(DoHPath))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
            }
          });
        } else {
          // 密码错误，返回密码页并带错误提示
          return await 密码页('访问码错误，请重试');
        }
      }
      // GET /auth 也返回密码页
      return await 密码页();
    }

    // 如果请求路径，则作为 DoH 服务器处理
    if (path === `/${DoHPath}`) {
      return await DOHRequest(request, env, ctx);
    }


    
    // 文件下载路由：/{size}KB|MB|GB，代理到 speed.cloudflare.com
    const sizeMatch = path.match(/^\/(\d+)(KB|MB|GB)$/i);
    if (sizeMatch) {
      const bytes = parseInt(sizeMatch[1]) * { KB: 1e3, MB: 1e6, GB: 1e9 }[sizeMatch[2].toUpperCase()];
      const headers = new Headers(request.headers);
      headers.set('referer', 'https://speed.cloudflare.com/');
      const res = await fetch(new Request(`https://speed.cloudflare.com/__down?bytes=${bytes}`, {
        method: request.method === 'HEAD' ? 'GET' : request.method,
        headers: headers,
        body: request.body
      }));
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
    }



    // 拦截记录与白名单接口
    if (path === '/blocked/api') {
      if (cookies.auth !== btoa(encodeURIComponent(DoHPath))) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json; charset=UTF-8' }
        });
      }
      if (!env.cfdoh) {
        return new Response(JSON.stringify({ error: '未绑定 D1，变量名需为 cfdoh' }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=UTF-8' }
        });
      }
      try {
        return await blockedApi(url, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=UTF-8' }
        });
      }
    }

    // 添加IP地理位置信息查询代理
    if (path === '/ip-info') {

      const ip = url.searchParams.get('ip') || request.headers.get('CF-Connecting-IP');
      if (!ip) {
        return new Response(JSON.stringify({ 
          status: "error",
          message: "IP参数未提供",
          code: "MISSING_PARAMETER",
          timestamp: new Date().toISOString()
        }, null, 4), {
          status: 400,
          headers: {
            "content-type": "application/json; charset=UTF-8",
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      try {
        // 使用Worker代理请求HTTP的IP API
        const response = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN`);

        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }

        const data = await response.json();
        
        // 添加时间戳到成功的响应数据中
        data.timestamp = new Date().toISOString();

        // 返回数据给客户端，并添加CORS头
        return new Response(JSON.stringify(data, null, 4), {
          headers: {
            "content-type": "application/json; charset=UTF-8",
            'Access-Control-Allow-Origin': '*'
          }
        });

      } catch (error) {
        console.error("IP查询失败:", error);
        return new Response(JSON.stringify({
          status: "error",
          message: `IP查询失败: ${error.message}`,
          code: "API_REQUEST_FAILED",
          query: ip,
          timestamp: new Date().toISOString(),
          details: {
            errorType: error.name,
            stack: error.stack ? error.stack.split('\n')[0] : null
          }
        }, null, 4), {
          status: 500,
          headers: {
            "content-type": "application/json; charset=UTF-8",
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 如果请求参数中包含 domain 和 doh，则执行 DNS 解析
    if (url.searchParams.has("doh")) {
      const domain = url.searchParams.get("domain") || url.searchParams.get("name") || "www.google.com";
      const doh = url.searchParams.get("doh") || dnsDoH;
      const type = url.searchParams.get("type") || "all"; // 默认同时查询 A 和 AAAA

      // 如果使用的是当前站点，则使用 DoH 服务
      if (doh.includes(url.host)) {
        return await handleLocalDoHRequest(domain, type);
      }

      try {
        const result = type === "all" ? await queryAll(doh, domain) : await queryDns(doh, domain, type);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      } catch (err) {
        console.error("DNS 查询失败:", err);
        return new Response(JSON.stringify({
          error: `DNS 查询失败: ${err.message}`,
          doh: doh,
          domain: domain,
          stack: err.stack
        }, null, 2), {
          headers: { "content-type": "application/json; charset=UTF-8" },
          status: 500
        });
      }
    }

    // 主页面：检查认证 cookie（值 = btoa(encodeURIComponent(DoHPath))），无则返回密码页
    if (cookies.auth !== btoa(encodeURIComponent(DoHPath))) {
      return await 密码页();
    }
    return await HTML();
  }
}

// 查询DNS的通用函数
async function queryDns(dohServer, domain, type) {
  // 构造 DoH 请求 URL
  const dohUrl = new URL(dohServer);
  dohUrl.searchParams.set("name", domain);
  dohUrl.searchParams.set("type", type);

  // 尝试多种请求头格式
  const fetchOptions = [
    // 标准 application/dns-json
    {
      headers: { 'Accept': 'application/dns-json' }
    },
    // 部分服务使用没有指定 Accept 头的请求
    {
      headers: {}
    },
    // 另一个尝试 application/json
    {
      headers: { 'Accept': 'application/json' }
    },
    // 稳妥起见，有些服务可能需要明确的用户代理
    {
      headers: {
        'Accept': 'application/dns-json',
        'User-Agent': 'Mozilla/5.0 DNS Client'
      }
    }
  ];

  let lastError = null;

  // 依次尝试不同的请求头组合
  for (const options of fetchOptions) {
    try {
      const response = await fetch(dohUrl.toString(), options);

      // 如果请求成功，解析JSON
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        // 检查内容类型是否兼容
        if (contentType.includes('json') || contentType.includes('dns-json')) {
          return await response.json();
        } else {
          // 对于非标准的响应，仍尝试进行解析
          const textResponse = await response.text();
          try {
            return JSON.parse(textResponse);
          } catch (jsonError) {
            throw new Error(`无法解析响应为JSON: ${jsonError.message}, 响应内容: ${textResponse.substring(0, 100)}`);
          }
        }
      }

      // 错误情况记录，继续尝试下一个选项
      const errorText = await response.text();
      lastError = new Error(`DoH 服务器返回错误 (${response.status}): ${errorText.substring(0, 200)}`);

    } catch (err) {
      // 记录错误，继续尝试下一个选项
      lastError = err;
    }
  }

  // 所有尝试都失败，抛出最后一个错误
  throw lastError || new Error("无法完成 DNS 查询");
}

// A / AAAA / NS 三路并行后合并成一份（Question 可能是对象也可能是数组）
async function queryAll(doh, domain) {
  const [v4, v6, ns] = await Promise.all([
    queryDns(doh, domain, 'A'),
    queryDns(doh, domain, 'AAAA'),
    queryDns(doh, domain, 'NS')
  ]);
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const nsRecords = [
    ...(ns.Answer || []).filter((r) => r.type === 2),
    ...(ns.Authority || []).filter((r) => r.type === 2 || r.type === 6)
  ];
  return {
    Status: v4.Status || v6.Status || ns.Status,
    TC: v4.TC || v6.TC || ns.TC,
    RD: v4.RD || v6.RD || ns.RD,
    RA: v4.RA || v6.RA || ns.RA,
    AD: v4.AD || v6.AD || ns.AD,
    CD: v4.CD || v6.CD || ns.CD,
    Question: [...arr(v4.Question), ...arr(v6.Question), ...arr(ns.Question)],
    Answer: [...(v4.Answer || []), ...(v6.Answer || []), ...nsRecords],
    ipv4: { records: v4.Answer || [] },
    ipv6: { records: v6.Answer || [] },
    ns: { records: nsRecords }
  };
}

// 请求目标是本站时，直接问上游，不再绕回自己
async function handleLocalDoHRequest(domain, type) {
  const jsonHeaders = {
    "content-type": "application/json; charset=UTF-8",
    'Access-Control-Allow-Origin': '*'
  };
  try {
    const result = type === "all" ? await queryAll(dnsDoH, domain) : await queryDns(dnsDoH, domain, type);
    return new Response(JSON.stringify(result, null, 2), { headers: jsonHeaders });
  } catch (err) {
    console.error("DoH 查询失败:", err);
    return new Response(JSON.stringify({
      error: `DoH 查询失败: ${err.message}`,
      stack: err.stack
    }, null, 2), { headers: jsonHeaders, status: 500 });
  }
}

// ===== 广告拦截：名单缓存与报文工具 =====
const dec = new TextDecoder();

function normalizeDomain(s) {
  if (!s) return '';
  let d = String(s).trim().toLowerCase().replace(/\.$/, '');
  if (d.startsWith('https://')) d = d.slice(8);
  else if (d.startsWith('http://')) d = d.slice(7);
  d = d.split('/')[0].split(':')[0];
  return /^[a-z0-9._-]+$/.test(d) && d.includes('.') ? d : '';
}

// 默认名单放仓库，冷启动按 URL 去边缘缓存取，缓存没了才回 GitHub 拉
const LIST_URL = 'https://raw.githubusercontent.com/bayueqi/ZQ-CfDoh/main/blocklist.txt';
const LIST_TTL = 6 * 3600;

let blkSet = null;
let blkTask = null;

function loadBaseSet() {
  if (blkSet) return Promise.resolve(blkSet);
  if (!blkTask) {
    blkTask = (async () => {
      const cache = caches.default;
      const req = new Request(LIST_URL);
      let res = await cache.match(req);
      if (!res) {
        const r = await fetch(req);
        if (!r.ok) throw new Error('名单 HTTP ' + r.status);
        res = new Response(r.body, {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'public, max-age=' + LIST_TTL
          }
        });
        await cache.put(req, res.clone());
      }
      const text = await res.text();
      blkSet = new Set(text.split('\n').filter(Boolean));
      return blkSet;
    })().catch(() => {
      blkTask = null;
      return new Set();
    });
  }
  return blkTask;
}

async function getBaseSet(env) {
  const set = await loadBaseSet();
  if (set.size) return set;
  // 拉不到名单时退回 KV，两处都没有就当没拦
  if (env.BLOCK) {
    try {
      const t = (await env.BLOCK.get('blocklist')) || '';
      if (t) return new Set(t.split('\n').filter(Boolean));
    } catch (e) {}
  }
  return set;
}

// 面板的「刷新名单」：清边缘缓存和内存，下一次查询重新拉
async function refreshBaseSet() {
  try {
    await caches.default.delete(new Request(LIST_URL));
  } catch (e) {}
  blkSet = null;
  blkTask = null;
}

// 三张表各缓存 60 秒，避免每个 DNS 查询都打库
const setMemo = { allowlist: { set: null, at: 0 }, rules: { set: null, at: 0 }, removed: { set: null, at: 0 } };

async function getDomainSet(env, table) {
  const m = setMemo[table];
  if (m.set && Date.now() - m.at < 60000) return m.set;
  let set = new Set();
  if (env.cfdoh) {
    try {
      const r = await env.cfdoh.prepare('SELECT domain FROM ' + table).all();
      set = new Set((r.results || []).map((x) => x.domain));
    } catch (e) {}
  }
  m.set = set;
  m.at = Date.now();
  return set;
}

// 逐级后缀比对：白名单 > 移出 > （大名单 + 手动加的）
function isBlocked(name, base, rules, allow, removed) {
  const p = name.split('.');
  for (let i = 0; i < p.length - 1; i++) {
    if (allow.has(p.slice(i).join('.'))) return false;
  }
  for (const r of removed) {
    if (name === r || name.endsWith('.' + r)) return false;
  }
  for (let i = 0; i < p.length - 1; i++) {
    const s = p.slice(i).join('.');
    if (rules.has(s) || base.has(s)) return true;
  }
  return false;
}

function logHit(env, ctx, domain) {
  if (!env.cfdoh) return;
  const p = env.cfdoh.prepare('INSERT INTO hits (domain, ts) VALUES (?, ?)')
    .bind(domain, Date.now())
    .run();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

// 取报文里的问题域名，end 是问题区结束位置
function readQuestion(buf) {
  if (buf.length < 12 || ((buf[4] << 8) | buf[5]) !== 1) return null;
  const labels = [];
  let o = 12;
  while (o < buf.length && buf[o] !== 0) {
    const n = buf[o];
    if (n & 0xc0) return null;
    labels.push(dec.decode(buf.subarray(o + 1, o + 1 + n)));
    o += n + 1;
  }
  if (!labels.length) return null;
  return { name: labels.join('.').toLowerCase(), end: o + 5 };
}

// 复制报文头与问题区，答案数清零，打 NXDOMAIN
function nxd(buf, end) {
  const out = buf.slice(0, end);
  out[2] = 0x80 | (buf[2] & 0x01);
  out[3] = 0x80 | 0x03;
  out[4] = 0;
  out[5] = 1;
  for (let i = 6; i < 12; i++) out[i] = 0;
  return out;
}

function fromB64url(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 表不存在就建，省得手动跑 SQL；建失败不标记，下次请求再试
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS hits (domain TEXT, ts INTEGER)',
  'CREATE TABLE IF NOT EXISTS allowlist (domain TEXT PRIMARY KEY, ts INTEGER)',
  'CREATE TABLE IF NOT EXISTS rules (domain TEXT PRIMARY KEY, ts INTEGER)',
  'CREATE TABLE IF NOT EXISTS removed (domain TEXT PRIMARY KEY, ts INTEGER)'
];
let schemaReady = false;

async function ensureTables(db) {
  if (schemaReady) return;
  try {
    for (const s of SCHEMA) await db.prepare(s).run();
    schemaReady = true;
  } catch (e) {}
}

// 拦截记录 / 白名单接口
async function blockedApi(url, env) {
  const db = env.cfdoh;
  const action = url.searchParams.get('action') || 'list';
  const json = (o, s = 200) =>
    new Response(JSON.stringify(o), {
      status: s,
      headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' }
    });

  await ensureTables(db);

  if (action === 'allow' || action === 'unallow') {
    const d = normalizeDomain(url.searchParams.get('d'));
    if (!d) return json({ error: '域名不合法' }, 400);
    if (action === 'allow') {
      await db.prepare('INSERT OR REPLACE INTO allowlist (domain, ts) VALUES (?, ?)').bind(d, Date.now()).run();
    } else {
      await db.prepare('DELETE FROM allowlist WHERE domain = ?').bind(d).run();
    }
    setMemo.allowlist.at = 0;
    return json({ ok: true, domain: d });
  }

  // 查这个域名当前在不在拦截名单里，面板据此把按钮切成「拦截 / 删除」
  if (action === 'check') {
    const d = normalizeDomain(url.searchParams.get('d'));
    if (!d) return json({ error: '域名不合法' }, 400);
    const base = await getBaseSet(env);
    const rules = await getDomainSet(env, 'rules');
    const allow = await getDomainSet(env, 'allowlist');
    const removed = await getDomainSet(env, 'removed');
    return json({ domain: d, blocked: isBlocked(d, base, rules, allow, removed) });
  }

  // 往名单里加 / 从名单里删，默认名单里的条目也能删
  if (action === 'block' || action === 'unblock') {
    const d = normalizeDomain(url.searchParams.get('d'));
    if (!d) return json({ error: '域名不合法' }, 400);
    if (action === 'block') {
      const base = await getBaseSet(env);
      await db.prepare('DELETE FROM removed WHERE domain = ?').bind(d).run();
      if (!base.has(d)) {
        await db.prepare('INSERT OR REPLACE INTO rules (domain, ts) VALUES (?, ?)').bind(d, Date.now()).run();
      }
    } else {
      await db.prepare('DELETE FROM rules WHERE domain = ?').bind(d).run();
      const base = await getBaseSet(env);
      if (base.has(d)) {
        await db.prepare('INSERT OR REPLACE INTO removed (domain, ts) VALUES (?, ?)').bind(d, Date.now()).run();
      }
    }
    setMemo.rules.at = 0;
    setMemo.removed.at = 0;
    return json({ ok: true, domain: d });
  }

  // 清缓存重新拉 GitHub 上的名单
  if (action === 'refresh') {
    await refreshBaseSet();
    const base = await getBaseSet(env);
    return json({ ok: true, count: base.size });
  }

  // 顺手清掉 7 天前的记录
  await db.prepare('DELETE FROM hits WHERE ts < ?').bind(Date.now() - 7 * 86400000).run();

  const cst = Date.now() + 8 * 3600000;
  const dayStart = cst - (cst % 86400000) - 8 * 3600000;

  const total = await db.prepare('SELECT COUNT(*) AS n FROM hits').first();
  const today = await db.prepare('SELECT COUNT(*) AS n FROM hits WHERE ts >= ?').bind(dayStart).first();
  const hits = await db.prepare('SELECT domain, ts FROM hits ORDER BY ts DESC LIMIT 100').all();
  const top = await db.prepare('SELECT domain, COUNT(*) AS n FROM hits GROUP BY domain ORDER BY n DESC LIMIT 10').all();
  const allow = await db.prepare('SELECT domain FROM allowlist ORDER BY ts DESC').all();
  let rules = { results: [] };
  try {
    rules = await db.prepare('SELECT domain FROM rules ORDER BY ts DESC').all();
  } catch (e) {}
  let removed = { results: [] };
  try {
    removed = await db.prepare('SELECT domain FROM removed ORDER BY ts DESC').all();
  } catch (e) {}

  const base = await getBaseSet(env);
  let count = base.size;
  for (const x of removed.results || []) if (base.has(x.domain)) count--;
  for (const x of rules.results || []) if (!base.has(x.domain)) count++;

  return json({
    total: (total && total.n) || 0,
    today: (today && today.n) || 0,
    count: count,
    hits: hits.results || [],
    top: top.results || [],
    allow: (allow.results || []).map((r) => r.domain),
    rules: (rules.results || []).map((r) => r.domain)
  });
}

// DoH 请求处理函数
async function DOHRequest(request, env, ctx) {
  const { method, headers, body } = request;
  const UA = headers.get('User-Agent') || 'DoH Client';
  const url = new URL(request.url);
  const { searchParams } = url;

  // POST 报文只读一次：拦截判断和转发共用同一份 buffer
  let postRaw = null;
  if (method === 'POST') {
    try {
      postRaw = new Uint8Array(await request.arrayBuffer());
    } catch (e) {
      postRaw = null;
    }
  }

  try {
    // 直接访问端点的处理
    if (method === 'GET' && !url.search) {
      // 如果是直接访问或浏览器访问，返回友好信息
      return new Response('Bad Request', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 拦截判断：命中名单就地返回，不发给上游
    const baseSet = await getBaseSet(env);
    const ruleSet = await getDomainSet(env, 'rules');
    const removeSet = await getDomainSet(env, 'removed');
    if (baseSet.size || ruleSet.size) {
      const allowSet = await getDomainSet(env, 'allowlist');
      let rawQ = null;
      let q = null;

      if (method === 'POST') {
        rawQ = postRaw;
        q = rawQ ? readQuestion(rawQ) : null;
      } else if (method === 'GET' && searchParams.has('dns')) {
        try {
          rawQ = fromB64url(searchParams.get('dns'));
          q = readQuestion(rawQ);
        } catch (e) {
          q = null;
        }
      }

      if (q && isBlocked(q.name, baseSet, ruleSet, allowSet, removeSet)) {
        logHit(env, ctx, q.name);
        return new Response(nxd(rawQ, q.end), {
          headers: {
            'Content-Type': 'application/dns-message',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // JSON 接口按 name 参数拦
      if (method === 'GET' && searchParams.has('name')) {
        const n = normalizeDomain(searchParams.get('name'));
        if (n && isBlocked(n, baseSet, ruleSet, allowSet, removeSet)) {
          logHit(env, ctx, n);
          return new Response(JSON.stringify({
            Status: 3,
            Question: [{ name: n + '.', type: 1 }],
            Comment: 'blocked'
          }, null, 2), {
            headers: {
              'Content-Type': 'application/dns-json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      }
    }

    // 根据请求方法和参数构建转发请求
    let response;

    if (method === 'GET' && searchParams.has('name')) {
      const searchDoH = searchParams.has('type') ? url.search : url.search + '&type=A';
      // 处理 JSON 格式的 DoH 请求
      response = await fetch(dnsDoH + searchDoH, {
        headers: {
          'Accept': 'application/dns-json',
          'User-Agent': UA
        }
      });
      // 如果 DoHUrl 请求非成功（状态码 200），则再请求 jsonDoH
      if (!response.ok) response = await fetch(jsonDoH + searchDoH, {
        headers: {
          'Accept': 'application/dns-json',
          'User-Agent': UA
        }
      });
    } else if (method === 'GET') {
      // 处理 base64url 格式的 GET 请求
      response = await fetch(dnsDoH + url.search, {
        headers: {
          'Accept': 'application/dns-message',
          'User-Agent': UA
        }
      });
    } else if (method === 'POST') {
      // 处理 POST 请求
      response = await fetch(dnsDoH, {
        method: 'POST',
        headers: {
          'Accept': 'application/dns-message',
          'Content-Type': 'application/dns-message',
          'User-Agent': UA
        },
        body: postRaw || body
      });

    } else {
      // 其他不支持的请求方式
      return new Response('不支持的请求格式: DoH请求需要包含name或dns参数，或使用POST方法', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DoH 返回错误 (${response.status}): ${errorText.substring(0, 200)}`);
    }

    // 创建一个新的响应头对象
    const responseHeaders = new Headers(response.headers);
    // 设置跨域资源共享 (CORS) 的头部信息
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    
    // 检查是否为JSON格式的DoH请求，确保设置正确的Content-Type
    if (method === 'GET' && searchParams.has('name')) {
      // 对于JSON格式的DoH请求，明确设置Content-Type为application/json
      responseHeaders.set('Content-Type', 'application/json');
    }

    // 返回响应
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    console.error("DoH 请求处理错误:", error);
    return new Response(JSON.stringify({
      error: `DoH 请求处理错误: ${error.message}`,
      stack: error.stack
    }, null, 4), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// 密码输入页（伪装页）
async function 密码页(errorMsg = '') {
  const errorHtml = errorMsg ? `<div style="color:#dc3545;margin-bottom:12px;font-size:14px;">${errorMsg}</div>` : '';
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>请输入访问码</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    background: url('https://cf-assets.www.cloudflare.com/dzlvafdwdttg/5B5shLB8bSKIyB9NJ6R1jz/87e7617be2c61603d46003cb3f1bd382/Hero-globe-bg-takeover-xxl.png'),
      linear-gradient(135deg, rgba(253, 101, 60, 0.85) 0%, rgba(251,152,30, 0.85) 100%);
    background-size: cover;
    background-position: center center;
    background-repeat: no-repeat;
    background-attachment: fixed;
    padding: 20px;
  }
  .login-card {
    width: 100%;
    max-width: 380px;
    background-color: rgba(255, 255, 255, 0.72);
    border-radius: 16px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, 0.45);
    padding: 36px 32px;
  }
  h1 {
    text-align: center;
    font-weight: 600;
    font-size: 22px;
    background-image: linear-gradient(to right, rgb(249, 171, 76), rgb(252, 103, 60));
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 24px;
  }
  label {
    display: block;
    font-size: 14px;
    font-weight: 500;
    color: rgb(70, 50, 40);
    margin-bottom: 8px;
  }
  input[type="password"] {
    width: 100%;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid rgba(253, 101, 60, 0.3);
    background-color: rgba(255, 255, 255, 0.9);
    font-size: 15px;
    outline: none;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  input[type="password"]:focus {
    border-color: rgb(253, 101, 60);
    box-shadow: 0 0 0 3px rgba(253, 101, 60, 0.15);
  }
  button[type="submit"] {
    width: 100%;
    margin-top: 20px;
    padding: 12px;
    border-radius: 8px;
    border: none;
    background-color: rgb(253, 101, 60);
    color: #fff;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s ease, transform 0.15s ease;
  }
  button[type="submit"]:hover {
    background-color: rgb(230, 90, 50);
    transform: translateY(-1px);
  }
  button[type="submit"]:active {
    transform: translateY(0);
  }
</style>
</head>
<body>
  <div class="login-card">
    <h1>ZQ-CfDoh</h1>
    ${errorHtml}
    <form method="POST" action="/auth">
      <label for="pwd">访问码</label>
      <input type="password" id="pwd" name="password" placeholder="请输入访问码" autofocus autocomplete="current-password">
      <button type="submit">进入</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html;charset=UTF-8" }
  });
}

async function HTML() {
  // 否则返回 HTML 页面
  const html = `<!DOCTYPE html>
<html lang="zh-CN">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZQ-CfDoh</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg t='1776862807100' class='icon' viewBox='0 0 1024 1024' version='1.1' xmlns='http://www.w3.org/2000/svg' p-id='1867' width='200' height='200'><path d='M512 83.2h19.2V64H512C265.6 64 64 265.6 64 512h19.2c0-236.8 192-428.8 428.8-428.8zM944 512c0 230.4-182.4 422.4-412.8 428.8v19.2C768 950.4 960 755.2 960 512h-16z m-38.4 0c0-208-169.6-377.6-377.6-377.6S153.6 304 153.6 512c0 208 169.6 377.6 377.6 377.6 208 0 374.4-169.6 374.4-377.6zM188.8 512c0-188.8 153.6-339.2 339.2-339.2S870.4 323.2 870.4 512c0 188.8-153.6 339.2-339.2 339.2-188.8 3.2-342.4-150.4-342.4-339.2z m342.4 64c19.2 19.2 44.8 28.8 70.4 28.8h19.2c60.8 0 108.8-48 108.8-108.8v-70.4c0-28.8-12.8-54.4-32-76.8s-48-32-76.8-32h-19.2c-25.6 0-51.2 9.6-70.4 28.8v-32h-35.2v393.6h35.2V576z m0-153.6c0-38.4 32-70.4 70.4-70.4h19.2c38.4 0 70.4 32 70.4 70.4v70.4c0 38.4-32 70.4-70.4 70.4h-19.2c-38.4 0-70.4-32-70.4-70.4v-70.4z m-144 288h35.2V313.6h-35.2v396.8z' fill='' p-id='1868'></path></svg>">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      min-height: 100vh;
      padding: 0;
      margin: 0;
      line-height: 1.6;
      background: url('https://cf-assets.www.cloudflare.com/dzlvafdwdttg/5B5shLB8bSKIyB9NJ6R1jz/87e7617be2c61603d46003cb3f1bd382/Hero-globe-bg-takeover-xxl.png'),
        linear-gradient(135deg, rgba(253, 101, 60, 0.85) 0%, rgba(251,152,30, 0.85) 100%);
      background-size: cover;
      background-position: center center;
      background-repeat: no-repeat;
      background-attachment: fixed;
      padding: 30px 20px;
      box-sizing: border-box;
    }

    .page-wrapper {
      width: 100%;
      max-width: 800px;
      margin: 0 auto;
    }

    .container {
      width: 100%;
      max-width: 800px;
      margin: 20px auto;
      background-color: rgba(255, 255, 255, 0.65);
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
      padding: 30px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.4);
    }

    h1 {
      /* 创建文字渐变效果 */
      background-image: linear-gradient(to right, rgb(249, 171, 76), rgb(252, 103, 60));
      /* 回退颜色，用于不支持渐变文本的浏览器 */
      color: rgb(252, 103, 60);
      -webkit-background-clip: text;
      -moz-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      -moz-text-fill-color: transparent;
      
      font-weight: 600;
      /* 注意：渐变文本和阴影效果同时使用可能不兼容，暂时移除阴影 */
      text-shadow: none;
    }

    .card {
      margin-bottom: 20px;
      border: none;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
      background-color: rgba(255, 255, 255, 0.8);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
    }

    .card-header {
      background-color: rgba(255, 242, 235, 0.9);
      font-weight: 600;
      padding: 12px 20px;
      border-bottom: none;
    }

    /* 卡内分节标题（DNS 查询设置与解析结果同卡） */
    .result-divider {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 20px;
      padding-top: 15px;
      border-top: 1px solid rgba(253, 101, 60, 0.25);
      font-weight: 600;
      color: rgb(70, 50, 40);
    }

    /* 折叠面板样式 */
    .collapse-card {
      margin-bottom: 20px;
      border-radius: 12px;
      overflow: hidden;
      background-color: rgba(255, 255, 255, 0.8);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.4);
    }

    .collapse-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border: none;
      outline: none;
      cursor: pointer;
      padding: 14px 20px;
      font-size: 1rem;
      font-weight: 600;
      text-align: left;
      color: rgb(70, 50, 40);
      background: linear-gradient(to right, rgba(255, 242, 235, 0.9), rgba(255, 240, 230, 0.75));
      transition: all 0.3s ease;
    }

    .collapse-toggle:hover {
      background: linear-gradient(to right, rgba(255, 228, 214, 0.95), rgba(255, 222, 205, 0.8));
      box-shadow: inset 4px 0 0 rgb(253, 101, 60);
      padding-left: 26px;
    }

    .collapse-title {
      display: flex;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
    }

    .collapse-icon {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
      color: rgb(253, 101, 60);
      transform: rotate(-90deg);
      transition: transform 0.35s ease;
    }

    .collapse-toggle:hover .collapse-icon {
      transform: rotate(-45deg) scale(1.15);
    }

    .collapse-toggle.open .collapse-icon {
      transform: rotate(0deg) scale(1);
    }

    .collapse-content {
      display: grid;
      grid-template-rows: 0fr;
      transition: grid-template-rows 0.4s ease;
    }

    .collapse-content.open {
      grid-template-rows: 1fr;
    }

    .collapse-inner {
      min-height: 0;
      overflow: hidden;
      opacity: 0;
      transform: translateY(-8px);
      transition: opacity 0.35s ease, transform 0.35s ease;
    }

    .collapse-content.open .collapse-inner {
      opacity: 1;
      transform: translateY(0);
    }

    /* 去除折叠面板尾部留白 */
    .collapse-inner > .card:last-child {
      margin-bottom: 0;
    }

    .form-label {
      font-weight: 500;
      margin-bottom: 8px;
      color: rgb(70, 50, 40);
    }

    .form-select,
    .form-control {
      border-radius: 6px;
      padding: 10px;
      border: 1px solid rgba(253, 101, 60, 0.3);
      background-color: rgba(255, 255, 255, 0.9);
    }

    .btn-primary {
      background-color: rgb(253, 101, 60);
      border: none;
      border-radius: 6px;
      padding: 10px 20px;
      font-weight: 500;
      transition: all 0.2s ease;
    }

    .btn-primary:hover {
      background-color: rgb(230, 90, 50);
      transform: translateY(-1px);
    }

    pre {
      background-color: rgba(255, 245, 240, 0.9);
      padding: 15px;
      border-radius: 6px;
      border: 1px solid rgba(253, 101, 60, 0.2);
      white-space: pre-wrap;
      word-break: break-all;
      font-family: Consolas, Monaco, 'Andale Mono', monospace;
      font-size: 14px;
      max-height: 400px;
      overflow: auto;
    }

    .loading {
      display: none;
      text-align: center;
      padding: 20px 0;
    }

    .loading-spinner {
      border: 4px solid rgba(0, 0, 0, 0.1);
      border-left: 4px solid rgb(253, 101, 60);
      border-radius: 50%;
      width: 30px;
      height: 30px;
      animation: spin 1s linear infinite;
      margin: 0 auto 10px;
    }

    .badge {
      margin-left: 5px;
      font-size: 11px;
      vertical-align: middle;
    }

    @keyframes spin {
      0% {
        transform: rotate(0deg);
      }

      100% {
        transform: rotate(360deg);
      }
    }

    .footer {
      margin-top: 30px;
      text-align: center;
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
    }

    .beian-info {
      text-align: center;
      font-size: 13px;
    }

    .beian-info a {
      color: var(--primary-color);
      text-decoration: none;
      border-bottom: 1px dashed var(--primary-color);
      padding-bottom: 2px;
    }

    .beian-info a:hover {
      border-bottom-style: solid;
    }

    @media (max-width: 576px) {
      .container {
        padding: 20px;
      }

      .github-corner:hover .octo-arm {
        animation: none;
      }

      .github-corner .octo-arm {
        animation: octocat-wave 560ms ease-in-out;
      }
    }

    .error-message {
      color: #e63e00;
      margin-top: 10px;
    }

    .success-message {
      color: #e67e22;
    }

    .nav-tabs .nav-link {
      border-top-left-radius: 6px;
      border-top-right-radius: 6px;
      padding: 8px 16px;
      font-weight: 500;
      color: rgb(150, 80, 50);
    }

    .nav-tabs .nav-link.active {
      background-color: rgba(255, 245, 240, 0.8);
      border-bottom-color: rgba(255, 245, 240, 0.8);
      color: rgb(253, 101, 60);
    }

    .tab-content {
      background-color: rgba(255, 245, 240, 0.8);
      border-radius: 0 0 6px 6px;
      padding: 15px;
      border: 1px solid rgba(253, 101, 60, 0.2);
      border-top: none;
      overflow-x: auto;
      word-wrap: break-word;
      word-break: break-word;
    }

    .ip-record {
      padding: 5px 10px;
      margin-bottom: 5px;
      border-radius: 4px;
      background-color: rgba(255, 255, 255, 0.9);
      border: 1px solid rgba(253, 101, 60, 0.15);
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
    }

    .ip-record:hover {
      background-color: rgba(255, 235, 225, 0.9);
    }

    .ip-address {
      font-family: monospace;
      font-weight: 600;
      min-width: 130px;
      color: rgb(80, 60, 50);
      cursor: pointer;
      position: relative;
      transition: color 0.2s ease;
      display: inline-block;
    }

    .ip-address:hover {
      color: rgb(253, 101, 60);
    }

    .ip-info-details {
      word-wrap: break-word;
      word-break: break-word;
      overflow-wrap: break-word;
    }

    .ip-info-details div {
      margin: 3px 0;
      word-wrap: break-word;
      word-break: break-word;
    }

    .ip-address:after {
      content: '';
      position: absolute;
      left: 100%;  /* 从IP地址的右侧开始定位 */
      top: 0;
      opacity: 0;
      white-space: nowrap;
      font-size: 12px;
      color: rgb(253, 101, 60);
      transition: opacity 0.3s ease;
      font-family: 'Segoe UI', sans-serif;
      font-weight: normal;
    }

    .ip-address.copied:after {
      content: '✓ 已复制';
      opacity: 1;
    }

    .result-summary {
      margin-bottom: 15px;
      padding: 10px;
      background-color: rgba(255, 235, 225, 0.8);
      border-radius: 6px;
    }

    .result-tabs {
      margin-bottom: 20px;
    }

    .geo-info {
      margin: 0 10px;
      font-size: 0.85em;
      flex-grow: 1;
      text-align: center;
    }

    .geo-country {
      color: rgb(230, 90, 50);
      font-weight: 500;
      padding: 2px 6px;
      background-color: rgba(255, 245, 240, 0.8);
      border-radius: 4px;
      display: inline-block;
    }

    .geo-as {
      color: rgb(253, 101, 60);
      padding: 2px 6px;
      background-color: rgba(255, 245, 240, 0.8);
      border-radius: 4px;
      margin-left: 5px;
      display: inline-block;
    }

    .geo-blocked {
      color: #ffffff;
      background-color: #dc3545;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 600;
      display: inline-block;
      animation: pulse-red 2s infinite;
    }

    @keyframes pulse-red {
      0% { box-shadow: 0 0 0 0 rgba(220, 53, 69, 0.7); }
      70% { box-shadow: 0 0 0 10px rgba(220, 53, 69, 0); }
      100% { box-shadow: 0 0 0 0 rgba(220, 53, 69, 0); }
    }

    .geo-loading {
      color: rgb(150, 100, 80);
      font-style: italic;
    }

    .ttl-info {
      min-width: 80px;
      text-align: right;
      color: rgb(180, 90, 60);
    }

    .copy-link {
      color: rgb(253, 101, 60);
      text-decoration: none;
      border-bottom: 1px dashed rgb(253, 101, 60);
      padding-bottom: 2px;
      cursor: pointer;
      position: relative;
    }

    .copy-link:hover {
      border-bottom-style: solid;
    }

    .copy-link:after {
      content: '';
      position: absolute;
      top: 0;
      right: -65px;
      opacity: 0;
      white-space: nowrap;
      color: rgb(253, 101, 60);
      font-size: 12px;
      transition: opacity 0.3s ease;
    }

    .copy-link.copied:after {
      content: '✓ 已复制';
      opacity: 1;
    }

    .github-corner svg {
      fill: rgb(255, 255, 255);
      color: rgb(251,152,30);
      position: absolute;
      top: 0;
      right: 0;
      border: 0;
      width: 80px;
      height: 80px;
    }

    .github-corner:hover .octo-arm {
      animation: octocat-wave 560ms ease-in-out;
    }

    /* 添加章鱼猫挥手动画关键帧 */
    @keyframes octocat-wave {
      0%, 100% { transform: rotate(0); }
      20%, 60% { transform: rotate(-25deg); }
      40%, 80% { transform: rotate(10deg); }
    }

    @media (max-width: 576px) {
      .container {
        padding: 20px;
      }

      .github-corner:hover .octo-arm {
        animation: none;
      }

      .github-corner .octo-arm {
        animation: octocat-wave 560ms ease-in-out;
      }

      /* 手机端优化 */
      .tab-content {
        padding: 10px;
        overflow-x: auto;
      }

      .ip-record {
        padding: 8px 10px;
        flex-wrap: wrap;
        gap: 5px;
      }

      .ip-address {
        min-width: auto;
        max-width: 100%;
        word-break: break-all;
        overflow-wrap: break-word;
      }

      .geo-info {
        margin: 5px 0;
        font-size: 0.8em;
        text-align: left;
        flex-grow: 0;
        width: 100%;
      }

      .ttl-info {
        font-size: 0.8em;
      }

      .nav-tabs {
        flex-wrap: wrap;
      }

      .nav-tabs .nav-link {
        font-size: 0.85em;
        padding: 8px 10px;
      }

      /* 防止文字溢出 */
      .tab-pane {
        overflow-x: auto;
        word-wrap: break-word;
        word-break: break-word;
      }

      pre, .pre-scrollable {
        font-size: 0.75em;
        overflow-x: auto;
        max-width: 100%;
        word-wrap: break-word;
        white-space: pre-wrap;
      }

      .badge {
        font-size: 0.7em;
        padding: 3px 6px;
      }

      /* 网速显示优化 */
      .display-4 {
        font-size: 2rem;
      }

      h3 {
        font-size: 1rem;
      }

      /* 表格优化 */
      table {
        font-size: 0.85em;
      }

      td {
        padding: 5px;
        word-break: break-all;
      }

      td:first-child {
        width: 35%;
      }
    }

    /* 拦截记录 / 白名单 */
    .block-stats {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin: 16px 20px 4px;
    }

    .block-stat {
      flex: 1 1 110px;
      background: rgba(255, 242, 235, 0.8);
      border: 1px solid rgba(253, 101, 60, 0.18);
      border-radius: 10px;
      padding: 10px 14px;
    }

    .block-stat b {
      display: block;
      font-size: 1.25rem;
      line-height: 1.3;
      color: rgb(253, 101, 60);
    }

    .block-stat span {
      font-size: 0.78rem;
      color: rgb(120, 95, 82);
    }

    .block-sub {
      margin: 18px 20px 8px;
      font-size: 0.92rem;
      font-weight: 600;
      color: rgb(70, 50, 40);
    }

    .block-title {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }

    .block-refresh {
      font-weight: 400;
      font-size: 0.78rem;
      color: rgb(253, 101, 60);
      cursor: pointer;
    }

    .block-list {
      margin: 0 20px 16px;
      max-height: 320px;
      overflow: auto;
      border-radius: 10px;
      border: 1px solid rgba(253, 101, 60, 0.15);
      background: rgba(255, 255, 255, 0.75);
    }

    .block-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      font-size: 0.86rem;
      color: rgb(70, 50, 40);
      border-bottom: 1px solid rgba(253, 101, 60, 0.1);
    }

    .block-row:last-child {
      border-bottom: none;
    }

    .block-row .dom {
      word-break: break-all;
    }

    .block-row .time {
      white-space: nowrap;
      font-size: 0.78rem;
      color: rgb(150, 125, 112);
    }

    .block-form {
      display: flex;
      gap: 8px;
      margin: 0 20px 12px;
    }

    .block-form input {
      flex: 1;
      min-width: 0;
      padding: 9px 12px;
      font-size: 0.9rem;
      border-radius: 8px;
      border: 1px solid rgba(253, 101, 60, 0.3);
      background: rgba(255, 255, 255, 0.9);
      outline: none;
    }

    .block-form input:focus {
      border-color: rgb(253, 101, 60);
    }

    .block-form button {
      border: none;
      border-radius: 8px;
      padding: 9px 18px;
      font-size: 0.9rem;
      color: #fff;
      background: rgb(253, 101, 60);
      cursor: pointer;
      transition: background 0.2s ease;
    }

    .block-form button:hover {
      background: rgb(230, 90, 50);
    }

    .block-tags {
      margin: 0 20px 20px;
    }

    .block-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 0 6px 6px 0;
      padding: 4px 10px;
      font-size: 0.82rem;
      border-radius: 999px;
      color: rgb(70, 50, 40);
      background: rgba(255, 242, 235, 0.9);
      border: 1px solid rgba(253, 101, 60, 0.2);
    }

    .block-tag i {
      font-style: normal;
      font-weight: 700;
      color: rgb(253, 101, 60);
      cursor: pointer;
    }

    .block-empty {
      display: block;
      padding: 14px 12px;
      font-size: 0.85rem;
      color: rgb(150, 125, 112);
    }
  </style>
</head>

<body>
  <a href="https://github.com/bayueqi/ZQ-CfDoh" target="_blank" class="github-corner" aria-label="View source on Github">
    <svg viewBox="0 0 250 250" aria-hidden="true">
      <path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
      <path
        d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2"
        fill="currentColor" style="transform-origin: 130px 106px;" class="octo-arm"></path>
      <path
        d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z"
        fill="currentColor" class="octo-body"></path>
    </svg>
  </a>
  <div class="container">
    <h1 class="text-center mb-4">ZQ-CfDoh</h1>

    <!-- DNS 查询折叠区：展开后显示查询设置 / 解析结果 / 我的IP信息 -->
    <div class="collapse-card">
      <button type="button" class="collapse-toggle" data-target="dnsSection" aria-expanded="false">
        <span class="collapse-title">DNS</span>
        <svg class="collapse-icon" viewBox="0 0 24 24" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div class="collapse-content" id="dnsSection">
        <div class="collapse-inner">

          <div class="card">
            <div class="card-header">DNS 查询设置</div>
      <div class="card-body">
        <form id="resolveForm">
          <div class="mb-3">
            <label for="dohSelect" class="form-label">选择 DoH 地址:</label>
            <select id="dohSelect" class="form-select">
              <option value="current" selected id="currentDoHOption">自动 (当前站点)</option>
              <option value="https://dns.alidns.com/resolve">https://dns.alidns.com/resolve (阿里)</option>
              <option value="https://sm2.doh.pub/dns-query">https://sm2.doh.pub/dns-query (腾讯)</option>
              <option value="https://doh.360.cn/resolve">https://doh.360.cn/resolve (360)</option>
              <option value="https://cloudflare-dns.com/dns-query">https://cloudflare-dns.com/dns-query (Cloudflare)</option>
              <option value="https://dns.google/resolve">https://dns.google/resolve (谷歌)</option>
              <option value="https://dns.adguard-dns.com/resolve">https://dns.adguard-dns.com/resolve (AdGuard)</option>
              <option value="https://dns.sb/dns-query">https://dns.sb/dns-query (DNS.SB)</option>
              <option value="https://zero.dns0.eu/">https://zero.dns0.eu (dns0.eu)</option>
              <option value="https://dns.nextdns.io">	https://dns.nextdns.io (NextDNS)</option>
              <option value="https://dns.rabbitdns.org/dns-query">https://dns.rabbitdns.org/dns-query (Rabbit DNS)</option>
              <option value="https://basic.rethinkdns.com/">https://basic.rethinkdns.com (RethinkDNS)</option>
              <option value="https://v.recipes/dns-query">https://v.recipes/dns-query (v.recipes DNS)</option>
              <option value="custom">自定义...</option>
            </select>
          </div>
          <div id="customDoHContainer" class="mb-3" style="display:none;">
            <label for="customDoH" class="form-label">输入自定义 DoH 地址:</label>
            <input type="text" id="customDoH" class="form-control" placeholder="https://example.com/dns-query">
          </div>
          <div class="mb-3">
            <label for="domain" class="form-label">待解析域名:</label>
            <div class="input-group">
              <input type="text" id="domain" class="form-control" value="www.google.com"
                placeholder="输入域名，如 example.com">
              <button type="button" class="btn btn-outline-secondary" id="clearBtn">清除</button>
            </div>
          </div>
          <div class="d-flex gap-2">
            <button type="submit" class="btn btn-primary flex-grow-1">解析</button>
            <button type="button" class="btn btn-outline-primary" id="getJsonBtn">Get Json</button>
          </div>
        </form>

        <div class="result-divider">
          <span>解析结果</span>
          <button class="btn btn-sm btn-outline-secondary" id="copyBtn" style="display: none;">复制结果</button>
        </div>
        <div id="loading" class="loading">
          <div class="loading-spinner"></div>
          <p>正在查询中，请稍候...</p>
        </div>

        <!-- 结果展示区，包含选项卡 -->
        <div id="resultContainer" style="display: none;">
          <ul class="nav nav-tabs result-tabs" id="resultTabs" role="tablist">
            <li class="nav-item" role="presentation">
              <button class="nav-link active" id="ipv4-tab" data-bs-toggle="tab" data-bs-target="#ipv4" type="button"
                role="tab">IPv4 地址</button>
            </li>
            <li class="nav-item" role="presentation">
              <button class="nav-link" id="ipv6-tab" data-bs-toggle="tab" data-bs-target="#ipv6" type="button"
                role="tab">IPv6 地址</button>
            </li>
            <li class="nav-item" role="presentation">
              <button class="nav-link" id="ns-tab" data-bs-toggle="tab" data-bs-target="#ns" type="button" role="tab">NS
                记录</button>
            </li>
            <li class="nav-item" role="presentation">
              <button class="nav-link" id="raw-tab" data-bs-toggle="tab" data-bs-target="#raw" type="button"
                role="tab">原始数据</button>
            </li>
            <li class="nav-item" role="presentation">
              <button class="nav-link" id="ipinfo-tab" data-bs-toggle="tab" data-bs-target="#ipinfo" type="button"
                role="tab">IP 信息</button>
            </li>
          </ul>
          <div class="tab-content" id="resultTabContent">
            <div class="tab-pane fade show active" id="ipv4" role="tabpanel" aria-labelledby="ipv4-tab">
              <div class="result-summary" id="ipv4Summary"></div>
              <div id="ipv4Records"></div>
            </div>
            <div class="tab-pane fade" id="ipv6" role="tabpanel" aria-labelledby="ipv6-tab">
              <div class="result-summary" id="ipv6Summary"></div>
              <div id="ipv6Records"></div>
            </div>
            <div class="tab-pane fade" id="ns" role="tabpanel" aria-labelledby="ns-tab">
              <div class="result-summary" id="nsSummary"></div>
              <div id="nsRecords"></div>
            </div>
            <div class="tab-pane fade" id="raw" role="tabpanel" aria-labelledby="raw-tab">
              <pre id="result">等待查询...</pre>
            </div>
            <div class="tab-pane fade" id="ipinfo" role="tabpanel" aria-labelledby="ipinfo-tab">
              <div class="result-summary" id="ipinfoSummary"></div>
              <div id="ipinfoRecords"></div>
            </div>
          </div>
        </div>

        <!-- 错误信息区域 -->
        <div id="errorContainer" style="display: none;">
          <pre id="errorMessage" class="error-message"></pre>
        </div>
      </div>
    </div>

          <div class="card">
            <div class="card-header">我的IP信息</div>
            <div class="card-body">
              <div id="myIpInfo">
                <div class="text-center text-muted" id="myIpLoading">加载中...</div>
                <div id="myIpContent" style="display: none;"></div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div><!-- /DNS 查询折叠区 -->

    <!-- 网络测速折叠区 -->
    <div class="collapse-card">
      <button type="button" class="collapse-toggle" data-target="speedSection" aria-expanded="false">
        <span class="collapse-title">测速</span>
        <svg class="collapse-icon" viewBox="0 0 24 24" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div class="collapse-content" id="speedSection">
        <div class="collapse-inner">
          <iframe data-src="https://www.speedtest.cn/" style="width: 100%; height: 600px; border: none; border-radius: 6px; display: block;"></iframe>
        </div>
      </div>
    </div>

    <!-- 广告拦截折叠区 -->
    <div class="collapse-card">
      <button type="button" class="collapse-toggle" data-target="blockSection" aria-expanded="false">
        <span class="collapse-title">拦截</span>
        <svg class="collapse-icon" viewBox="0 0 24 24" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div class="collapse-content" id="blockSection">
        <div class="collapse-inner">
          <div class="block-stats" id="blockStats"></div>
          <div class="block-sub block-title"><span id="ruleSub">拦截名单</span><span class="block-refresh" id="refreshBtn">刷新名单</span></div>
          <div class="block-form">
            <input id="ruleInput" type="text" placeholder="ads.example.com" autocomplete="off" />
            <button id="ruleBtn" type="button">拦截</button>
          </div>
          <div class="block-tags" id="ruleTags"></div>
          <div class="block-sub">白名单（命中即放行）</div>
          <div class="block-form">
            <input id="allowInput" type="text" placeholder="example.com" autocomplete="off" />
            <button id="allowBtn" type="button">放行</button>
          </div>
          <div class="block-tags" id="allowTags"></div>
          <div class="block-sub">最近拦截</div>
          <div class="block-list" id="blockHits">
            <div class="block-empty">展开后加载...</div>
          </div>
        </div>
      </div>
    </div>

    <div class="beian-info">
      <p><strong>DoH端点：<span id="dohUrlDisplay" class="copy-link" title="点击复制">https://<span
              id="currentDomain">...</span>/${DoHPath}</span></strong><br>基于 Cloudflare Workers 上游 ${DoH} 的 DoH 
        解析与测速服务</p>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    // 获取当前页面的 URL 和主机名
    const currentUrl = window.location.href;
    const currentHost = window.location.host;
    const currentProtocol = window.location.protocol;
    const currentDoHPath = '${DoHPath}';
    const currentDoHUrl = currentProtocol + '//' + currentHost + '/' + currentDoHPath;

    // 记录当前使用的 DoH 地址
    let activeDoHUrl = currentDoHUrl;

    // 阻断IP列表
    const 阻断IPv4 = [
      '104.21.16.1',
      '104.21.32.1',
      '104.21.48.1',
      '104.21.64.1',
      '104.21.80.1',
      '104.21.96.1',
      '104.21.112.1'
    ];

    const 阻断IPv6 = [
      '2606:4700:3030::6815:1001',
      '2606:4700:3030::6815:3001',
      '2606:4700:3030::6815:7001',
      '2606:4700:3030::6815:5001'
    ];

    // 检查IP是否在阻断列表中
    function isBlockedIP(ip) {
      return 阻断IPv4.includes(ip) || 阻断IPv6.includes(ip);
    }

    // 显示当前正在使用的 DoH 服务
    function updateActiveDoHDisplay() {
      const dohSelect = document.getElementById('dohSelect');
      if (dohSelect.value === 'current') {
        activeDoHUrl = currentDoHUrl;
      }
    }

    // 初始更新
    updateActiveDoHDisplay();

    // 当选择自定义时显示输入框
    document.getElementById('dohSelect').addEventListener('change', function () {
      const customContainer = document.getElementById('customDoHContainer');
      customContainer.style.display = (this.value === 'custom') ? 'block' : 'none';

      if (this.value === 'current') {
        activeDoHUrl = currentDoHUrl;
      } else if (this.value !== 'custom') {
        activeDoHUrl = this.value;
      }
    });

    // 清除按钮功能
    document.getElementById('clearBtn').addEventListener('click', function () {
      document.getElementById('domain').value = '';
      document.getElementById('domain').focus();
    });

    // 复制结果功能
    document.getElementById('copyBtn').addEventListener('click', function () {
      const resultText = document.getElementById('result').textContent;
      navigator.clipboard.writeText(resultText).then(function () {
        const originalText = this.textContent;
        this.textContent = '已复制';
        setTimeout(() => {
          this.textContent = originalText;
        }, 2000);
      }.bind(this)).catch(function (err) {
        console.error('无法复制文本: ', err);
      });
    });

    // 格式化 TTL
    function formatTTL(seconds) {
      if (seconds < 60) return seconds + '秒';
      if (seconds < 3600) return Math.floor(seconds / 60) + '分钟';
      if (seconds < 86400) return Math.floor(seconds / 3600) + '小时';
      return Math.floor(seconds / 86400) + '天';
    }

    // 查询 IP 地理位置信息 - 使用我们自己的代理API而非直接访问HTTP地址
    async function queryIpGeoInfo(ip) {
      try {
        // 改为使用我们自己的代理接口
        const response = await fetch(\`./ip-info?ip=\${ip}\`);
            if (!response.ok) {
              throw new Error(\`HTTP 错误: \${response.status}\`);
            }
            return await response.json();
          } catch (error) {
            console.error('IP 地理位置查询失败:', error);
            return null;
          }
        }
        
        // 处理点击复制功能
        function handleCopyClick(element, textToCopy) {
          navigator.clipboard.writeText(textToCopy).then(function() {
            // 添加复制成功的反馈
            element.classList.add('copied');
            
            // 2秒后移除复制成功效果
            setTimeout(() => {
              element.classList.remove('copied');
            }, 2000);
          }).catch(function(err) {
            console.error('复制失败:', err);
          });
        }
        
        // 显示记录
        function displayRecords(data, inputDomain) {
          document.getElementById('resultContainer').style.display = 'block';
          document.getElementById('errorContainer').style.display = 'none';
          document.getElementById('result').textContent = JSON.stringify(data, null, 2);
          
          // IPv4 记录
          const ipv4Records = data.ipv4?.records || [];
          const ipv4Container = document.getElementById('ipv4Records');
          ipv4Container.innerHTML = '';
          
          if (ipv4Records.length === 0) {
            document.getElementById('ipv4Summary').innerHTML = \`<strong>未找到 IPv4 记录</strong>\`;
          } else {
            document.getElementById('ipv4Summary').innerHTML = \`<strong>找到 \${ipv4Records.length} 条 IPv4 记录</strong>\`;
            
            ipv4Records.forEach(record => {
              const recordDiv = document.createElement('div');
              recordDiv.className = 'ip-record';
              
              if (record.type === 5) { // CNAME 记录
                recordDiv.innerHTML = \`
                  <div class="d-flex justify-content-between align-items-center">
                    <span class="ip-address" data-copy="\${record.data}">\${record.data}</span>
                    <span class="badge bg-success">CNAME</span>
                    <span class="text-muted ttl-info">TTL: \${formatTTL(record.TTL)}</span>
                  </div>
                \`;
                ipv4Container.appendChild(recordDiv);
                
                // 添加点击事件
                const copyElem = recordDiv.querySelector('.ip-address');
                copyElem.addEventListener('click', function() {
                  handleCopyClick(this, this.getAttribute('data-copy'));
                });
                
              } else if (record.type === 1) {  // A记录
                recordDiv.innerHTML = \`
                  <div class="d-flex justify-content-between align-items-center">
                    <span class="ip-address" data-copy="\${record.data}">\${record.data}</span>
                    <span class="geo-info geo-loading">正在获取位置信息...</span>
                    <span class="text-muted ttl-info">TTL: \${formatTTL(record.TTL)}</span>
                  </div>
                \`;
                ipv4Container.appendChild(recordDiv);
                
                // 添加点击事件
                const copyElem = recordDiv.querySelector('.ip-address');
                copyElem.addEventListener('click', function() {
                  handleCopyClick(this, this.getAttribute('data-copy'));
                });
                
                // 添加地理位置信息
                const geoInfoSpan = recordDiv.querySelector('.geo-info');
                
                // 检查是否为阻断IP
                if (isBlockedIP(record.data)) {
                  // 异步查询 IP 地理位置信息获取AS信息
                  queryIpGeoInfo(record.data).then(geoData => {
                    geoInfoSpan.innerHTML = '';
                    geoInfoSpan.classList.remove('geo-loading');
                    
                    // 显示阻断IP标识（替代国家信息）
                    const blockedSpan = document.createElement('span');
                    blockedSpan.className = 'geo-blocked';
                    blockedSpan.textContent = '阻断IP';
                    geoInfoSpan.appendChild(blockedSpan);
                    
                    // 如果有AS信息，正常显示
                    if (geoData && geoData.status === 'success' && geoData.as) {
                      const asSpan = document.createElement('span');
                      asSpan.className = 'geo-as';
                      asSpan.textContent = geoData.as;
                      geoInfoSpan.appendChild(asSpan);
                    }
                  }).catch(() => {
                    // 查询失败时仍显示阻断IP标识
                    geoInfoSpan.innerHTML = '';
                    geoInfoSpan.classList.remove('geo-loading');
                    
                    const blockedSpan = document.createElement('span');
                    blockedSpan.className = 'geo-blocked';
                    blockedSpan.textContent = '阻断IP';
                    geoInfoSpan.appendChild(blockedSpan);
                  });
                } else {
                  // 异步查询 IP 地理位置信息
                  queryIpGeoInfo(record.data).then(geoData => {
                    if (geoData && geoData.status === 'success') {
                      // 更新为实际的地理位置信息
                      geoInfoSpan.innerHTML = '';
                      geoInfoSpan.classList.remove('geo-loading');
                      
                      // 添加国家信息
                      const countrySpan = document.createElement('span');
                      countrySpan.className = 'geo-country';
                      countrySpan.textContent = geoData.country || '未知国家';
                      geoInfoSpan.appendChild(countrySpan);
                      
                      // 添加 AS 信息
                      const asSpan = document.createElement('span');
                      asSpan.className = 'geo-as';
                      asSpan.textContent = geoData.as || '未知 AS';
                      geoInfoSpan.appendChild(asSpan);
                    } else {
                      // 查询失败或无结果
                      geoInfoSpan.textContent = '位置信息获取失败';
                    }
                  });
                }
              }
            });
          }
          
          // IPv6 记录
          const ipv6Records = data.ipv6?.records || [];
          const ipv6Container = document.getElementById('ipv6Records');
          ipv6Container.innerHTML = '';
          
          if (ipv6Records.length === 0) {
            document.getElementById('ipv6Summary').innerHTML = \`<strong>未找到 IPv6 记录</strong>\`;
          } else {
            document.getElementById('ipv6Summary').innerHTML = \`<strong>找到 \${ipv6Records.length} 条 IPv6 记录</strong>\`;
            
            ipv6Records.forEach(record => {
              const recordDiv = document.createElement('div');
              recordDiv.className = 'ip-record';
              
              if (record.type === 5) { // CNAME 记录
                recordDiv.innerHTML = \`
                  <div class="d-flex justify-content-between align-items-center">
                    <span class="ip-address" data-copy="\${record.data}">\${record.data}</span>
                    <span class="badge bg-success">CNAME</span>
                    <span class="text-muted ttl-info">TTL: \${formatTTL(record.TTL)}</span>
                  </div>
                \`;
                ipv6Container.appendChild(recordDiv);
                
                // 添加点击事件
                const copyElem = recordDiv.querySelector('.ip-address');
                copyElem.addEventListener('click', function() {
                  handleCopyClick(this, this.getAttribute('data-copy'));
                });
                
              } else if (record.type === 28) {  // AAAA记录
                recordDiv.innerHTML = \`
                  <div class="d-flex justify-content-between align-items-center">
                    <span class="ip-address" data-copy="\${record.data}">\${record.data}</span>
                    <span class="geo-info geo-loading">正在获取位置信息...</span>
                    <span class="text-muted ttl-info">TTL: \${formatTTL(record.TTL)}</span>
                  </div>
                \`;
                ipv6Container.appendChild(recordDiv);
                
                // 添加点击事件
                const copyElem = recordDiv.querySelector('.ip-address');
                copyElem.addEventListener('click', function() {
                  handleCopyClick(this, this.getAttribute('data-copy'));
                });
                
                // 添加地理位置信息
                const geoInfoSpan = recordDiv.querySelector('.geo-info');
                
                // 检查是否为阻断IP
                if (isBlockedIP(record.data)) {
                  // 异步查询 IP 地理位置信息获取AS信息
                  queryIpGeoInfo(record.data).then(geoData => {
                    geoInfoSpan.innerHTML = '';
                    geoInfoSpan.classList.remove('geo-loading');
                    
                    // 显示阻断IP标识（替代国家信息）
                    const blockedSpan = document.createElement('span');
                    blockedSpan.className = 'geo-blocked';
                    blockedSpan.textContent = '阻断IP';
                    geoInfoSpan.appendChild(blockedSpan);
                    
                    // 如果有AS信息，正常显示
                    if (geoData && geoData.status === 'success' && geoData.as) {
                      const asSpan = document.createElement('span');
                      asSpan.className = 'geo-as';
                      asSpan.textContent = geoData.as;
                      geoInfoSpan.appendChild(asSpan);
                    }
                  }).catch(() => {
                    // 查询失败时仍显示阻断IP标识
                    geoInfoSpan.innerHTML = '';
                    geoInfoSpan.classList.remove('geo-loading');
                    
                    const blockedSpan = document.createElement('span');
                    blockedSpan.className = 'geo-blocked';
                    blockedSpan.textContent = '阻断IP';
                    geoInfoSpan.appendChild(blockedSpan);
                  });
                } else {
                  // 异步查询 IP 地理位置信息
                  queryIpGeoInfo(record.data).then(geoData => {
                    if (geoData && geoData.status === 'success') {
                      // 更新为实际的地理位置信息
                      geoInfoSpan.innerHTML = '';
                      geoInfoSpan.classList.remove('geo-loading');
                      
                      // 添加国家信息
                      const countrySpan = document.createElement('span');
                      countrySpan.className = 'geo-country';
                      countrySpan.textContent = geoData.country || '未知国家';
                      geoInfoSpan.appendChild(countrySpan);
                      
                      // 添加 AS 信息
                      const asSpan = document.createElement('span');
                      asSpan.className = 'geo-as';
                      asSpan.textContent = geoData.as || '未知 AS';
                      geoInfoSpan.appendChild(asSpan);
                    } else {
                      // 查询失败或无结果
                      geoInfoSpan.textContent = '位置信息获取失败';
                    }
                  });
                }
              }
            });
          }
          
          // NS 记录
          const nsRecords = data.ns?.records || [];
          const nsContainer = document.getElementById('nsRecords');
          nsContainer.innerHTML = '';
          
          if (nsRecords.length === 0) {
            document.getElementById('nsSummary').innerHTML = \`<strong>未找到 NS 记录</strong>\`;
          } else {
            document.getElementById('nsSummary').innerHTML = \`<strong>找到 \${nsRecords.length} 条名称服务器记录</strong>\`;
            
            nsRecords.forEach(record => {
              const recordDiv = document.createElement('div');
              recordDiv.className = 'ip-record';
              
              // 不同类型的记录使用不同的显示方式
              if (record.type === 2) {  // NS 记录
                recordDiv.innerHTML = \`
                  <div class="d-flex justify-content-between align-items-center">
                    <span class="ip-address" data-copy="\${record.data}">\${record.data}</span>
                    <span class="badge bg-info">NS</span>
                    <span class="text-muted ttl-info">TTL: \${formatTTL(record.TTL)}</span>
                  </div>
                \`;
                
                // 添加点击事件
                const copyElem = recordDiv.querySelector('.ip-address');
                copyElem.addEventListener('click', function() {
                  handleCopyClick(this, this.getAttribute('data-copy'));
                });
                
              } else if (record.type === 6) {  // SOA 记录
                // SOA 记录格式: primary_ns admin_email serial refresh retry expire minimum
                const soaParts = record.data.split(' ');
                let adminEmail = soaParts[1].replace('.', '@');
                if (adminEmail.endsWith('.')) adminEmail = adminEmail.slice(0, -1);
                recordDiv.innerHTML = \`
                  <div class="d-flex justify-content-between align-items-center mb-2">
                    <span class="ip-address" data-copy="\${record.name}">\${record.name}</span>
                    <span class="badge bg-warning">SOA</span>
                    <span class="text-muted ttl-info">TTL: \${formatTTL(record.TTL)}</span>
                  </div>
                  <div class="ps-3 small">
                    <div><strong>主 NS:</strong> <span class="ip-address" data-copy="\${soaParts[0]}">\${soaParts[0]}</span></div>
                    <div><strong>管理邮箱:</strong> <span class="ip-address" data-copy="\${adminEmail}">\${adminEmail}</span></div>
                    <div><strong>序列号:</strong> \${soaParts[2]}</div>
                    <div><strong>刷新间隔:</strong> \${formatTTL(soaParts[3])}</div>
                    <div><strong>重试间隔:</strong> \${formatTTL(soaParts[4])}</div>
                    <div><strong>过期时间:</strong> \${formatTTL(soaParts[5])}</div>
                    <div><strong>最小 TTL:</strong> \${formatTTL(soaParts[6])}</div>
                  </div>
                \`;
                
                // 添加点击事件，为SOA记录中的所有可点击元素添加事件
                const copyElems = recordDiv.querySelectorAll('.ip-address');
                copyElems.forEach(elem => {
                  elem.addEventListener('click', function() {
                    handleCopyClick(this, this.getAttribute('data-copy'));
                  });
                });
                
              } else {
                // 其他类型的记录
                recordDiv.innerHTML = \`
                  <div class="d-flex justify-content-between align-items-center">
                    <span class="ip-address" data-copy="\${record.data}">\${record.data}</span>
                    <span class="badge bg-secondary">类型: \${record.type}</span>
                    <span class="text-muted ttl-info">TTL: \${formatTTL(record.TTL)}</span>
                  </div>
                \`;
                
                // 添加点击事件
                const copyElem = recordDiv.querySelector('.ip-address');
                copyElem.addEventListener('click', function() {
                  handleCopyClick(this, this.getAttribute('data-copy'));
                });
              }
              
              nsContainer.appendChild(recordDiv);
            });
          }
          
          // IP 信息 - 收集所有 IP 记录并显示详细信息
          const allIps = [];
          ipv4Records.forEach(r => {
            if (r.type === 1) allIps.push(r.data);
          });
          ipv6Records.forEach(r => {
            if (r.type === 28) allIps.push(r.data);
          });
          
          // 检查输入的是不是IP地址，如果是就直接加进去
          if (inputDomain) {
            const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
            const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$|^(?:[0-9a-fA-F]{1,4}:){1,7}:|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}$|^(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}$|^(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}$|^:(?::[0-9a-fA-F]{1,4}){1,7}$/;
            
            if (ipv4Regex.test(inputDomain) || ipv6Regex.test(inputDomain)) {
              if (!allIps.includes(inputDomain)) {
                allIps.push(inputDomain);
              }
            }
          }
          
          const ipinfoContainer = document.getElementById('ipinfoRecords');
          ipinfoContainer.innerHTML = '';
          
          if (allIps.length === 0) {
            document.getElementById('ipinfoSummary').innerHTML = \`<strong>未找到 IP 记录</strong>\`;
          } else {
            document.getElementById('ipinfoSummary').innerHTML = \`<strong>找到 \${allIps.length} 个 IP 地址</strong>\`;
            
            allIps.forEach(ip => {
              const recordDiv = document.createElement('div');
              recordDiv.className = 'ip-record';
              
              recordDiv.innerHTML = \`
                <div class="d-flex justify-content-between align-items-center mb-2">
                  <span class="ip-address" data-copy="\${ip}">\${ip}</span>
                  <span class="geo-info geo-loading">正在获取信息...</span>
                </div>
                <div class="ip-info-details ps-3 small" style="display: none;"></div>
              \`;
              
              ipinfoContainer.appendChild(recordDiv);
              
              // 添加点击事件
              const copyElem = recordDiv.querySelector('.ip-address');
              copyElem.addEventListener('click', function() {
                handleCopyClick(this, this.getAttribute('data-copy'));
              });
              
              // 查询 IP 信息
              queryIpGeoInfo(ip).then(geoData => {
                const geoInfoSpan = recordDiv.querySelector('.geo-info');
                const detailsDiv = recordDiv.querySelector('.ip-info-details');
                
                geoInfoSpan.classList.remove('geo-loading');
                
                if (geoData && geoData.status === 'success') {
                  geoInfoSpan.textContent = geoData.country || '未知国家';
                  
                  let detailsHtml = '';
                  if (geoData.continent) detailsHtml += \`<div><strong>大洲:</strong> \${geoData.continent}</div>\`;
                  if (geoData.country) detailsHtml += \`<div><strong>国家:</strong> \${geoData.country} \${geoData.countryCode ? '(' + geoData.countryCode + ')' : ''}</div>\`;
                  if (geoData.region) detailsHtml += \`<div><strong>地区:</strong> \${geoData.region}</div>\`;
                  if (geoData.city) detailsHtml += \`<div><strong>城市:</strong> \${geoData.city}</div>\`;
                  if (geoData.lat && geoData.lon) detailsHtml += \`<div><strong>坐标:</strong> \${geoData.lat}, \${geoData.lon}</div>\`;
                  if (geoData.timezone) detailsHtml += \`<div><strong>时区:</strong> \${geoData.timezone}</div>\`;
                  if (geoData.isp) detailsHtml += \`<div><strong>ISP:</strong> \${geoData.isp}</div>\`;
                  if (geoData.org) detailsHtml += \`<div><strong>组织:</strong> \${geoData.org}</div>\`;
                  if (geoData.as) detailsHtml += \`<div><strong>AS:</strong> \${geoData.as}</div>\`;
                  if (geoData.query) detailsHtml += \`<div><strong>IP:</strong> \${geoData.query}</div>\`;
                  
                  detailsDiv.innerHTML = detailsHtml;
                  detailsDiv.style.display = 'block';
                } else {
                  geoInfoSpan.textContent = '获取失败';
                }
              }).catch(() => {
                const geoInfoSpan = recordDiv.querySelector('.geo-info');
                geoInfoSpan.classList.remove('geo-loading');
                geoInfoSpan.textContent = '获取失败';
              });
            });
          }
          
          // 当用户切换到IPv4或IPv6选项卡时，确保显示已加载的地理位置信息
          document.getElementById('ipv4-tab').addEventListener('click', function() {
            // 如果还有加载中的地理位置信息，可以在这里处理
          });
          
          document.getElementById('ipv6-tab').addEventListener('click', function() {
            // 如果还有加载中的地理位置信息，可以在这里处理
          });
          
          // 显示复制按钮
          document.getElementById('copyBtn').style.display = 'block';
        }
        
        // 显示错误
        function displayError(message) {
          document.getElementById('resultContainer').style.display = 'none';
          document.getElementById('errorContainer').style.display = 'block';
          document.getElementById('errorMessage').textContent = message;
          document.getElementById('copyBtn').style.display = 'none';
        }
        
        // 表单提交后发起 DNS 查询请求
        document.getElementById('resolveForm').addEventListener('submit', async function(e) {
          e.preventDefault();
          const dohSelect = document.getElementById('dohSelect').value;
          let doh;
          
          if(dohSelect === 'current') {
            doh = currentDoHUrl;
          } else if(dohSelect === 'custom') {
            doh = document.getElementById('customDoH').value;
            if (!doh) {
              alert('请输入自定义 DoH 地址');
              return;
            }
          } else {
            doh = dohSelect;
          }
          
          const domain = document.getElementById('domain').value;
          if (!domain) {
            alert('请输入需要解析的域名');
            return;
          }
          
          // 显示加载状态
          document.getElementById('loading').style.display = 'block';
          document.getElementById('resultContainer').style.display = 'none';
          document.getElementById('errorContainer').style.display = 'none';
          document.getElementById('copyBtn').style.display = 'none';
          
          try {
            // 发起查询，参数采用 GET 请求方式，type=all 表示同时查询 A 和 AAAA
            const response = await fetch(\`?doh=\${encodeURIComponent(doh)}&domain=\${encodeURIComponent(domain)}&type=all\`);
            
            if (!response.ok) {
              throw new Error(\`HTTP 错误: \${response.status}\`);
            }
            
            const json = await response.json();
            
            // 检查响应是否包含错误
            if (json.error) {
              displayError(json.error);
            } else {
              displayRecords(json, domain);
            }
          } catch (error) {
            displayError('查询失败: ' + error.message);
          } finally {
            // 隐藏加载状态
            document.getElementById('loading').style.display = 'none';
          }
        });
        
        // 页面加载完成后执行
        document.addEventListener('DOMContentLoaded', function() {
          // 使用本地存储记住最后使用的域名
          const lastDomain = localStorage.getItem('lastDomain');
          if (lastDomain) {
            document.getElementById('domain').value = lastDomain;
          }
          
          // 监听域名输入变化并保存
          document.getElementById('domain').addEventListener('input', function() {
            localStorage.setItem('lastDomain', this.value);
          });

          // 更新显示当前域名
          document.getElementById('currentDomain').textContent = currentHost;
          
          // 更新DoH下拉选择框的自动选项，显示完整URL
          const currentDoHOption = document.getElementById('currentDoHOption');
          if (currentDoHOption) {
            currentDoHOption.textContent = currentDoHUrl + ' (当前站点)';
          }
          
          // 设置DoH链接复制功能
          const dohUrlDisplay = document.getElementById('dohUrlDisplay');
          if (dohUrlDisplay) {
            dohUrlDisplay.addEventListener('click', function() {
              const textToCopy = currentProtocol + '//' + currentHost + '/' + currentDoHPath;
              navigator.clipboard.writeText(textToCopy).then(function() {
                dohUrlDisplay.classList.add('copied');
                setTimeout(() => {
                  dohUrlDisplay.classList.remove('copied');
                }, 2000);
              }).catch(function(err) {
                console.error('复制失败:', err);
              });
            });
          }

          // 添加Get Json按钮的点击事件
          document.getElementById('getJsonBtn').addEventListener('click', function() {
            const dohSelect = document.getElementById('dohSelect').value;
            let dohUrl;
            
            // 获取当前选择的DoH服务器URL
            if(dohSelect === 'current') {
              dohUrl = currentDoHUrl;
            } else if(dohSelect === 'custom') {
              dohUrl = document.getElementById('customDoH').value;
              if (!dohUrl) {
                alert('请输入自定义 DoH 地址');
                return;
              }
            } else {
              dohUrl = dohSelect;
            }
            
            // 获取域名
            const domain = document.getElementById('domain').value;
            if (!domain) {
              alert('请输入需要解析的域名');
              return;
            }
            
            // 构建完整的查询URL
            let jsonUrl = new URL(dohUrl);
            // 使用name参数(标准DNS-JSON格式)
            jsonUrl.searchParams.set('name', domain);
            
            // 在新标签页打开
            window.open(jsonUrl.toString(), '_blank');
          });
        });



        // 获取本地IP信息
        async function getMyIpInfo() {
          try {
            const response = await fetch('/ip-info');
            const data = await response.json();
            
            document.getElementById('myIpLoading').style.display = 'none';
            document.getElementById('myIpContent').style.display = 'block';
            
            const ipInfoHtml = \`
              <div class="table-responsive">
                <table class="table table-bordered table-striped">
                  <tr>
                    <td style="width: 30%; font-weight: bold;">IP地址</td>
                    <td>\${data.query || '-'}</td>
                  </tr>
                  <tr>
                    <td style="width: 30%; font-weight: bold;">国家</td>
                    <td>\${data.country || '-'} (\${data.countryCode || '-'})</td>
                  </tr>
                  <tr>
                    <td style="width: 30%; font-weight: bold;">省份</td>
                    <td>\${data.regionName || '-'}</td>
                  </tr>
                  <tr>
                    <td style="width: 30%; font-weight: bold;">城市</td>
                    <td>\${data.city || '-'}</td>
                  </tr>
                  <tr>
                    <td style="width: 30%; font-weight: bold;">时区</td>
                    <td>\${data.timezone || '-'}</td>
                  </tr>
                  <tr>
                    <td style="width: 30%; font-weight: bold;">ISP</td>
                    <td>\${data.isp || '-'}</td>
                  </tr>
                  <tr>
                    <td style="width: 30%; font-weight: bold;">组织</td>
                    <td>\${data.org || '-'}</td>
                  </tr>
                  <tr>
                    <td style="width: 30%; font-weight: bold;">坐标</td>
                    <td>\${data.lat || '-'}, \${data.lon || '-'}</td>
                  </tr>
                </table>
              </div>
            \`;
            
            document.getElementById('myIpContent').innerHTML = ipInfoHtml;
          } catch (error) {
            document.getElementById('myIpLoading').style.display = 'none';
            document.getElementById('myIpContent').style.display = 'block';
            document.getElementById('myIpContent').textContent = '获取失败: ' + error.message;
          }
        }

        // 页面加载时获取IP信息
        document.addEventListener('DOMContentLoaded', function() {
          getMyIpInfo();
        });

        // 折叠面板交互（DNS 查询设置 / 网络测速）
        document.querySelectorAll('.collapse-toggle').forEach(function(btn) {
          btn.addEventListener('click', function() {
            const target = document.getElementById(btn.dataset.target);
            const isOpen = target.classList.toggle('open');
            btn.classList.toggle('open', isOpen);
            btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            // 首次展开网络测速时才加载测速页面，避免默认折叠时白白消耗流量
            const iframe = target.querySelector('iframe[data-src]');
            if (isOpen && iframe && !iframe.getAttribute('src')) {
              iframe.setAttribute('src', iframe.dataset.src);
            }
          });
        });

        // 广告拦截面板：首次展开才拉数据
        (function () {
          const btn = document.querySelector('[data-target="blockSection"]');
          if (!btn) return;
          let loaded = false;

          const statsEl = document.getElementById('blockStats');
          const hitsEl = document.getElementById('blockHits');
          const tagsEl = document.getElementById('allowTags');
          const inputEl = document.getElementById('allowInput');
          const allowBtn = document.getElementById('allowBtn');
          const ruleTagsEl = document.getElementById('ruleTags');
          const ruleInputEl = document.getElementById('ruleInput');
          const ruleBtn = document.getElementById('ruleBtn');
          const ruleSubEl = document.getElementById('ruleSub');
          const refreshBtn = document.getElementById('refreshBtn');
          let ruleMode = 'block';

          function esc(s) {
            return String(s).replace(/[&<>"]/g, function (c) {
              return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
            });
          }

          function ago(ts) {
            const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
            if (s < 60) return s + ' 秒前';
            if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
            if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
            return Math.floor(s / 86400) + ' 天前';
          }

          function render(d) {
            statsEl.innerHTML =
              '<div class="block-stat"><b>' + d.today + '</b><span>今日拦截</span></div>' +
              '<div class="block-stat"><b>' + d.total + '</b><span>近 7 天累计</span></div>' +
              '<div class="block-stat"><b>' + d.allow.length + '</b><span>白名单</span></div>';

            hitsEl.innerHTML = d.hits.length
              ? d.hits.map(function (h) {
                  return '<div class="block-row"><span class="dom">' + esc(h.domain) +
                    '</span><span class="time">' + ago(h.ts) + '</span></div>';
                }).join('')
              : '<div class="block-empty">还没有拦截记录</div>';

            // 白名单 / 额外拦截域名用同一套渲染，点 × 即删
            function tags(box, list, empty, action) {
              box.innerHTML = list.length
                ? list.map(function (x) {
                    return '<span class="block-tag">' + esc(x) + '<i data-x="' + esc(x) + '">×</i></span>';
                  }).join('')
                : '<span class="block-empty">' + empty + '</span>';
              box.querySelectorAll('i[data-x]').forEach(function (i) {
                i.addEventListener('click', function () { act(action, i.getAttribute('data-x')); });
              });
            }

            ruleSubEl.textContent = '拦截名单（' + (d.count || 0).toLocaleString() + ' 条）';
            tags(tagsEl, d.allow, '白名单为空', 'unallow');
            tags(ruleTagsEl, d.rules || [], '默认名单之外没有额外添加的域名', 'unblock');
          }

          async function load() {
            try {
              const r = await fetch('/blocked/api?action=list');
              const d = await r.json();
              if (d.error) throw new Error(d.error);
              render(d);
            } catch (e) {
              hitsEl.innerHTML = '<div class="block-empty">' + esc(e.message) + '</div>';
            }
          }

          async function act(action, domain) {
            try {
              const r = await fetch('/blocked/api?action=' + action + '&d=' + encodeURIComponent(domain));
              const d = await r.json();
              if (d.error) throw new Error(d.error);
              inputEl.value = '';
              ruleInputEl.value = '';
              ruleMode = 'block';
              ruleBtn.textContent = '拦截';
              await load();
            } catch (e) {
              alert('操作失败：' + e.message);
            }
          }

          btn.addEventListener('click', function () {
            if (loaded) return;
            loaded = true;
            load();
          });

          allowBtn.addEventListener('click', function () {
            const v = inputEl.value.trim();
            if (v) act('allow', v);
          });

          inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') allowBtn.click();
          });

          // 输入框里的域名当前在不在名单里，决定按钮是「拦截」还是「删除」
          let checkTimer = null;

          function refreshRuleBtn() {
            const v = ruleInputEl.value.trim();
            clearTimeout(checkTimer);
            if (!v) {
              ruleMode = 'block';
              ruleBtn.textContent = '拦截';
              return;
            }
            checkTimer = setTimeout(async function () {
              try {
                const r = await fetch('/blocked/api?action=check&d=' + encodeURIComponent(v));
                const d = await r.json();
                if (!d || d.error || ruleInputEl.value.trim() !== v) return;
                ruleMode = d.blocked ? 'unblock' : 'block';
                ruleBtn.textContent = d.blocked ? '删除' : '拦截';
              } catch (e) {}
            }, 250);
          }

          ruleInputEl.addEventListener('input', refreshRuleBtn);

          ruleInputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') ruleBtn.click();
          });

          ruleBtn.addEventListener('click', function () {
            const v = ruleInputEl.value.trim();
            if (v) act(ruleMode, v);
          });

          refreshBtn.addEventListener('click', function () {
            refreshBtn.textContent = '刷新中…';
            act('refresh', '').then(function () {
              refreshBtn.textContent = '刷新名单';
            });
          });
        })();
  </script>
</body>

</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html;charset=UTF-8" }
  });
}
