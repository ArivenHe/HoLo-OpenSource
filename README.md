# 多人实时 3D 推箱子阵营战

开放原子开源社团 PU 活动用的多人实时 3D 推箱子。玩家填写昵称，手动选择 Red / Blue / Green / Yellow 队伍，把同色箱子推入基地得分。NPC 统一开始，队伍无需均衡，也无需满员。

## 启动

```bash
npm ci
npm run dev
```

玩家页：[http://localhost:5173](http://localhost:5173)；观众与 NPC 后台：[http://localhost:5173/spectator](http://localhost:5173/spectator)。开发服务器默认 WebSocket 端口为 `3001`。

后台先输入管理密码。直接启动时可通过 `ADMIN_TOKEN` 指定；未设置时服务端终端打印临时密码，重启后变化。管理密码只提供给 NPC，公开观众不需要密码。

生产构建与启动：

```bash
npm run build
ADMIN_TOKEN=your-random-password npm start
```

生产服务同一端口提供前端、WebSocket 和 `/health`，默认地址：[http://localhost:3001](http://localhost:3001)。Docker 与自动部署见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 玩法与房间设置

- 默认 200 人上限，后台在等待中或比赛结束后修改并点击“保存房间设置”，立即生效；服务重启恢复部署默认值。
- 服务器 `MAX_PLAYER_LIMIT` 控制后台允许填写的最大人数，默认开放到 200，后台可设置 1～200 人。
- 不能把人数下调到当前在线人数以下。观众不占玩家名额，但受总连接数限制。
- 至少 1 名在线玩家即可开始，允许空队和人数不均衡；开局前有 3 秒倒计时。
- 地图默认 `64 × 64`、220 个箱子，后台可调整宽高与箱子数量。新地图容量不足会拒绝应用，保留当前战场。
- 键盘 WASD / 方向键与屏幕方向键都支持长按及斜向移动；首步即时发送，长按约 120ms 一步，服务端最短步间隔为 115ms。
- 允许连推箱子；向空地移动时会拉动身后的相邻箱子。同色进基地 +1，错色不加分，没有步数限制。
- 卡在墙角且 60 秒未移动的箱子会重生。默认每局 45 分钟。
- 断线自动退避重连，离线身份保留 5 分钟；断线释放名额，满员时恢复会被拒绝，不补发离线操作。
- 本人空地移动有最多 2 步、250ms 的本地预测；推箱、拉箱和得分由服务端确认。页面显示 RTT 与连接状态。

## 实时同步与并发

服务端维护权威状态及格子占位索引；玩家发送输入序号与比赛标识，服务端限速并确认结果。默认 12Hz 稀疏增量广播，约每 5 秒全量校准；慢连接跳过增量后必须用快照恢复。消息长度、输入速率、短队列、连接总数及发送积压都有上限。

服务器仍为单房间单进程内存状态；重启或升级会丢失当前比赛。同一房间不能通过随机分流到多个副本扩容。

## 验证

```bash
npm test
npm run build
```

本机负载测试示例（先启动服务并设置匹配的管理密码）：

```bash
ADMIN_TOKEN=your-random-password npm run loadtest -- --players 50 --spectators 5 --seconds 30 --output /tmp/holo-load.json
```

测试会调整测试房间人数并开始比赛，请使用独立测试实例；远程目标须显式传入 `--allow-remote`。报告包含加入流量、输入确认分位数、服务端 CPU、事件循环和 RSS。实测记录与限制见 [docs/performance-report.md](docs/performance-report.md)。完整设计见 [docs/player-capacity-and-latency-plan.md](docs/player-capacity-and-latency-plan.md)。

## 代码目录

```text
shared/protocol.ts                 前后端共用协议、规则常量与类型
server/world.ts                    权威网格、出生、碰撞、推拉箱与得分
server/transport.ts                令牌桶、背压与同步基线判断
server/index.ts                    会话、房间配置、输入调度、广播、HTTP
client/src/store/useGameStore.ts   WebSocket、身份恢复、状态归并与校正
client/src/store/sync.ts           增量合并与有界预测
client/src/store/input.ts          键盘/触屏统一输入
client/src/components/             3D 场景、玩家页面与后台
scripts/loadtest.ts                可复现的本机操作负载
tests/                            世界规则、协议与真实 WebSocket 集成测试
```

协议版本为 2；旧页面或旧身份需要刷新、重新加入。INIT 携带地图与全量状态，DELTA 携带版本化增删改，INPUT_ACK 确认输入，RESYNC 请求最新快照；鉴权、容量和每个消息字段均由服务端校验。
