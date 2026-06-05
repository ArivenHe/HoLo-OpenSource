import { Alert, Button, Drawer, InputNumber, Progress, Slider, Space, Tag, Tooltip, Typography } from 'antd';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Play, RotateCcw, Trophy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { factions, formatDuration, leaderboardRows, useGameStore } from '../store/useGameStore';
import type { Direction, FactionId, WorldConfig } from '../types/game';
import { Leaderboard } from './Leaderboard';
import { TeamSetup } from './TeamSetup';

const statusText = {
  waiting: '等待 NPC 开始',
  countdown: '倒计时',
  running: '比赛中',
  ended: '已结束',
};

function PlayerScoreStrip({ scores }: { scores: ReturnType<typeof useGameStore.getState>['state']['scores'] }) {
  return (
    <div className="player-score-strip" aria-label="队伍比分">
      {factions.map((faction) => (
        <div className="player-score-item" key={faction.id} style={{ borderColor: faction.color }}>
          <span className="player-score-dot" style={{ background: faction.color }} />
          <span className="player-score-name">{faction.name}</span>
          <strong>{scores[faction.id]}</strong>
        </div>
      ))}
    </div>
  );
}

type PlayerList = ReturnType<typeof useGameStore.getState>['state']['players'];

function teamRosters(players: PlayerList) {
  return factions.map((faction) => ({
    ...faction,
    members: players.filter((player) => player.assigned && player.faction === faction.id),
  }));
}

function teamBalance(players: PlayerList) {
  const rosters = teamRosters(players);
  const counts = rosters.map((roster) => roster.members.length);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const balanced = total > 0 && Math.max(...counts) - Math.min(...counts) <= 1;

  return { rosters, total, balanced };
}

