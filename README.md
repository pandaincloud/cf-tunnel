# cf-tunnel

Cloudflare Pages VLESS WebSocket 代理与订阅服务。基于 [am-cf-tunnel](https://github.com/pandaincloud/am-cf-tunnel) 已合并的修复版本整理。

## Pages 部署

在 Cloudflare 的 Workers & Pages 中创建 Pages 项目，连接本仓库。填写：

| 配置项 | 值 |
| --- | --- |
| 生产分支 | `main` |
| 框架预设 | `None` |
| 构建命令 | `exit 0` |
| 构建输出目录 | `.` |
| 根目录 | 留空 |
| 生产环境变量 | `UUID`，填你自己的 UUID，可沿用原项目的值 |

推荐将 `UUID` 保存为 Secret；不要把实际 UUID、订阅链接或密钥写入 GitHub。没有有效 `UUID` 时服务返回 503。

如先部署再添加环境变量，添加后重新部署。无需 KV，也不用绑定原来的 `ips`。

先通过新项目分配的 `*.pages.dev` 域名确认部署成功。不要提前删除旧项目、修改旧域名或更新路由器全部订阅。

官方文档：[Git 集成部署](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/)、[高级模式](https://developers.cloudflare.com/pages/functions/advanced-mode/)。

## 订阅地址

将下列占位内容替换为新项目域名及你的 UUID：

```text
通用订阅：https://新项目域名/你的UUID
Clash / ShellCrash：https://新项目域名/你的UUID?clash&flag=clash
```

订阅默认使用本仓库的 `ipv4.txt`，提供 9 个入口；名称沿用旧节点标签，不保证出口地区。可通过 `ADDAPI` 指向自己的地址池，或用 `ADD` 配置入口列表。Clash 转换仍依赖外部服务，可用 `SUBAPI` 和 `SUBCONFIG` 覆盖。

## 回落出口

默认 `PROXYIP` 为 `58.176.95.46`，来自原仓库已有的候选地址，在整理时通过了 OpenAI 域名的 TLS 校验。该出口由外部服务提供，可用性可能变化；可以设置 `PROXYIP` 或 `SOCKS5` 使用自己维护的出口。

这个项目同时负责生成订阅和转发连接；ShellCrash 负责路由器上的分流与连接到本服务。

已修复订阅来源失效时只生成两条占位节点、连接状态在请求间串用，以及 TCP 回落时提前关闭客户端的问题。所有订阅来源失效时返回 503，避免静默替换成残缺订阅。

## 平台限制

新仓库不能解除 Cloudflare 已有的封锁，也不保证平台接受部署。若后台提示 `Your Pages project has been blocked`，保留报错并按平台提示联系 Cloudflare 确认原因。

## 验证

使用 Node.js 24：

```sh
node --test tests/*.test.cjs
node --input-type=module --check < _worker.js
```

回归测试覆盖订阅来源故障、节点隔离、TCP 回落、流关闭顺序、Cloudflare 新环境的 Blob 二进制消息兼容和 UUID 必填保护。自动测试不代表已完成 Cloudflare 线上或手机验证。

已显式设置 WebSocket 的 `binaryType`，并按接收顺序转换 Blob，兼容 Cloudflare 自 2026-03-17 起的新默认行为。参见 [官方变更说明](https://developers.cloudflare.com/changelog/post/2026-04-21-websocket-standard-binary-type/)。

## 来源与许可

保留原项目 Apache-2.0 许可及源文件署名，详见 `LICENSE`、`NOTICE`。
订阅请使用项目固定的 pages.dev 域名；含部署编号的域名固定在某次部署，不会自动采用后续修复。
