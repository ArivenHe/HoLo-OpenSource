# Docker 与 GitHub Actions 部署

项目生产镜像会在同一个 `3001` 端口提供：

- 玩家页面和 `/spectator`
- WebSocket 实时服务
- `GET /health` 健康检查

## 本地 Docker

```bash
cp .env.example .env
# 运行 openssl rand -hex 24，并将结果填入 .env 的 ADMIN_TOKEN
docker compose up -d --build
```

默认访问地址是 `http://localhost:3001`。

## 服务器准备

服务器需要满足：

1. 已安装 Docker Engine 和 Docker Compose 插件。
2. SSH 密码登录已启用。
3. SSH 用户可以执行 `docker` 和 `docker compose`。
4. 防火墙已放行 `APP_PORT`，默认是 `3001`。

## GitHub Environment

在 GitHub 仓库中打开 `Settings -> Environments`，创建名为 `production` 的 Environment。

在 `production` 的 **Environment secrets** 中添加：

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 是 | NPC 管理密码，至少 16 位随机十六进制或 base64url 字符；不与玩家分享 |
| `SSH_HOST` | 是 | 服务器 IP 或域名 |
| `SSH_USERNAME` | 是 | SSH 登录用户名 |
| `SSH_PASSWORD` | 是 | SSH 登录密码 |
| `GHCR_USERNAME` | 私有镜像需要 | 可读取 GHCR 镜像的 GitHub 用户名 |
| `GHCR_TOKEN` | 私有镜像需要 | 具备 `read:packages` 权限的 GitHub Token |

在 `production` 的 **Environment variables** 中按需添加：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `DEFAULT_PLAYER_LIMIT` | `200` | 服务启动后的默认人数上限 |
| `MAX_PLAYER_LIMIT` | `200` | 后台可填写的最大人数，默认开放 1～200 人 |
| `MAX_CONNECTIONS` | `300` | 玩家、后台、观众及未订阅连接总数，不能低于人数硬上限 |
| `BROADCAST_HZ` | `12` | 活跃同步频率，允许 5～30；先优化每包成本再提高 |
| `SYNC_MODE` | `delta` | `full` 可回退到全量广播，客户端协议仍为 v2 |
| `SSH_PORT` | `22` | SSH 端口 |
| `APP_PORT` | `3001` | 对外提供服务的服务器端口 |
| `DEPLOY_PATH` | `holo-opensource-deploy` | 服务器部署目录，相对路径位于 SSH 用户主目录 |

如果 GHCR package 设置为 public，可以不配置 `GHCR_USERNAME` 和 `GHCR_TOKEN`。
SSH 密码只由 GitHub Actions 读取，不会写入服务器上的 `.env` 文件。

## 自动部署流程

`.github/workflows/deploy.yml` 会在推送到 `main` 或 `master` 时执行，也支持手动运行：

1. 执行 `npm ci`、`npm test` 和 `npm run build`。
2. 构建 Docker 镜像并推送到 `ghcr.io/<owner>/<repo>`。
3. 使用 `production` Environment 中的 SSH 用户名和密码连接服务器。
4. 在服务器的 `DEPLOY_PATH` 中更新 Compose 配置并拉取当前提交对应的镜像。
5. 等待容器健康检查通过后完成部署。

当前比赛状态保存在服务进程内存中，容器更新或重启后会重置。

## HTTPS 反向代理

使用域名和 HTTPS 时，需要让反向代理把 HTTP 与 WebSocket 一起转发到 `APP_PORT`。Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    proxy_buffering off;
}
```


## 人数、延迟与运行配置

`.env` 中设置 `DEFAULT_PLAYER_LIMIT`、`MAX_PLAYER_LIMIT`、`MAX_CONNECTIONS` 和 `ADMIN_TOKEN` 后，执行 `docker compose up -d` 使进程配置生效。Compose 已显式传递这些配置；仅编辑 `.env` 不会改变运行中的容器。

人数默认值与后台硬上限均为 200，总连接上限默认 300，给观众和后台预留连接。NPC 后台可保存 1～200 人。GitHub 自动部署和本地 Compose 的默认配置已同步；若已有环境显式设置了 `MAX_PLAYER_LIMIT=50`，应改为 200，并将 `DEFAULT_PLAYER_LIMIT` 改为 200、`MAX_CONNECTIONS` 改为 300 后重新部署。更高人数同时增加计算量与广播扇出，应检查 CPU、容器限流、出口带宽、反向代理连接数和系统文件描述符上限。

本地 Compose 另支持 `MAX_BUFFERED_BYTES`（默认 131072）和 `SYNC_MODE=full`。慢连接持续积压约 3 秒后会关闭并重连，不会持续堆积历史状态；心跳约 15 秒一次，约 30 秒无响应清理。代理超时应大于失活判定时间。

GitHub Actions 会将 `production` 的管理密码写入服务器权限受限的部署 `.env`，不要提交此文件。原有部署升级前须先添加 `ADMIN_TOKEN` secret，否则新部署会明确失败。使用 HTTPS/WSS，管理密码不放在 URL 或 `VITE_` 构建变量中。直接 `npm start` 未配置密码时会生成并打印临时密码，生产应始终配置稳定密码。

管理权限与玩家恢复身份分开验证。公开投屏页可观看，但只有输入管理密码后才能修改人数、开始和重置。房间人数运行时修改暂存在内存中；容器重启恢复 `DEFAULT_PLAYER_LIMIT`。玩家身份过期、进程重启或从旧版协议升级后需要重新加入。

部署应在比赛之间进行。保留上一镜像与环境配置用于回退；回退会重启进程，无法恢复正在进行的内存比赛。不要将同一房间随机负载均衡到多个副本；多房间需要按房间归属路由到唯一权威进程。

先在独立测试实例按 [性能报告](performance-report.md) 的命令运行负载测试，再确定上线容量。报告中的本机短测不代替实际服务器的弱网、出口带宽和持续运行验收。
