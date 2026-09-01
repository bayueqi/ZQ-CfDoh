# 📶 ZQ-CfDoh


ZQ-CfDoh 是一个基于 Cloudflare Workers 构建的 DNS over HTTPS (DoH) 解析服务，同时集成了网络测速功能。它允许你通过 HTTPS 协议进行 DNS 查询，提高查询的安全性和隐私保护，同时提供网络速度测试和节点信息查询。


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

- `<DoHPath>` 对应代码中第 4 行的 `DoHPath` 变量，默认为 `dns-query`，可自行修改
- 还可使用 Cloudflare 回源端口 `2053`、`2083`、`2087`、`2096`、`8443`，例如
```url
https://doh.workers.dev:2053/dns-query
```


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

## 🔧 变量说明

| 变量名 | 示例 | 必填 | 备注 | 
|--|--|--|--|
| DOH | `dns.google` |❌| 设置上游DoH服务（默认：`cloudflare-dns.com`）|
| DoHPath | `dns-query` |❌| DoH 端点路径，**同时也是网页访问密码**（默认：`dns-query`）|

> [!TIP]
> 1. 使用 `dns.google` 或 `cloudflare-dns.com` 作为DoH上游时，**解析速度最佳**！
> 2. 使用 `security.cloudflare-dns.com` 作为DoH上游时，可**阻止恶意软件**的DNS解析服务；
> 3. 使用 `family.cloudflare-dns.com` 作为DoH上游时，可**阻止恶意软件**和**成人内容**的DNS解析服务；
> 4. 已知 `doh.pub` **自带污染**，不适合作为DoH上游；
> 5. 目前 `sm2.doh.pub`、`dns.alidns.com` 和 `doh.360.cn` 在**非中国大陆环境**请求DoH时，会下发干净DNS解析服务，也就是**可以作为CF-DoH的上游**，但是**解析速度不佳**。



## 💡 技术特性
- 基于 Cloudflare Workers 无服务器架构
- 使用原生 JavaScript 实现
- 集成网络测速功能（下载/上传速度测试）
- 显示当前连接的 Cloudflare Colo 节点信息
- 响应式设计，支持移动端访问
- 实时速度显示
- **页面访问密码保护**：主页默认显示伪装登录页，密码与 DoH 路径变量共用，一键改密码
- API 与 DoH 端点无需密码，仅保护网页 UI

## 📝 许可证
本项目开源使用，欢迎自由部署和修改！
