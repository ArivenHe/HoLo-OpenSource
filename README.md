# 50-Player Real-Time 3D Sokoban Battle Royale

开放原子开源社团 PU 活动用的 50 人实时 3D 推箱子阵营战。所有玩家填写昵称并手动加入 Red / Blue / Green / Yellow 队伍，后台确认队伍人数均衡后统一开始。玩家把本阵营颜色的箱子推入同色基地，限定时间内得分最高的阵营获胜。

## 目录

```text
server/
  index.ts                    WebSocket 权威状态服务器、碰撞、得分、重生、30Hz 广播
  tsconfig.json
client/
  index.html
  vite.config.ts
  src/
    App.tsx
    main.tsx
    store/useGameStore.ts     Zustand + WebSocket sync hook
    types/game.ts             前后端消息与实体类型
    components/GameCanvas.tsx  R3F instanced mesh 大地图渲染
    components/UIOverlay.tsx   HUD + NPC 后台控制
    components/Leaderboard.tsx 阵营排行榜
    components/TeamSetup.tsx   玩家填写昵称并手动选队加入
```

## 玩法

- 默认一张 `64 x 64` 巨型 3D 网格地图，NPC 后台可自定义宽、高和箱子数量。
- 4 个阵营基地：Red、Blue、Green、Yellow，玩家手动选队。
- 最多 50 名玩家同时在线。
- 地图默认生成 220 个颜色箱子。
- 玩家只能通过 WebSocket 向服务端发送移动输入，服务端权威判定碰撞和推箱。
- 玩家页提供键盘和屏幕方向键两套输入方式，同时按两个方向键会连续斜向移动。
- 玩家可以自己调整视角高度、距离和抖动强度。
- 未开始时玩家页显示等待 NPC 开始，NPC 开始后先显示 3 秒倒计时，再进入游戏。
- 玩家选队时可看到每个队伍已有成员，后台可看到队伍成员和均衡状态。
- 同色箱子进入同色基地：该阵营 `+1`。
- 错色箱子进入基地：不加分。
- 玩家离开身后相邻箱子时会拉动该箱子，贴边箱子可以被拉回战场内。
- 没有步数限制。
- NPC 后台统一开始/重置比赛，默认 45 分钟。
- 卡在死角 60 秒未移动的箱子会自动重生。
- `/spectator` 路由是投影用 God View。

## 本地启动

```bash
npm install

npm run dev
```

默认地址：

```text
Client: http://localhost:5173
Server: ws://localhost:3001
God View: http://localhost:5173/spectator
```

如果前端端口被占用，Vite 会自动切换到下一个可用端口，控制台会显示实际地址。

## 构建检查

```bash
npm run build
```

构建后可以用单端口生产服务启动前端、WebSocket 和健康检查：

```bash
npm start
```

```text
App: http://localhost:3001
Health: http://localhost:3001/health
```

## Docker 与自动部署

本地 Docker 启动：

```bash
cp .env.example .env
docker compose up -d --build
```

项目已配置 GitHub Actions 构建 GHCR 镜像，并通过 GitHub Environment 中的 SSH 用户名和密码自动部署。服务器准备、`production` Environment secrets/variables 和反向代理配置见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 消息协议

客户端发送：

```ts
{ type: 'JOIN', name: string, faction: 'red' | 'blue' | 'green' | 'yellow' }
{ type: 'MOVE_PLAYER', direction?: 'up' | 'down' | 'left' | 'right', delta?: { x: -1 | 0 | 1, y: -1 | 0 | 1 } }
{ type: 'ADMIN_START', durationSeconds: number, mapConfig?: { width: number, height: number, boxCount: number } }
{ type: 'ADMIN_RESET', mapConfig?: { width: number, height: number, boxCount: number } }
```

服务端发送：

```ts
{ type: 'INIT', selfId?: string, map, state }
{ type: 'STATE', state } // state.stats.onlinePlayers 是真实在线玩家数，state.match.countdownSeconds 是开赛倒计时
{ type: 'ERROR', message: string }
```
