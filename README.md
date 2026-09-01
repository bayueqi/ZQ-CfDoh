# 📶 ZQ-CfDoh

ZQ-CfDoh 是一个基于 Cloudflare Workers 构建的 DNS over HTTPS (DoH) 解析服务，同时集成了网络测速功能。它允许你通过 HTTPS 协议进行 DNS 查询，提高查询的安全性和隐私保护，同时提供网络速度测试和节点信息查询。

## 🚀 部署方式

- **Workers** 部署：复制 [_worker.js](https://github.com/bayueqi/ZQ-CfDoh/blob/main/_worker.js) 代码，`保存并部署`
- **Pages** 部署：`Fork` 后 `连接GitHub` 一键部署即可

> ⚠️ **部署后必须设置 `PASSWORD` 变量**，否则所有功能接口将无法访问。

## 🔑 密码保护

ZQ-CfDoh **强制启用密码保护**，所有功能接口（主界面、DoH 解析、DNS 查询、IP 信息查询、测速）均需验证密码后才能使用。

- 密码验证采用 **Cookie 会话**（24小时有效期）+ **URL token 参数**（`?token=密码`，兼容 DoH 客户端）双模式
- 未设置 `PASSWORD` 变量时，所有接口返回 401 未授权，系统无法正常使用

### 📋 API 接口说明

| 接口 | 方法 | 密码验证 | 说明 |
|------|------|----------|------|
| `/app` | GET | ✅ 未验证时返回登录页 | 主界面 |
| `/auth` | POST | — | 密码验证接口（`{"password": "xxx"}`） |
| `/logout` | GET/POST | — | 登出，清除认证 Cookie |
| `/dns-query` | GET/POST | ✅ | DoH 解析服务 |
| `/?doh=...&domain=...` | GET | ✅ | Web DNS 查询 |
| `/ip-info` | GET | ✅ | IP 地理位置查询 |
| `/{size}KB\|MB\|GB` | GET | ✅ | 测速文件下载 |
| `/` | GET | ❌ | 入口页（伪装用） |

> 💡 **DoH 客户端使用**：在 DoH 客户端中访问时，通过 URL 参数传递密码 token：
> `https://your-domain.com/dns-query?token=你的密码`

## 📖 使用方法

假设你已部署成功，你的服务域名为：`doh.workers.dev`

### 0️⃣ 访问主界面（必须先登录）

```url
https://doh.workers.dev/app
```

访问会先弹出密码输入页，输入正确密码后才能进入主界面。登录后 Cookie 保留 24 小时，期间无需重复输入。

主界面包含 DNS 查询、IP 信息查询、网络测速等所有功能模块。

### 1️⃣ DNS解析服务 (DoH)

将以下地址添加到支持DoH的设备或软件中（必须携带 token 参数）：

```url
https://doh.workers.dev/dns-query?token=你的密码
```

- 还可使用 Cloudflare 回源端口 `2053`、`2083`、`2087`、`2096`、`8443`，例如
```url
https://doh.workers.dev:2053/dns-query?token=你的密码
```

### 2️⃣ 附加功能 IP信息查询

#### 🔍 查询当前IP信息
```url
https://doh.workers.dev/ip-info?token=你的密码
```

#### 🔍 查询指定IP信息
```url
https://doh.workers.dev/ip-info?ip=8.8.8.8&token=你的密码
```

#### 📝 **返回信息示例**
```json
{
  "status": "success",
  "country": "美国",
  "countryCode": "US",
  "region": "VA",
  "regionName": "弗吉尼亚州",
  "city": "Ashburn",
  "zip": "20149",
  "lat": 39.03,
  "lon": -77.5,
  "timezone": "America/New_York",
  "isp": "Google LLC",
  "org": "Google Public DNS",
  "as": "AS15169 Google LLC",
  "query": "8.8.8.8"
}
```

### 3️⃣ 网络测速功能

#### 📈 直接访问测速文件（必须携带 token 参数）
- **KB**：`https://doh.workers.dev/{size}KB?token=你的密码`，例如 `https://doh.workers.dev/100KB?token=你的密码`
- **MB**：`https://doh.workers.dev/{size}MB?token=你的密码`，例如 `https://doh.workers.dev/50MB?token=你的密码`
- **GB**：`https://doh.workers.dev/{size}GB?token=你的密码`，例如 `https://doh.workers.dev/1GB?token=你的密码`


> [!NOTE]
> 请将示例中的 `doh.workers.dev` 替换为你实际部署的域名

## 🔧 变量说明

| 变量名 | 示例 | 必填 | 备注 | 
|--|--|--|--|
| **PASSWORD** | `mySecret123` | ✅ | **全局访问密码**，所有功能接口均需通过此密码验证 |
| DOH | `dns.google` | ❌ | 设置上游DoH服务（默认：`cloudflare-dns.com`）|

> [!TIP]
> 1. 使用 `dns.google` 或 `cloudflare-dns.com` 作为DoH上游时，**解析速度最佳**！
> 2. 使用 `security.cloudflare-dns.com` 作为DoH上游时，可**阻止恶意软件**的DNS解析服务；
> 3. 使用 `family.cloudflare-dns.com` 作为DoH上游时，可**阻止恶意软件**和**成人内容**的DNS解析服务；
> 4. 已知 `doh.pub` **自带污染**，不适合作为DoH上游；
> 5. 目前 `sm2.doh.pub`、`dns.alidns.com` 和 `doh.360.cn` 在**非中国大陆环境**请求DoH时，会下发干净DNS解析服务，也就是**可以作为CF-DoH的上游**，但是**解析速度不佳**。

## 💡 技术特性
- 基于 Cloudflare Workers 无服务器架构
- 使用原生 JavaScript 实现
- 强制密码保护机制（Cookie 会话 + URL token 双模式）
- 集成网络测速功能（下载/上传速度测试）
- 显示当前连接的 Cloudflare Colo 节点信息
- 响应式设计，支持移动端访问
- 实时速度显示

## 📝 许可证
本项目开源使用，欢迎自由部署和修改！
