import { Button, Form, Input, Modal, Tag, Typography } from 'antd';
import { Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { factions, useGameStore } from '../store/useGameStore';
import type { FactionId } from '../types/game';

interface TeamSetupProps {
  open: boolean;
  force?: boolean;
  onClose: () => void;
}

interface JoinFormValues {
  name: string;
}

export function TeamSetup({ open, force = false, onClose }: TeamSetupProps) {
  const [form] = Form.useForm<JoinFormValues>();
  const [selectedFaction, setSelectedFaction] = useState<FactionId>('red');
  const join = useGameStore((state) => state.join);
  const players = useGameStore((state) => state.state.players);
  const playerName = useGameStore((state) => state.playerName);
  const selectedStoredFaction = useGameStore((state) => state.selectedFaction);
  const rosters = useMemo(
    () =>
      factions.map((faction) => ({
        ...faction,
        members: players.filter((player) => player.assigned && player.faction === faction.id),
      })),
    [players],
  );

  useEffect(() => {
    if (!open) return;
    setSelectedFaction(selectedStoredFaction);
    form.setFieldsValue({ name: playerName });
  }, [form, open, playerName, selectedStoredFaction]);

  const handleFinish = (values: JoinFormValues) => {
    join(values.name, selectedFaction);
    onClose();
    window.requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      window.focus();
    });
  };

  return (
    <Modal
      centered
      closable={!force}
      maskClosable={!force}
      open={open}
      title={
        <span className="modal-title">
          <Users size={18} />
          加入实时战场
        </span>
      }
      footer={null}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary" className="team-setup-copy">
        填写昵称并选择队伍，NPC 会在队伍人数均衡后开始比赛。
      </Typography.Paragraph>
      <Form<JoinFormValues> layout="vertical" form={form} onFinish={handleFinish}>
        <Form.Item label="玩家昵称" name="name" rules={[{ required: true, message: '请输入玩家昵称' }]}>
          <Input placeholder="例如：张三" maxLength={20} />
        </Form.Item>
        <div className="team-picker-grid" role="radiogroup" aria-label="队伍">
          {rosters.map((roster) => (
            <button
              type="button"
              role="radio"
              aria-checked={selectedFaction === roster.id}
              className={selectedFaction === roster.id ? 'team-pick-card selected' : 'team-pick-card'}
              key={roster.id}
              style={{ borderColor: roster.color }}
              onClick={() => setSelectedFaction(roster.id)}
            >
              <span className="team-pick-title">
                <span>
                  <span className="color-dot" style={{ background: roster.color }} />
                  {roster.name}
                </span>
                <Tag color="default">{roster.members.length}</Tag>
              </span>
              <span className="team-member-list">
                {roster.members.length > 0 ? roster.members.map((player) => player.name).join('、') : '暂无成员'}
              </span>
            </button>
          ))}
        </div>
        <Button type="primary" htmlType="submit" block size="large">
          加入 {factions.find((faction) => faction.id === selectedFaction)?.name}
        </Button>
      </Form>
    </Modal>
  );
}
