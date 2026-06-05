# Docker 与 GitHub Actions 部署

项目生产镜像会在同一个 `3001` 端口提供：

- 玩家页面和 `/spectator`
- WebSocket 实时服务
- `GET /health` 健康检查

## 本地 Docker

```bash
cp .env.example .env
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
| `SSH_HOST` | 是 | 服务器 IP 或域名 |
| `SSH_USERNAME` | 是 | SSH 登录用户名 |
| `SSH_PASSWORD` | 是 | SSH 登录密码 |
| `GHCR_USERNAME` | 私有镜像需要 | 可读取 GHCR 镜像的 GitHub 用户名 |
| `GHCR_TOKEN` | 私有镜像需要 | 具备 `read:packages` 权限的 GitHub Token |

在 `production` 的 **Environment variables** 中按需添加：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `SSH_PORT` | `22` | SSH 端口 |
| `APP_PORT` | `3001` | 对外提供服务的服务器端口 |
| `DEPLOY_PATH` | `holo-opensource-deploy` | 服务器部署目录，相对路径位于 SSH 用户主目录 |

如果 GHCR package 设置为 public，可以不配置 `GHCR_USERNAME` 和 `GHCR_TOKEN`。
SSH 密码只由 GitHub Actions 读取，不会写入服务器上的 `.env` 文件。

## 自动部署流程

`.github/workflows/deploy.yml` 会在推送到 `main` 或 `master` 时执行，也支持手动运行：

1. 执行 `npm ci` 和 `npm run build`。
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
}
```
