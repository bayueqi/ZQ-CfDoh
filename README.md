# 📶 ZQ-CfDoh


ZQ-CfDoh 是一个基于 Cloudflare Workers 构建的 DNS over HTTPS (DoH) 解析服务，集成了广告拦截、网络测速和 IP 信息查询。它允许你通过 HTTPS 协议进行 DNS 查询，提高查询的安全性和隐私保护。


## 🚀 部署方式

- **Workers** 部署：复制 [_worker.js](https://github.com/bayueqi/ZQ-CfDoh/blob/main/_worker.js) 代码，`保存并部署`即可
- **Pages** 部署：`Fork` 后 `连接GitHub` 一键部署即可

## 📖 使用方法

假设你已部署成功，你的服务域名为：`doh.workers.dev`

### 1️⃣ DNS解析服务 (DoH)

将以下地址添加到支持DoH的设备或软件中：

```url
https://doh.workers.dev/<DoHPath>
```

- `<DoHPath>` 对应代码顶部的 `DoHPath` 变量，默认为 `dns-query`，可自行修改
- 还可使用 Cloudflare 回源端口 `2053`、`2083`、`2087`、`2096`、`8443`，例如
```url
https://doh.workers.dev:2053/dns-query
```

支持三种查询格式：

| 方式 | 请求 | 说明 |
|--|--|--|
| POST | `POST https://doh.workers.dev/dns-query`<br>`Content-Type: application/dns-message` | RFC 8484 标准二进制报文 |
| GET 二进制 | `https://doh.workers.dev/dns-query?dns=<base64url>` | 同上，报文走 query |
| GET JSON | `https://doh.workers.dev/dns-query?name=example.com&type=A` | 返回 JSON，`type` 省略时按 A 查询 |

### 2️⃣ 附加功能 IP信息查询

#### 🔍 查询当前IP信息
```url
https://doh.workers.dev/ip-info
```

#### 🔍 查询指定IP信息
```url
https://doh.workers.dev/ip-info?ip=8.8.8.8
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

#### 📈 直接访问测速文件
- **KB**：`https://doh.workers.dev/{size}KB`，例如 `https://doh.workers.dev/100KB`
- **MB**：`https://doh.workers.dev/{size}MB`，例如 `https://doh.workers.dev/50MB`
- **GB**：`https://doh.workers.dev/{size}GB`，例如 `https://doh.workers.dev/1GB`


> [!NOTE]
> 请将示例中的 `doh.workers.dev` 替换为你实际部署的域名

### 4️⃣ 页面访问密码（伪装功能）

为防止被检测为 DNS 服务，网页主页（`/`）设置了访问密码，未输入密码会看到一个"请输入访问码"的伪装登录页。

- **访问密码** = `DoHPath` 变量的值（默认：`dns-query`）
- **密码页**：直接访问站点根路径时出现
- **登录入口**：也可以直接访问 `https://doh.workers.dev/auth`
- **登录凭证**：密码通过表单提交到 `/auth`，验证成功后会在浏览器写入 cookie，24 小时内免二次登录

> 🔒 **安全说明**：密码仅保护网页 UI，DoH API、`/ip-info`、测速下载等功能接口**不受密码限制**，可直接被 DNS 客户端或脚本调用。

### 5️⃣ 广告拦截

命中的域名由 Worker 直接返回 `NXDOMAIN`（RCODE=3），不转发给上游，也不建立连接。

#### 需要绑定一个 D1 数据库

| 项目 | 要求 |
|--|--|
| 绑定类型 | D1 数据库 |
| 变量名 | **`cfdoh`**（写死，不能改） |
| 建表 | 不用手动建，Worker 首次访问面板时自动创建 `hits` / `allowlist` / `rules` 三张表 |

> 绑定顺序无所谓：先部署后绑、先绑后部署都行，只要打开面板时 `cfdoh` 已绑定即可。
> 没绑定 D1 时 DoH 解析照常工作，只是没有拦截记录和名单管理。

#### 默认名单

默认名单不写在代码里，而是放在仓库的 [blocklist.txt](https://github.com/bayueqi/ZQ-CfDoh/blob/main/blocklist.txt)，共 **83,632 条**（合并 8 个公开源去重）：

- Worker 冷启动时从 `raw.githubusercontent.com` 拉取，并缓存到 Cloudflare 边缘节点 6 小时
- 拉取发生在 Cloudflare 边缘，国内访问该地址受限也不影响使用
- 拉取失败时按空名单处理（不会把 DNS 断掉），若绑定了 KV `BLOCK`（键名 `blocklist`）则用它兜底

#### 面板操作

主页「拦截」折叠区包含：统计 → 拦截名单 → 白名单 → 最近拦截。

- **拦截名单**：管的是「默认名单里没有、你自己加的」域名。输入后点「拦截」加进去，加过的会在下面列成标签，点标签上的 × 就删掉，立即失效。
- **白名单**：填进去的域名（含子域）无条件放行，优先级高于一切。
- **刷新名单**：改了 GitHub 上的 `blocklist.txt` 之后，点一次清掉边缘缓存和内存缓存，下一次查询重新拉取。

默认名单本身不在面板里改，要增删就改 `blocklist.txt` 再点「刷新名单」。

匹配规则是逐级后缀匹配，`doubleclick.net` 命中时 `ad.doubleclick.net`、`x.y.doubleclick.net` 一并命中；判断顺序为 **白名单 > （默认名单 + 手动添加）**。

要更新默认名单，改 `blocklist.txt`（一行一个域名）推到 `main` 分支，再在面板点「刷新名单」即可，不用重新部署代码。

## 🔧 变量说明

| 变量名 | 示例 | 必填 | 备注 | 
|--|--|--|--|
| DOH | `dns.google` |❌| 设置上游DoH服务（默认：`cloudflare-dns.com`）|
| DoHPath | `dns-query` |❌| DoH 端点路径，**同时也是网页访问密码**（默认：`dns-query`）|
| cfdoh | D1 数据库 |❌| 拦截记录与名单管理用，**变量名必须是 `cfdoh`**；不绑则无拦截功能 |
| BLOCK | KV 命名空间 |❌| 默认名单的兜底来源，键名 `blocklist`，一行一个域名 |

> [!TIP]
> 1. 使用 `dns.google` 或 `cloudflare-dns.com` 作为DoH上游时，**解析速度最佳**！
> 2. 使用 `security.cloudflare-dns.com` 作为DoH上游时，可**阻止恶意软件**的DNS解析服务；
> 3. 使用 `family.cloudflare-dns.com` 作为DoH上游时，可**阻止恶意软件**和**成人内容**的DNS解析服务；
> 4. 已知 `doh.pub` **自带污染**，不适合作为DoH上游；
> 5. 目前 `sm2.doh.pub`、`dns.alidns.com` 和 `doh.360.cn` 在**非中国大陆环境**请求DoH时，会下发干净DNS解析服务，也就是**可以作为CF-DoH的上游**，但是**解析速度不佳**。



## 💡 技术特性
- 基于 Cloudflare Workers 无服务器架构
- 使用原生 JavaScript 实现，单文件、无依赖
- 集成网络测速功能（下载/上传速度测试）
- 显示当前连接的 Cloudflare Colo 节点信息
- 响应式设计，支持移动端访问
- 实时速度显示
- **页面访问密码保护**：主页默认显示伪装登录页，密码与 DoH 路径变量共用，一键改密码
- API 与 DoH 端点无需密码，仅保护网页 UI
- **广告拦截**：83,632 条默认名单 + 面板自定义，命中回 `NXDOMAIN`；名单托管在仓库，支持热刷新
- **拦截记录**：基于 D1，保留最近 7 天，记录总量、今日拦截、热门域名

## 📝 许可证
本项目开源使用，欢迎自由部署和修改！
