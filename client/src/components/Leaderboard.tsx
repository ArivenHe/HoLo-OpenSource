import { Button, Empty, Progress, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { RotateCcw, Trophy } from 'lucide-react';
import { factions, formatDuration, leaderboardRows, useGameStore } from '../store/useGameStore';
import type { LeaderboardRow } from '../types/game';

export function Leaderboard() {
  const scores = useGameStore((state) => state.state.scores);
  const match = useGameStore((state) => state.state.match);
  const players = useGameStore((state) => state.state.players);
  const adminReset = useGameStore((state) => state.adminReset);
  const entries = leaderboardRows(scores);
  const maxScore = Math.max(1, ...entries.map((entry) => entry.score));

  const columns: ColumnsType<LeaderboardRow & { rank: number; online: number }> = [
    {
      title: '排名',
      dataIndex: 'rank',
      width: 72,
      render: (rank: number) => <Tag color={rank === 1 ? 'gold' : 'cyan'}>#{rank}</Tag>,
    },
    {
      title: '阵营',
      dataIndex: 'name',
      render: (name: string, record) => (
        <Space direction="vertical" size={0} className="faction-cell">
          <Typography.Text strong>
            <span className="color-dot" style={{ background: record.color }} />
            {name}
          </Typography.Text>
          <Typography.Text type="secondary">{record.online} 人在线</Typography.Text>
        </Space>
      ),
    },
    {
      title: '得分',
      dataIndex: 'score',
      width: 220,
      render: (score: number, record) => (
        <Space direction="vertical" size={4} className="score-bar-cell">
          <Typography.Text strong>{score}</Typography.Text>
          <Progress percent={Math.round((score / maxScore) * 100)} showInfo={false} strokeColor={record.color} />
        </Space>
      ),
    },
  ];

  const rows = entries.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    online: players.filter((player) => player.assigned && player.faction === entry.faction).length,
  }));

  return (
    <div className="leaderboard-panel">
      <div className="panel-heading">
        <div>
          <Typography.Text className="eyebrow">Faction Ranking</Typography.Text>
          <Typography.Title level={3}>实时阵营排行榜</Typography.Title>
          <Typography.Text type="secondary">剩余 {formatDuration(match.remainingSeconds)}</Typography.Text>
        </div>
        <Button danger size="small" icon={<RotateCcw size={14} />} onClick={() => adminReset()}>
          后台重置
        </Button>
      </div>
      {rows.length > 0 ? (
        <Table rowKey="faction" size="small" pagination={false} columns={columns} dataSource={rows} />
      ) : (
        <Empty
          className="leaderboard-empty"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              <Trophy size={16} />
              等待比赛开始
            </span>
          }
        />
      )}
    </div>
  );
}