function TeamRosterGrid({ rosters, compact = false }: { rosters: ReturnType<typeof teamRosters>; compact?: boolean }) {
  return (
    <div className={compact ? 'team-roster-grid compact' : 'team-roster-grid'}>
      {rosters.map((roster) => (
        <div className="team-roster-card" key={roster.id} style={{ borderColor: roster.color }}>
          <div className="team-roster-title">
            <span>
              <span className="color-dot" style={{ background: roster.color }} />
              {roster.name}
            </span>
            <Tag color="default">{roster.members.length}</Tag>
          </div>
          <div className="team-member-list">
            {roster.members.length > 0 ? roster.members.map((player) => player.name).join('、') : '暂无成员'}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlayerMatchOverlay({ onChangeTeam }: { onChangeTeam: () => void }) {
  const selfId = useGameStore((state) => state.selfId);
  const serverState = useGameStore((state) => state.state);
  const selfPlayer = serverState.players.find((player) => player.id === selfId);

  if (!selfId || serverState.match.status === 'running') return null;

  if (serverState.match.status === 'countdown') {
    return (
      <div className="player-status-card countdown-card">
        <Typography.Text className="eyebrow">Ready</Typography.Text>
        <strong>{serverState.match.countdownSeconds || 1}</strong>
        <Typography.Text>
          {selfPlayer?.assigned ? (
            <>
              <span className="color-dot" style={{ background: selfPlayer.color }} />
              {getFactionName(selfPlayer.faction)}
            </>
          ) : (
            '正在分配队伍'
          )}
        </Typography.Text>
      </div>
    );
  }

  if (serverState.match.status === 'ended') {
    return (
      <div className="player-status-card">
        <Typography.Text className="eyebrow">Game Over</Typography.Text>
        <strong>比赛已结束</strong>
      </div>
    );
  }

  return (
    <div className="player-status-card">
      <Typography.Text className="eyebrow">Standby</Typography.Text>
      <strong>等待 NPC 开始</strong>
      {selfPlayer ? (
        <Typography.Text>
          <span className="color-dot" style={{ background: selfPlayer.color }} />
          {getFactionName(selfPlayer.faction)}
        </Typography.Text>
      ) : null}
      <Button size="small" onClick={onChangeTeam}>
        调整队伍
      </Button>
    </div>
  );
}

function PlayerCameraPanel() {
  const selfId = useGameStore((state) => state.selfId);
  const cameraSettings = useGameStore((state) => state.cameraSettings);
  const setCameraSettings = useGameStore((state) => state.setCameraSettings);

  if (!selfId) return null;

  return (
    <div className="player-camera-panel">
      <Typography.Text className="eyebrow">View</Typography.Text>
      <label>
        <span>高度</span>
        <Slider
          min={8}
          max={24}
          step={0.5}
          value={cameraSettings.height}
          onChange={(value) => setCameraSettings({ height: value })}
        />
      </label>
      <label>
        <span>距离</span>
        <Slider
          min={3}
          max={16}
          step={0.5}
          value={cameraSettings.distance}
          onChange={(value) => setCameraSettings({ distance: value })}
        />
      </label>
      <label>
        <span>抖动</span>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={cameraSettings.shake}
          onChange={(value) => setCameraSettings({ shake: value })}
        />
      </label>
    </div>
  );
}

function MovePad() {
  const sendMove = useGameStore((state) => state.sendMove);
  const controls: Array<{ direction: Direction; label: string; icon: JSX.Element; className: string }> = [
    { direction: 'up', label: '上', icon: <ArrowUp size={19} />, className: 'dpad-up' },
    { direction: 'left', label: '左', icon: <ArrowLeft size={19} />, className: 'dpad-left' },
    { direction: 'down', label: '下', icon: <ArrowDown size={19} />, className: 'dpad-down' },
    { direction: 'right', label: '右', icon: <ArrowRight size={19} />, className: 'dpad-right' },
  ];

  const buttonFor = (direction: Direction) => {
    const control = controls.find((item) => item.direction === direction);
    if (!control) return null;

    return (
      <Tooltip title={control.label} key={control.direction}>
        <Button
          className={control.className}
          icon={control.icon}
          aria-label={control.label}
          onClick={() => sendMove(control.direction)}
        />
      </Tooltip>
    );
  };

  return (
    <div className="touch-dpad dpad" aria-label="备用方向键">
      {buttonFor('up')}
      <div>
        {buttonFor('left')}
        {buttonFor('down')}
        {buttonFor('right')}
      </div>
    </div>
  );
}

function getFactionName(factionId: FactionId) {
  return factions.find((faction) => faction.id === factionId)?.name ?? factionId;
}

function mapConfigFromValues(width: number, height: number, boxCount: number): WorldConfig {
  return {
    width: Math.round(width),
    height: Math.round(height),
    boxCount: Math.round(boxCount),
  };
}

export function UIOverlay() {
  const [leaderOpen, setLeaderOpen] = useState(false);
  const [teamSetupOpen, setTeamSetupOpen] = useState(false);
  const [duration, setDuration] = useState(45);
  const [mapWidth, setMapWidth] = useState(64);
  const [mapHeight, setMapHeight] = useState(64);
  const [boxCount, setBoxCount] = useState(220);
  const isSpectator = window.location.pathname.includes('spectator');
  const connect = useGameStore((state) => state.connect);
  const connected = useGameStore((state) => state.connected);
  const selfId = useGameStore((state) => state.selfId);
  const notice = useGameStore((state) => state.notice);
  const map = useGameStore((state) => state.map);
  const serverState = useGameStore((state) => state.state);
  const adminStart = useGameStore((state) => state.adminStart);
  const adminReset = useGameStore((state) => state.adminReset);
  const selfPlayer = serverState.players.find((player) => player.id === selfId);
  const rows = useMemo(() => leaderboardRows(serverState.scores), [serverState.scores]);
  const maxScore = Math.max(1, ...rows.map((row) => row.score));
  const stats = serverState.stats;
  const mapConfig = mapConfigFromValues(mapWidth, mapHeight, boxCount);
  const matchLocked = serverState.match.status === 'running' || serverState.match.status === 'countdown';
  const balance = useMemo(() => teamBalance(serverState.players), [serverState.players]);

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    if (!map) return;
    setMapWidth(map.width);
    setMapHeight(map.height);
    setBoxCount(stats.boxCount);
  }, [map?.height, map?.width, stats.boxCount]);

  if (!isSpectator) {
    return (
      <>
        <PlayerScoreStrip scores={serverState.scores} />
        <PlayerMatchOverlay onChangeTeam={() => setTeamSetupOpen(true)} />
        <PlayerCameraPanel />
        {selfId && serverState.match.status === 'running' ? <MovePad /> : null}
        <TeamSetup open={!selfId || teamSetupOpen} force={!selfId} onClose={() => setTeamSetupOpen(false)} />
      </>
    );
  }

  return (
    <div className="ui-overlay">
      <header className="top-hud">
        <div className="brand-block">
          <Typography.Text className="brand-kicker">Open Atom PU Activity</Typography.Text>
          <Typography.Title level={1}>50 人实时 3D 推箱子阵营战</Typography.Title>
        </div>
        <Space wrap>
          <Tag color={connected ? 'green' : 'red'}>{connected ? '服务器已连接' : '未连接'}</Tag>
          <Tag color={serverState.match.status === 'running' ? 'cyan' : 'purple'}>{statusText[serverState.match.status]}</Tag>
          <Tag color="gold">投屏上帝视角</Tag>
          <Button icon={<Trophy size={15} />} onClick={() => setLeaderOpen(true)}>
            排行榜
          </Button>
        </Space>
      </header>

      <aside className="control-panel">
        <div className="panel-section">
          <Typography.Text className="eyebrow">God View / Admin</Typography.Text>
          <Typography.Title level={2}>NPC 后台控制</Typography.Title>
          <Typography.Paragraph>
            所有玩家在同一张地图实时同步。后台开始后，四个阵营在限定时间内抢推同色箱子进基地。
          </Typography.Paragraph>
          <div className="admin-config-grid">
            <label>
              <Typography.Text>时长</Typography.Text>
              <InputNumber
                min={1}
                max={90}
                precision={0}
                value={duration}
                disabled={matchLocked}
                onChange={(value) => setDuration(Number(value ?? 45))}
              />
              <Typography.Text className="duration-unit">分钟</Typography.Text>
            </label>
            <label>
              <Typography.Text>宽</Typography.Text>
              <InputNumber
                min={24}
                max={96}
                precision={0}
                value={mapWidth}
                disabled={matchLocked}
                onChange={(value) => setMapWidth(Number(value ?? 64))}
              />
            </label>
            <label>
              <Typography.Text>高</Typography.Text>
              <InputNumber
                min={24}
                max={96}
                precision={0}
                value={mapHeight}
                disabled={matchLocked}
                onChange={(value) => setMapHeight(Number(value ?? 64))}
              />
            </label>
            <label>
              <Typography.Text>箱子</Typography.Text>
              <InputNumber
                min={40}
                max={500}
                precision={0}
                value={boxCount}
                disabled={matchLocked}
                onChange={(value) => setBoxCount(Number(value ?? 220))}
              />
            </label>
          </div>
          <Space wrap>
            <Button
              type="primary"
              icon={<Play size={16} />}
              onClick={() => adminStart(duration * 60, mapConfig)}
              disabled={!connected || matchLocked || !balance.balanced}
            >
              NPC 开始
            </Button>
            <Button danger icon={<RotateCcw size={16} />} onClick={() => adminReset(mapConfig)}>
              重置战场
            </Button>
          </Space>
        </div>

        <div className="metric-grid">
          <div className="metric-tile">
            <Typography.Text>剩余时间</Typography.Text>
            <strong>{formatDuration(serverState.match.remainingSeconds)}</strong>
            <Progress
              percent={Math.round((serverState.match.remainingSeconds / serverState.match.durationSeconds) * 100)}
              showInfo={false}
              status={serverState.match.remainingSeconds < 180 ? 'exception' : 'active'}
            />
          </div>
          <div className="metric-tile">
            <Typography.Text>在线人数</Typography.Text>
            <strong>{stats.onlinePlayers}/{stats.playerLimit}</strong>
            <Progress
              percent={Math.round((stats.onlinePlayers / stats.playerLimit) * 100)}
              showInfo={false}
              strokeColor="#22c55e"
            />
          </div>
        </div>

        <div className="panel-section team-balance-panel">
          <div className="panel-heading compact">
            <div>
              <Typography.Text className="eyebrow">Team Allocation</Typography.Text>
              <Typography.Title level={3}>队伍分配</Typography.Title>
            </div>
            <Tag color={balance.balanced ? 'green' : 'orange'}>{balance.balanced ? '均衡可开始' : '需要调整'}</Tag>
          </div>
          <TeamRosterGrid rosters={balance.rosters} compact />
          {!balance.balanced ? (
            <Alert className="order-alert" type="warning" showIcon message="队伍人数差距需要控制在 1 人以内。" />
          ) : null}
        </div>

        <div className="panel-section clue-panel">
          <Typography.Text className="eyebrow">Battlefield</Typography.Text>
          <div className="order-chain">
            {map ? `${map.width} x ${map.height} 巨型矩阵 · ${serverState.boxes.length} 个箱子` : '等待地图加载'}
          </div>
          {notice ? <Alert className="order-alert" type="info" showIcon message={notice} /> : null}
          <div className="score-list">
            {rows.map((row) => (
              <div className="score-row" key={row.faction}>
                <span>
                  <span className="color-dot" style={{ background: row.color }} />
                  {row.name}
                </span>
                <Progress percent={Math.round((row.score / maxScore) * 100)} showInfo={false} strokeColor={row.color} />
                <strong>{row.score}</strong>
              </div>
            ))}
          </div>
          <Typography.Text type="secondary">
            规则：同色箱子进同色基地 +1，错色进基地不加分，没有步数限制。
          </Typography.Text>
        </div>

        <div className="target-progress">
          {factions.map((faction) => (
            <Tag key={faction.id} color={selfPlayer?.faction === faction.id ? 'cyan' : 'default'}>
              <span className="color-dot" style={{ background: faction.color }} />
              {faction.name}
            </Tag>
          ))}
        </div>
      </aside>

      <Drawer title="实时排行榜" open={leaderOpen} onClose={() => setLeaderOpen(false)} width={700}>
        <Leaderboard />
      </Drawer>

    </div>
  );
}
