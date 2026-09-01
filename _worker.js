let DoH = "cloudflare-dns.com";
const jsonDoH = `https://${DoH}/resolve`;
const dnsDoH = `https://${DoH}/dns-query`;
let DoH路径 = 'dns-query';
export default {
  async fetch(request, env) {
    if (env.DOH) {
      DoH = env.DOH;
      const match = DoH.match(/:\/\/([^\/]+)/);
      if (match) {
        DoH = match[1];
      }
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const hostname = url.hostname;
    
    const colo = request.cf?.colo || '未知';

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

    // 如果请求路径，则作为 DoH 服务器处理
    if (path === `/${DoH路径}`) {
      return await DOHRequest(request);
    }


    
    // 文件下载路由 - 处理 /{size}KB, /{size}MB, /{size}GB 这样的请求
    const sizeMatch = path.match(/^\/(\d+)(KB|MB|GB)$/i);
    if (sizeMatch) {
      const sizeNum = parseInt(sizeMatch[1]);
      const unit = sizeMatch[2].toUpperCase();
      
      let sizeBytes;
      let displaySize;
      
      switch (unit) {
        case 'KB':
          sizeBytes = sizeNum * 1000;
          displaySize = `${sizeNum}KB`;
          break;
        case 'MB':
          sizeBytes = sizeNum * 1000000;
          displaySize = `${sizeNum}MB`;
          break;
        case 'GB':
          sizeBytes = sizeNum * 1000000000;
          displaySize = `${sizeNum}GB`;
          break;
      }
      
      const targetUrl = `https://speed.cloudflare.com/__down?bytes=${sizeBytes}`;
      const headers = new Headers(request.headers);
      headers.set('referer', 'https://speed.cloudflare.com/');
      
      const response = await fetch(new Request(targetUrl, {
        method: request.method === 'HEAD' ? 'GET' : request.method,
        headers: headers,
        body: request.body
      }));
      
      const newHeaders = new Headers(response.headers);
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
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
        return await handleLocalDoHRequest(domain, type, hostname);
      }

      try {
        // 根据请求类型进行不同的处理
        if (type === "all") {
          // 同时请求 A、AAAA 和 NS 记录，使用新的查询函数
          const ipv4Result = await queryDns(doh, domain, "A");
          const ipv6Result = await queryDns(doh, domain, "AAAA");
          const nsResult = await queryDns(doh, domain, "NS");

          // 合并结果 - 修改Question字段处理方式以兼容不同格式
          const combinedResult = {
            Status: ipv4Result.Status || ipv6Result.Status || nsResult.Status,
            TC: ipv4Result.TC || ipv6Result.TC || nsResult.TC,
            RD: ipv4Result.RD || ipv6Result.RD || nsResult.RD,
            RA: ipv4Result.RA || ipv6Result.RA || nsResult.RA,
            AD: ipv4Result.AD || ipv6Result.AD || nsResult.AD,
            CD: ipv4Result.CD || ipv6Result.CD || nsResult.CD,

            // 修改处理Question字段的方式，兼容对象格式和数组格式
            Question: [],

            Answer: [...(ipv4Result.Answer || []), ...(ipv6Result.Answer || [])],
            ipv4: {
              records: ipv4Result.Answer || []
            },
            ipv6: {
              records: ipv6Result.Answer || []
            },
            ns: {
              records: []
            }
          };

          // 正确处理Question字段，无论是对象还是数组
          if (ipv4Result.Question) {
            if (Array.isArray(ipv4Result.Question)) {
              combinedResult.Question.push(...ipv4Result.Question);
            } else {
              combinedResult.Question.push(ipv4Result.Question);
            }
          }

          if (ipv6Result.Question) {
            if (Array.isArray(ipv6Result.Question)) {
              combinedResult.Question.push(...ipv6Result.Question);
            } else {
              combinedResult.Question.push(ipv6Result.Question);
            }
          }

          if (nsResult.Question) {
            if (Array.isArray(nsResult.Question)) {
              combinedResult.Question.push(...nsResult.Question);
            } else {
              combinedResult.Question.push(nsResult.Question);
            }
          }

          // 处理NS记录 - 可能在Answer或Authority部分
          const nsRecords = [];

          // 从Answer部分收集NS记录
          if (nsResult.Answer && nsResult.Answer.length > 0) {
            nsResult.Answer.forEach(record => {
              if (record.type === 2) { // NS记录类型是2
                nsRecords.push(record);
              }
            });
          }

          // 从Authority部分收集NS和SOA记录
          if (nsResult.Authority && nsResult.Authority.length > 0) {
            nsResult.Authority.forEach(record => {
              if (record.type === 2 || record.type === 6) { // NS=2, SOA=6
                nsRecords.push(record);
                // 也添加到总Answer数组
                combinedResult.Answer.push(record);
              }
            });
          }

          // 设置NS记录集合
          combinedResult.ns.records = nsRecords;

          return new Response(JSON.stringify(combinedResult, null, 2), {
            headers: { "content-type": "application/json; charset=UTF-8" }
          });
        } else {
          // 普通的单类型查询，使用新的查询函数
          const result = await queryDns(doh, domain, type);
          return new Response(JSON.stringify(result, null, 2), {
            headers: { "content-type": "application/json; charset=UTF-8" }
          });
        }
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

    // /app 路径返回完整功能页面
    if (path === '/app') {
      return await HTML();
    }

    // 默认返回简洁入口页（伪装用）
    return await landingHTML();
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

// 处理本地 DoH 请求的函数 - 直接调用 DoH，而不是自身服务
async function handleLocalDoHRequest(domain, type, hostname) {
  try {
    if (type === "all") {
      // 同时请求 A、AAAA 和 NS 记录
      const ipv4Promise = queryDns(dnsDoH, domain, "A");
      const ipv6Promise = queryDns(dnsDoH, domain, "AAAA");
      const nsPromise = queryDns(dnsDoH, domain, "NS");

      // 等待所有请求完成
      const [ipv4Result, ipv6Result, nsResult] = await Promise.all([ipv4Promise, ipv6Promise, nsPromise]);

      // 准备NS记录数组
      const nsRecords = [];

      // 从Answer和Authority部分收集NS记录
      if (nsResult.Answer && nsResult.Answer.length > 0) {
        nsRecords.push(...nsResult.Answer.filter(record => record.type === 2));
      }

      if (nsResult.Authority && nsResult.Authority.length > 0) {
        nsRecords.push(...nsResult.Authority.filter(record => record.type === 2 || record.type === 6));
      }

      // 合并结果
      const combinedResult = {
        Status: ipv4Result.Status || ipv6Result.Status || nsResult.Status,
        TC: ipv4Result.TC || ipv6Result.TC || nsResult.TC,
        RD: ipv4Result.RD || ipv6Result.RD || nsResult.RD,
        RA: ipv4Result.RA || ipv6Result.RA || nsResult.RA,
        AD: ipv4Result.AD || ipv6Result.AD || nsResult.AD,
        CD: ipv4Result.CD || ipv6Result.CD || nsResult.CD,
        Question: [...(ipv4Result.Question || []), ...(ipv6Result.Question || []), ...(nsResult.Question || [])],
        Answer: [
          ...(ipv4Result.Answer || []),
          ...(ipv6Result.Answer || []),
          ...nsRecords
        ],
        ipv4: {
          records: ipv4Result.Answer || []
        },
        ipv6: {
          records: ipv6Result.Answer || []
        },
        ns: {
          records: nsRecords
        }
      };

      return new Response(JSON.stringify(combinedResult, null, 2), {
        headers: {
          "content-type": "application/json; charset=UTF-8",
          'Access-Control-Allow-Origin': '*'
        }
      });
    } else {
      // 普通的单类型查询
      const result = await queryDns(dnsDoH, domain, type);
      return new Response(JSON.stringify(result, null, 2), {
        headers: {
          "content-type": "application/json; charset=UTF-8",
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  } catch (err) {
    console.error("DoH 查询失败:", err);
    return new Response(JSON.stringify({
      error: `DoH 查询失败: ${err.message}`,
      stack: err.stack
    }, null, 2), {
      headers: {
        "content-type": "application/json; charset=UTF-8",
        'Access-Control-Allow-Origin': '*'
      },
      status: 500
    });
  }
}

// DoH 请求处理函数
async function DOHRequest(request) {
  const { method, headers, body } = request;
  const UA = headers.get('User-Agent') || 'DoH Client';
  const url = new URL(request.url);
  const { searchParams } = url;

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
        body: body
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

async function HTML() {
  // 否则返回 HTML 页面
  const html = `<!DOCTYPE html>
<html lang="zh-CN">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZQ-Doh</title>
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
  </style>
</head>

<body>
  <a href="https://github.com/bayueqi/ZQ-Doh" target="_blank" class="github-corner" aria-label="View source on Github">
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
    <h1 class="text-center mb-4">ZQ-Doh</h1>

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

    <div class="beian-info">
      <p><strong>ZQ-Doh：<span id="dohUrlDisplay" class="copy-link" title="点击复制">https://<span
              id="currentDomain">...</span>/${DoH路径}</span></strong><br>基于 Cloudflare Workers 上游 ${DoH} 的 DoH 
        解析与测速服务</p>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    // 获取当前页面的 URL 和主机名
    const currentUrl = window.location.href;
    const currentHost = window.location.host;
    const currentProtocol = window.location.protocol;
    const currentDoHPath = '${DoH路径}';
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
  </script>
</body>

</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html;charset=UTF-8" }
  });
}

async function 代理URL(代理网址, 目标网址) {
  const 网址列表 = await 整理(代理网址);
  const 完整网址 = 网址列表[Math.floor(Math.random() * 网址列表.length)];

  // 解析目标 URL
  const 解析后的网址 = new URL(完整网址);
  console.log(解析后的网址);
  // 提取并可能修改 URL 组件
  const 协议 = 解析后的网址.protocol.slice(0, -1) || 'https';
  const 主机名 = 解析后的网址.hostname;
  let 路径名 = 解析后的网址.pathname;
  const 查询参数 = 解析后的网址.search;

  // 处理路径名
  if (路径名.charAt(路径名.length - 1) == '/') {
    路径名 = 路径名.slice(0, -1);
  }
  路径名 += 目标网址.pathname;

  // 构建新的 URL
  const 新网址 = `${协议}://${主机名}${路径名}${查询参数}`;

  // 反向代理请求
  const 响应 = await fetch(新网址);

  // 创建新的响应
  let 新响应 = new Response(响应.body, {
    status: 响应.status,
    statusText: 响应.statusText,
    headers: 响应.headers
  });

  // 添加自定义头部，包含 URL 信息
  //新响应.headers.set('X-Proxied-By', 'Cloudflare Worker');
  //新响应.headers.set('X-Original-URL', 完整网址);
  新响应.headers.set('X-New-URL', 新网址);

  return 新响应;
}

async function 整理(内容) {
  // 将制表符、双引号、单引号和换行符都替换为逗号
  // 然后将连续的多个逗号替换为单个逗号
  var 替换后的内容 = 内容.replace(/[	|"'\r\n]+/g, ',').replace(/,+/g, ',');

  // 删除开头和结尾的逗号（如果有的话）
  if (替换后的内容.charAt(0) == ',') 替换后的内容 = 替换后的内容.slice(1);
  if (替换后的内容.charAt(替换后的内容.length - 1) == ',') 替换后的内容 = 替换后的内容.slice(0, 替换后的内容.length - 1);

  // 使用逗号分割字符串，得到地址数组
  const 地址数组 = 替换后的内容.split(',');

  return 地址数组;
}

// 简洁入口页（伪装用）
async function landingHTML() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="个人主页">
  <title>ZQ-Doh</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    html, body {
      height: 100%;
      font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    }

    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        radial-gradient(ellipse at top left, rgba(253, 101, 60, 0.35), transparent 60%),
        radial-gradient(ellipse at bottom right, rgba(251, 152, 30, 0.35), transparent 60%),
        linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      background-attachment: fixed;
      position: relative;
      overflow: hidden;
    }

    /* 背景装饰圆 */
    body::before,
    body::after {
      content: '';
      position: absolute;
      border-radius: 50%;
      filter: blur(80px);
      opacity: 0.5;
      z-index: 0;
      animation: float 8s ease-in-out infinite;
    }

    body::before {
      width: 400px; height: 400px;
      background: #fd653c;
      top: -100px; left: -100px;
    }

    body::after {
      width: 350px; height: 350px;
      background: #fb981e;
      bottom: -80px; right: -80px;
      animation-delay: -4s;
    }

    @keyframes float {
      0%, 100% { transform: translate(0, 0) scale(1); }
      50%      { transform: translate(30px, -20px) scale(1.08); }
    }

    .card {
      position: relative;
      z-index: 1;
      text-align: center;
      padding: 60px 80px;
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.3),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
      animation: fadeInUp 0.8s ease-out;
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    h1 {
      font-size: 4rem;
      font-weight: 700;
      letter-spacing: 4px;
      background: linear-gradient(135deg, #fbab4c, #fc673c);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 40px;
      text-shadow: none;
    }

    .enter-btn {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 14px 48px;
      font-size: 1.1rem;
      font-weight: 500;
      letter-spacing: 2px;
      color: #fff;
      background: linear-gradient(135deg, #fd653c, #fb981e);
      border: none;
      border-radius: 50px;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      text-decoration: none;
      box-shadow: 0 4px 20px rgba(253, 101, 60, 0.4);
    }

    .enter-btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 30px rgba(253, 101, 60, 0.6);
      letter-spacing: 4px;
    }

    .enter-btn:active {
      transform: translateY(0);
      box-shadow: 0 2px 12px rgba(253, 101, 60, 0.4);
    }

    .arrow {
      transition: transform 0.3s ease;
      display: inline-block;
    }

    .enter-btn:hover .arrow {
      transform: translateX(6px);
    }

    @media (max-width: 576px) {
      .card { padding: 45px 40px; }
      h1 { font-size: 2.8rem; letter-spacing: 2px; }
      .enter-btn { padding: 12px 36px; font-size: 1rem; }
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>ZQ-Doh</h1>
    <a class="enter-btn" href="/app">进入<span class="arrow">→</span></a>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html;charset=UTF-8" }
  });
}
