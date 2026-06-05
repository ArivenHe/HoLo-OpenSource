import { App as AntApp, ConfigProvider, theme } from 'antd';
import { GameCanvas } from './components/GameCanvas';
import { UIOverlay } from './components/UIOverlay';

export default function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#06b6d4',
          colorSuccess: '#22c55e',
          colorWarning: '#f59e0b',
          colorError: '#f43f5e',
          borderRadius: 8,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Modal: {
            contentBg: 'rgba(3, 7, 18, 0.96)',
            headerBg: 'transparent',
          },
          Drawer: {
            colorBgElevated: 'rgba(3, 7, 18, 0.98)',
          },
        },
      }}
    >
      <AntApp>
        <main className="app-shell">
          <GameCanvas />
          <UIOverlay />
        </main>
      </AntApp>
    </ConfigProvider>
  );
}
